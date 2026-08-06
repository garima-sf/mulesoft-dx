// pom-edit.mjs — deterministic pom.xml + mule-artifact.json + flow-XML edits.
//
// Regex-based rewrite — no XML parser dependency — so edits are surgical and
// preserve the original file's whitespace/layout.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

function _read(p) { return readFileSync(p, 'utf8'); }
function _write(p, content) { writeFileSync(p, content); }

// ---------- POM element replace / insert ----------

function _escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Replace body of `<tag>...</tag>` inline (whole document, all occurrences).
 * @param {string} text Full document text.
 * @param {string} tag Element local name.
 * @param {string} newValue Replacement body.
 * @returns {{text:string, changed:boolean}}
 */
export function replaceElement(text, tag, newValue) {
  const pat = new RegExp(`(<${_escapeRegExp(tag)}>)([^<]*)(</${_escapeRegExp(tag)}>)`, 'g');
  let changed = false;
  const out = text.replace(pat, (m, open, body, close) => {
    if (body === newValue) return m;
    changed = true;
    return `${open}${newValue}${close}`;
  });
  return { text: out, changed };
}

/**
 * Insert `<tag>value</tag>` into `<properties>...</properties>` if absent.
 * Best-effort indentation preservation.
 * @param {string} text
 * @param {string} tag
 * @param {string} value
 * @returns {{text:string, inserted:boolean}}
 */
export function insertProperty(text, tag, value) {
  // dotall via [\s\S] since JS regex has no DOTALL flag pre-ES2018 in the
  // portable-safe subset.
  const propRe = /(<properties>)([\s\S]*?)(<\/properties>)/;
  const m = text.match(propRe);
  if (!m) return { text, inserted: false };
  const body = m[2];
  const tagRe = new RegExp(`<${_escapeRegExp(tag)}>`);
  if (tagRe.test(body)) return { text, inserted: false };
  const indentMatch = body.match(/\n([ \t]+)</);
  const indent = indentMatch ? indentMatch[1] : '    ';
  const trailingIndent = indent.length >= 4 ? indent.slice(0, indent.length - 4) : '';
  const newBody = `${body.replace(/\s+$/, '')}\n${indent}<${tag}>${value}</${tag}>\n${trailingIndent}`;
  const start = m.index + m[1].length;
  const end = start + body.length;
  const newText = text.slice(0, start) + newBody + text.slice(end);
  return { text: newText, inserted: true };
}

// ---------- Runtime + Java bump (edit_pom + edit_mule_artifact) ----------

/**
 * @param {string} pomPath
 * @param {string} targetMule
 * @param {string} targetJava
 * @param {string|null} muleMavenPlugin Resolved latest MMP version (Step 11a),
 *   or null/empty to leave <mule.maven.plugin.version> untouched.
 * @param {Array<object>} log Mutated with per-file status entries.
 */
export function editPomRuntime(pomPath, targetMule, targetJava, muleMavenPlugin, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return;
  }
  let text = _read(pomPath);
  const original = text;
  const changes = [];

  // Java-related tags: bumped in place only if present, never inserted when
  // absent (a POM that doesn't declare them shouldn't sprout new ones).
  const tags = [
    ['javaVersion', targetJava],
    ['maven.compiler.source', targetJava],
    ['maven.compiler.target', targetJava],
    ['maven.compiler.release', targetJava],
    ['java.version', targetJava],
    ['jdk.version', targetJava],
  ];
  for (const [tag, val] of tags) {
    const r = replaceElement(text, tag, val);
    if (r.changed) {
      text = r.text;
      changes.push(`${tag}=${val}`);
    }
  }

  // <app.runtime> is the one runtime property we always want present — bump it
  // if declared, otherwise insert it into <properties>.
  const rtReplace = replaceElement(text, 'app.runtime', targetMule);
  if (rtReplace.changed) {
    text = rtReplace.text;
    changes.push(`app.runtime=${targetMule}`);
  } else {
    const rtInsert = insertProperty(text, 'app.runtime', targetMule);
    if (rtInsert.inserted) {
      text = rtInsert.text;
      changes.push(`app.runtime=${targetMule} (inserted)`);
    }
  }

  const mmp = muleMavenPlugin;
  if (mmp) {
    // Prefer the property form: bump <mule.maven.plugin.version> if declared.
    const rr = replaceElement(text, 'mule.maven.plugin.version', mmp);
    if (rr.changed) {
      text = rr.text;
      changes.push(`mule.maven.plugin.version=${mmp}`);
    } else {
      // No such property. If the plugin pins its version as a LITERAL inside the
      // <plugin> block, edit that in place (same writer the Step 3c baseline uses);
      // otherwise insert the property.
      const lit = _setPluginVersionInText(text, {
        groupId: 'org.mule.tools.maven',
        artifactId: 'mule-maven-plugin',
        version: mmp,
      });
      if (lit.changed) {
        text = lit.text;
        changes.push(`mule-maven-plugin <version>=${mmp} (literal)`);
      } else {
        const ins = insertProperty(text, 'mule.maven.plugin.version', mmp);
        if (ins.inserted) {
          text = ins.text;
          changes.push(`mule.maven.plugin.version=${mmp} (inserted)`);
        }
      }
    }
  } else {
    log.push({
      file: pomPath,
      status: 'warn',
      reason: 'no mule-maven-plugin version supplied (Step 11a) — leaving <mule.maven.plugin.version> unchanged',
    });
  }

  if (text !== original) {
    _write(pomPath, text);
    log.push({ file: pomPath, status: 'applied', changes });
  } else {
    log.push({ file: pomPath, status: 'no-op', changes: [] });
  }
}

/**
 * Truncate a Mule runtime version to its `x.y.0` feature line for
 * `minMuleVersion`, which declares the app's required features by the MINOR
 * line, not the patch (4.9.19 → 4.9.0). This matches how ACB and Studio write
 * the manifest, and the Introspection Service depends on the minor-line form.
 * `<app.runtime>` keeps the full patch. Returns the input unchanged if it
 * doesn't parse as `major.minor.patch...`.
 * @param {string} v e.g. "4.9.19"
 * @returns {string} e.g. "4.9.0"
 */
function _featureLineVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)\./);
  return m ? `${m[1]}.${m[2]}.0` : v;
}

/**
 * @param {string} artifactPath
 * @param {string} targetMule
 * @param {string} targetJava
 * @param {Array<object>} log
 */
export function editMuleArtifact(artifactPath, targetMule, targetJava, log) {
  if (!existsSync(artifactPath)) {
    log.push({ file: artifactPath, status: 'error', reason: 'mule-artifact.json not found' });
    return;
  }
  const artifact = JSON.parse(_read(artifactPath));
  const changes = [];

  // minMuleVersion is the x.y.0 feature line (see _featureLineVersion), NOT the
  // full patch — this is the platform-correct form (ACB/Studio write it this way
  // and the Introspection Service depends on it). <app.runtime> (editPomRuntime)
  // keeps the full patch. The one hazard of the floor is that MUnit's embedded
  // test runtime otherwise defaults to minMuleVersion, so a 4.9.0 floor would
  // boot the 4.9.0 runtime whose mule-sdk-api enum lacks newer JavaVersion
  // constants (e.g. JAVA_25) and fail connector extension-model parsing; that is
  // handled separately by pinning <runtimeVersion>${app.runtime}</runtimeVersion>
  // in the munit-maven-plugin config (see editMunitVersion).
  const minMule = _featureLineVersion(targetMule);
  if (artifact.minMuleVersion !== minMule) {
    artifact.minMuleVersion = minMule;
    changes.push(`minMuleVersion=${minMule}`);
  }

  // Always ensure javaSpecificationVersions is present and includes the target
  // Java, inserting the array if the manifest omits it entirely.
  const existing = artifact.javaSpecificationVersions;
  if (!existing || (Array.isArray(existing) && existing.length === 0)) {
    artifact.javaSpecificationVersions = [targetJava];
    changes.push(`javaSpecificationVersions=[${targetJava}]`);
  } else if (!existing.includes(targetJava)) {
    artifact.javaSpecificationVersions = [...new Set([...existing, targetJava])];
    changes.push(`javaSpecificationVersions+=${targetJava}`);
  }

  if (changes.length > 0) {
    _write(artifactPath, JSON.stringify(artifact, null, 2) + '\n');
    log.push({ file: artifactPath, status: 'applied', changes });
  } else {
    log.push({ file: artifactPath, status: 'no-op', changes: [] });
  }
}

// ---------- Connector pin ----------

// Minimal <element><child>…</child></element> plucker; regex-based, relies on
// well-formed Maven pom.xml (elements only, no namespaces on Maven POM tags).
function _findDependencyBlocks(text) {
  const blocks = [];
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  const matches = text.matchAll(depRe);
  for (const m of matches) {
    blocks.push({ start: m.index, end: m.index + m[0].length, inner: m[1], full: m[0] });
  }
  return blocks;
}

function _pluckChild(inner, tag) {
  const m = inner.match(new RegExp(`<${_escapeRegExp(tag)}>([^<]*)</${_escapeRegExp(tag)}>`));
  return m ? m[1].trim() : '';
}

/**
 * Bump connector `<version>` in pom.xml for matching groupId+artifactId.
 * Handles inline `<version>x.y.z</version>` and `${prop}` references.
 * @param {string} pomPath
 * @param {{groupId:string, assetId:string, version:string}} gav
 * @param {Array<object>} log
 */
export function editPomDependency(pomPath, gav, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return;
  }
  let text;
  try {
    text = _read(pomPath);
  } catch (e) {
    log.push({ file: pomPath, status: 'error', reason: `read failed: ${e.message}` });
    return;
  }

  const { groupId, assetId, version: newVersion } = gav;
  const blocks = _findDependencyBlocks(text);

  let matched = null;
  for (const b of blocks) {
    if (_pluckChild(b.inner, 'groupId') === groupId && _pluckChild(b.inner, 'artifactId') === assetId) {
      matched = b;
      break;
    }
  }

  if (!matched) {
    log.push({ file: pomPath, status: 'error', reason: `dependency ${groupId}:${assetId} not found` });
    return;
  }

  const vMatch = matched.inner.match(/<version>([^<]*)<\/version>/);
  if (!vMatch) {
    log.push({
      file: pomPath,
      status: 'error',
      reason: `${groupId}:${assetId} missing <version> element`,
    });
    return;
  }
  const vText = vMatch[1].trim();

  // Property reference like ${s3.connector.version}
  const propRefMatch = vText.match(/^\$\{([^}]+)\}$/);
  if (propRefMatch) {
    const propName = propRefMatch[1];
    // Find the property in <properties>
    const propsMatch = text.match(/<properties>([\s\S]*?)<\/properties>/);
    if (!propsMatch) {
      log.push({
        file: pomPath,
        status: 'error',
        reason: `<version> references property \${${propName}} but <properties> block not found`,
      });
      return;
    }
    const propTagRe = new RegExp(`<${_escapeRegExp(propName)}>([^<]*)</${_escapeRegExp(propName)}>`);
    const propBodyMatch = propsMatch[1].match(propTagRe);
    if (!propBodyMatch) {
      log.push({
        file: pomPath,
        status: 'error',
        reason: `property ${propName} not found in <properties>`,
      });
      return;
    }
    const oldVersion = propBodyMatch[1].trim();
    if (oldVersion === newVersion) {
      log.push({ file: pomPath, status: 'no-op', from: oldVersion, to: newVersion });
      return;
    }
    // Replace inside <properties>
    const propsStart = propsMatch.index + '<properties>'.length;
    const propsBody = propsMatch[1];
    const newPropsBody = propsBody.replace(
      propTagRe,
      () => `<${propName}>${newVersion}</${propName}>`,
    );
    const newText = text.slice(0, propsStart) + newPropsBody + text.slice(propsStart + propsBody.length);
    _write(pomPath, newText);
    log.push({ file: pomPath, status: 'ok', from: oldVersion, to: newVersion });
    return;
  }

  // Inline version
  const oldVersion = vText;
  if (oldVersion === newVersion) {
    log.push({ file: pomPath, status: 'no-op', from: oldVersion, to: newVersion });
    return;
  }
  const innerNew = matched.inner.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
  const newFull = `<dependency>${innerNew}</dependency>`;
  const newText = text.slice(0, matched.start) + newFull + text.slice(matched.end);
  _write(pomPath, newText);
  log.push({ file: pomPath, status: 'ok', from: oldVersion, to: newVersion });
}

// ---------- Plugin version pin ----------

function _findPluginBlocks(text) {
  const blocks = [];
  const re = /<plugin>([\s\S]*?)<\/plugin>/g;
  for (const m of text.matchAll(re)) {
    blocks.push({ start: m.index, end: m.index + m[0].length, inner: m[1], full: m[0] });
  }
  return blocks;
}

/**
 * Text-level transform: set the LITERAL `<version>` of every `<plugin>` block
 * matching artifactId (+ groupId when declared) to `newVersion`. Rewrites ONLY
 * the version inside matched plugin blocks — never a bare `<version>` elsewhere
 * — so POMs with multiple plugin blocks (build/plugins + pluginManagement) stay
 * safe. A `${property}` version is left untouched (that is the -D path).
 * @param {string} text
 * @param {{groupId?:string, artifactId:string, version:string}} target
 * @returns {{text:string, changed:boolean, matched:boolean, results:Array<object>}}
 */
function _setPluginVersionInText(text, target) {
  const { groupId, artifactId, version: newVersion } = target;
  const blocks = _findPluginBlocks(text);
  const matches = blocks.filter((b) => {
    if (_pluckChild(b.inner, 'artifactId') !== artifactId) return false;
    const gid = _pluckChild(b.inner, 'groupId');
    return !groupId || !gid || gid === groupId;
  });

  let changed = false;
  const results = [];
  // Rebuild the document back-to-front so earlier edits don't shift later offsets.
  for (const b of [...matches].sort((a, c) => c.start - a.start)) {
    const vMatch = b.inner.match(/<version>([^<]*)<\/version>/);
    if (!vMatch) {
      results.push({ status: 'skip', reason: 'no <version> in plugin block' });
      continue;
    }
    const vText = vMatch[1].trim();
    if (/^\$\{[^}]+\}$/.test(vText)) {
      results.push({ status: 'skip', from: vText, reason: 'version is a ${property} — override with -D instead' });
      continue;
    }
    if (vText === newVersion) {
      results.push({ status: 'no-op', from: vText, to: newVersion });
      continue;
    }
    const innerNew = b.inner.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
    text = text.slice(0, b.start) + `<plugin>${innerNew}</plugin>` + text.slice(b.end);
    changed = true;
    results.push({ status: 'ok', from: vText, to: newVersion });
  }
  return { text, changed, matched: matches.length > 0, results };
}

/**
 * Text-level transform: set the LITERAL `<version>` of every `<dependency>`
 * block matching artifactId (+ groupId when declared) to `newVersion`. Same
 * contract as `_setPluginVersionInText` but for dependency blocks — rewrites
 * back-to-front, skips `${property}` versions (those ride a shared property that
 * is bumped separately), and never touches a bare `<version>` elsewhere.
 * @param {string} text
 * @param {{groupId?:string, artifactId:string, version:string}} target
 * @returns {{text:string, changed:boolean, matched:boolean, results:Array<object>}}
 */
function _setDependencyVersionInText(text, target) {
  const { groupId, artifactId, version: newVersion } = target;
  const blocks = _findDependencyBlocks(text);
  const matches = blocks.filter((b) => {
    if (_pluckChild(b.inner, 'artifactId') !== artifactId) return false;
    const gid = _pluckChild(b.inner, 'groupId');
    return !groupId || !gid || gid === groupId;
  });

  let changed = false;
  const results = [];
  for (const b of [...matches].sort((a, c) => c.start - a.start)) {
    const vMatch = b.inner.match(/<version>([^<]*)<\/version>/);
    if (!vMatch) {
      results.push({ status: 'skip', reason: 'no <version> in dependency block' });
      continue;
    }
    const vText = vMatch[1].trim();
    if (/^\$\{[^}]+\}$/.test(vText)) {
      results.push({ status: 'skip', from: vText, reason: 'version is a ${property} — bumped via the property' });
      continue;
    }
    if (vText === newVersion) {
      results.push({ status: 'no-op', from: vText, to: newVersion });
      continue;
    }
    const innerNew = b.inner.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
    text = text.slice(0, b.start) + `<dependency>${innerNew}</dependency>` + text.slice(b.end);
    changed = true;
    results.push({ status: 'ok', from: vText, to: newVersion });
  }
  return { text, changed, matched: matches.length > 0, results };
}

/**
 * Bump every MUnit version site in pom.xml to `version`, deterministically.
 *
 * MUnit spreads across up to three shapes, and a real pom can mix them (a
 * `<munit.version>` property that some artifacts reference and others ignore in
 * favour of a hardcoded literal — seen in the wild). This bumps all of them in
 * one pass so no site is left stale:
 *   - the `<munit.version>` property (if declared),
 *   - the `munit-maven-plugin` `<plugin>` block's literal version,
 *   - the `munit-runner` / `munit-tools` `<dependency>` blocks' literal versions.
 * Every writer skips `${property}` versions (those already ride the property
 * bumped above), so a property-driven pom is a single clean edit and a
 * literal-driven pom rewrites each element. All artifacts are under groupId
 * `com.mulesoft.munit`.
 *
 * @param {string} pomPath
 * @param {string|null} version Latest MUnit resolved live (Step 11a), or null/empty to skip.
 * @param {Array<object>} log Mutated with a per-file status entry.
 */
export function editMunitVersion(pomPath, version, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return;
  }
  if (!version) {
    log.push({ file: pomPath, status: 'warn', reason: 'no MUnit version supplied (Step 11a) — leaving MUnit versions unchanged' });
    return;
  }
  let text = _read(pomPath);
  const original = text;
  const changes = [];
  const GROUP = 'com.mulesoft.munit';

  const prop = replaceElement(text, 'munit.version', version);
  if (prop.changed) {
    text = prop.text;
    changes.push(`munit.version=${version}`);
  }

  const plug = _setPluginVersionInText(text, { groupId: GROUP, artifactId: 'munit-maven-plugin', version });
  if (plug.changed) {
    text = plug.text;
    changes.push(`munit-maven-plugin <version>=${version} (literal)`);
  }

  for (const artifactId of ['munit-runner', 'munit-tools']) {
    const dep = _setDependencyVersionInText(text, { groupId: GROUP, artifactId, version });
    if (dep.changed) {
      text = dep.text;
      changes.push(`${artifactId} <version>=${version} (literal)`);
    }
  }

  if (text !== original) {
    _write(pomPath, text);
    log.push({ file: pomPath, status: 'applied', changes });
  } else {
    log.push({ file: pomPath, status: 'no-op', changes: [] });
  }
}

/**
 * Pin the munit-maven-plugin's embedded test runtime to `<app.runtime>` by
 * inserting `<runtimeVersion>${app.runtime}</runtimeVersion>` into its
 * `<configuration>` block.
 *
 * Why this is required: MUnit selects its embedded runtime from
 * `<runtimeVersion>` when set, otherwise it falls back to the app's
 * `minMuleVersion` from mule-artifact.json. Since we (correctly) write
 * `minMuleVersion` as the `x.y.0` feature line, that fallback would boot the
 * `x.y.0` runtime — whose bundled `mule-sdk-api` `JavaVersion` enum can lack
 * newer constants (e.g. JAVA_25). Connectors compiled against the target
 * patch's `@SupportedJavaVersions` then throw `EnumConstantNotPresentException`
 * during extension-model parsing and MUnit never runs. Pinning `runtimeVersion`
 * to `${app.runtime}` (the full target patch, set by editPomRuntime) forces the
 * test runtime to match the deploy runtime, independent of the feature-line
 * floor.
 *
 * Uses the `${app.runtime}` property (not a literal) so the test runtime tracks
 * the same single source of truth the deploy profiles use. Insert-if-absent:
 * an existing `<runtimeVersion>` (a team's deliberate pin) is left untouched.
 * No-op when the munit-maven-plugin block is absent.
 *
 * @param {string} pomPath
 * @param {Array<object>} log Mutated with a per-file status entry.
 */
export function editMunitRuntimeVersion(pomPath, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return;
  }
  let text = _read(pomPath);
  const RUNTIME_REF = '${app.runtime}';

  const blocks = _findPluginBlocks(text);
  const block = blocks.find((b) => _pluckChild(b.inner, 'artifactId') === 'munit-maven-plugin');
  if (!block) {
    log.push({ file: pomPath, status: 'no-op', reason: 'munit-maven-plugin block not found' });
    return;
  }

  // Already pinned — never clobber a deliberate value.
  if (/<runtimeVersion>/.test(block.inner)) {
    log.push({ file: pomPath, status: 'no-op', reason: 'runtimeVersion already present' });
    return;
  }

  // Match the block's indentation from its <configuration> (or <version>) tag.
  const indentMatch = block.inner.match(/\n([ \t]+)<(?:configuration|version)>/);
  const cfgIndent = indentMatch ? indentMatch[1] : '\t\t\t\t';
  const childIndent = cfgIndent + (cfgIndent.includes('\t') ? '\t' : '  ');
  const rtEl = `<runtimeVersion>${RUNTIME_REF}</runtimeVersion>`;

  let innerNew;
  const cfgOpen = block.inner.match(/<configuration>/);
  if (cfgOpen) {
    // Insert as the first child of the existing <configuration>.
    innerNew = block.inner.replace(
      /<configuration>/,
      `<configuration>\n${childIndent}${rtEl}`
    );
  } else {
    // No <configuration> — add one just before the plugin block closes.
    innerNew = block.inner.replace(
      /([ \t]*)$/,
      `${cfgIndent}<configuration>\n${childIndent}${rtEl}\n${cfgIndent}</configuration>\n$1`
    );
  }

  const newText = text.slice(0, block.start) + `<plugin>${innerNew}</plugin>` + text.slice(block.end);
  if (newText !== text) {
    _write(pomPath, newText);
    log.push({ file: pomPath, status: 'applied', changes: [`munit-maven-plugin <runtimeVersion>=${RUNTIME_REF} (inserted)`] });
  } else {
    log.push({ file: pomPath, status: 'no-op', changes: [] });
  }
}

/**
 * Set the `<version>` of a specific `<plugin>` (matched by artifactId, and
 * groupId when the block declares one) to `newVersion`, in place.
 *
 * This is the LITERAL-version writer that `-D<prop>` cannot cover: when a POM
 * hardcodes `<version>x.y.z</version>` inside the plugin block (e.g.
 * mule-maven-plugin pinned as a literal), the command-line override is ignored,
 * so the element must be edited. Skips (no-op) when the plugin's version is a
 * `${property}` reference — that is the Case-A path handled on the command line.
 * Whitespace/tabs inside the block are irrelevant — matching is structural.
 *
 * @param {string} pomPath
 * @param {{groupId?:string, artifactId:string, version:string}} target
 * @param {Array<object>} log
 */
export function editPluginVersion(pomPath, target, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return;
  }
  let text;
  try {
    text = _read(pomPath);
  } catch (e) {
    log.push({ file: pomPath, status: 'error', reason: `read failed: ${e.message}` });
    return;
  }

  const r = _setPluginVersionInText(text, target);
  if (!r.matched) {
    const { groupId, artifactId } = target;
    log.push({ file: pomPath, status: 'not-found', reason: `plugin ${groupId ? groupId + ':' : ''}${artifactId} not found` });
    return;
  }
  if (r.changed) _write(pomPath, r.text);
  log.push({ file: pomPath, status: r.changed ? 'ok' : 'no-op', plugin: target.artifactId, results: r.results });
}

/**
 * Rewrite xsi:schemaLocation URLs in flow XMLs for a given connector namespace.
 * @param {string} projectDir
 * @param {string} namespacePrefix
 * @param {object} namespaceMetadata Mode-A JSON from describe_connector.
 * @param {Array<object>} log
 */
export function editFlowXsdUrls(projectDir, namespacePrefix, namespaceMetadata, log) {
  const flowDir = path.join(projectDir, 'src', 'main', 'mule');
  if (!existsSync(flowDir)) {
    log.push({ status: 'warn', reason: `flow directory ${flowDir} not found` });
    return;
  }

  const nsInfo = (namespaceMetadata && namespaceMetadata.namespace) || {};
  const targetNsUrl = `http://www.mulesoft.org/schema/mule/${namespacePrefix}`;
  const newXsdUrl = nsInfo.schemaLocation
    ? nsInfo.schemaLocation
    : `http://www.mulesoft.org/schema/mule/${namespacePrefix}/current/mule-${namespacePrefix}.xsd`;

  let entries;
  try {
    entries = readdirSync(flowDir);
  } catch {
    entries = [];
  }
  const flowFiles = entries.filter((f) => f.endsWith('.xml')).map((f) => path.join(flowDir, f));
  if (flowFiles.length === 0) {
    log.push({ status: 'warn', reason: `no flow XMLs found in ${flowDir}` });
    return;
  }

  const targetNsRe = new RegExp(`^${_escapeRegExp(targetNsUrl)}(/|$)`);

  for (const flowFile of flowFiles) {
    try {
      const content = _read(flowFile);
      const schemaLocMatch = content.match(/xsi:schemaLocation="([^"]*)"/);
      if (!schemaLocMatch) {
        log.push({ file: flowFile, status: 'skip', reason: 'no xsi:schemaLocation attribute found' });
        continue;
      }
      const schemaLocValue = schemaLocMatch[1];
      const tokens = schemaLocValue.split(/\s+/).filter((t) => t.length > 0);

      // Collect only XSD URLs that genuinely change (target namespace whose URL
      // differs from newXsdUrl). Most URLs point at /current/ and don't change.
      const oldXsdUrls = [];
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const xmlnsUrl = tokens[i].trim();
        const xsdUrl = tokens[i + 1].trim();
        if ((xmlnsUrl === targetNsUrl || targetNsRe.test(xmlnsUrl)) && xsdUrl !== newXsdUrl) {
          oldXsdUrls.push(xsdUrl);
        }
      }

      if (oldXsdUrls.length === 0) {
        log.push({
          file: flowFile,
          status: 'skip',
          reason: `namespace ${targetNsUrl} not found or already current in schemaLocation`,
        });
        continue;
      }

      // Surgical in-place replace of just the changed URL token(s) — preserves
      // the original whitespace/layout (no cosmetic reflow of the attribute).
      let newContent = content;
      for (const oldXsd of oldXsdUrls) {
        newContent = newContent.replace(oldXsd, () => newXsdUrl);
      }

      if (newContent !== content) {
        _write(flowFile, newContent);
        log.push({ file: flowFile, status: 'ok', count: oldXsdUrls.length });
      } else {
        log.push({ file: flowFile, status: 'no-op' });
      }
    } catch (e) {
      log.push({ file: flowFile, status: 'error', reason: e.message });
    }
  }
}

// ---------- JAVA_HOME check ----------

/**
 * @param {string} envPath Path to tmp/mule-dev-env.json.
 * @param {string} targetJava
 * @returns {{status:'ok'|'mismatch'|'unknown', current?:string, target?:string, reason?:string, instruction?:string}}
 */
export function checkJavaHome(envPath, targetJava) {
  if (!existsSync(envPath)) {
    return { status: 'unknown', reason: `${envPath} not found — run validate_prerequisites.sh` };
  }
  let env;
  try {
    env = JSON.parse(_read(envPath));
  } catch (e) {
    return { status: 'unknown', reason: `${envPath} not parseable: ${e.message}` };
  }
  const current = String(env.java_version || '');
  if (!current) {
    return { status: 'unknown', reason: 'java_version missing from mule-dev-env.json' };
  }
  if (current.startsWith(`${targetJava}.`) || current === targetJava) {
    return { status: 'ok', current, target: targetJava };
  }
  return {
    status: 'mismatch',
    current,
    target: targetJava,
    instruction:
      `JAVA_HOME points to Java ${current} but the upgrade targets Java ${targetJava}. ` +
      `Point JAVA_HOME at a Java ${targetJava} install (e.g. \`export JAVA_HOME=$(/usr/libexec/java_home -v ${targetJava})\` on macOS) ` +
      'and rerun.',
  };
}
