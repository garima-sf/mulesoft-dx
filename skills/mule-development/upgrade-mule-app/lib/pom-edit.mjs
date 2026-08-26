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
 * Byte ranges of every `<!-- ... -->` comment in the document. Used to keep the
 * regex-based writers from editing commented-out markup (a stale <dependency> or
 * <plugin> a team left disabled must stay a comment, never get "bumped").
 * @param {string} text
 * @returns {Array<[number, number]>} [start, end) pairs, in document order.
 */
function _commentRanges(text) {
  const ranges = [];
  const re = /<!--[\s\S]*?-->/g;
  for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/** True when `index` falls inside any comment range. */
function _inComment(index, ranges) {
  for (const [s, e] of ranges) {
    if (index >= s && index < e) return true;
  }
  return false;
}

/**
 * Map a composite `${a}.${b}...`-style version expression to the per-property
 * values that make it resolve to `targetVersion`. Handles the shapes the read
 * side (`resolveValue`) resolves and that a POM realistically uses to split a
 * version across properties:
 *   - `${major}.${minor}.${patch}` → {major:'1', minor:'8', patch:'1'}
 *   - `1.7.${patch}` (literal + property) → {patch:'1'} (literals must already match)
 *   - `v${x}` / prefixed segments → the property gets the segment minus the literal
 *
 * The mapping is DETERMINISTIC, not a guess: the expression is tokenised into an
 * exact regex whose only capture groups are the `${prop}` refs, then matched
 * against `targetVersion`. A property that appears twice must resolve to the SAME
 * value (back-reference) or the match fails. Returns:
 *   - a `{propName: value}` map when the target maps cleanly, OR
 *   - `null` when it can't be mapped safely (literal mismatch, wrong segment
 *     count, or one property forced to two different values) — the caller then
 *     warns instead of writing a wrong value.
 * @param {string} expr The raw `<version>` text, e.g. "${email.major}.${email.minor}.${email.patch}".
 * @param {string} targetVersion The resolved target, e.g. "1.8.1".
 * @returns {Record<string,string>|null}
 */
export function decomposeComposite(expr, targetVersion) {
  const props = [];
  let pattern = '';
  let i = 0;
  const re = /\$\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(expr)) !== null) {
    // Literal text between the previous ref and this one must match verbatim.
    pattern += _escapeRegExp(expr.slice(i, m.index));
    const name = m[1];
    const prevIdx = props.indexOf(name);
    if (prevIdx >= 0) {
      // Repeated property → back-reference so both sites must agree.
      pattern += `\\${prevIdx + 1}`;
    } else {
      props.push(name);
      pattern += '(.+?)';
    }
    i = m.index + m[0].length;
  }
  pattern += _escapeRegExp(expr.slice(i));
  if (props.length === 0) return null; // not composite — no ${...} refs
  const matched = new RegExp(`^${pattern}$`).exec(targetVersion);
  if (!matched) return null; // literals/segment-count don't line up with the target
  const out = {};
  for (let k = 0; k < props.length; k++) out[props[k]] = matched[k + 1];
  return out;
}

/**
 * Replace body of `<tag>...</tag>` inline (whole document, all occurrences).
 * @param {string} text Full document text.
 * @param {string} tag Element local name.
 * @param {string} newValue Replacement body.
 * @returns {{text:string, changed:boolean}}
 */
export function replaceElement(text, tag, newValue) {
  const pat = new RegExp(`(<${_escapeRegExp(tag)}>)([^<]*)(</${_escapeRegExp(tag)}>)`, 'g');
  const comments = _commentRanges(text);
  let changed = false;
  const out = text.replace(pat, (m, open, body, close, offset) => {
    if (_inComment(offset, comments)) return m; // never edit inside <!-- ... -->
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
  // Preserve the closing tag's ORIGINAL indentation (the whitespace that sat
  // just before </properties>) rather than guessing a fixed 4-space dedent —
  // tab-indented POMs would otherwise lose the closing tag's indent.
  const closeIndentMatch = body.match(/\n([ \t]*)$/);
  const trailingIndent = closeIndentMatch ? closeIndentMatch[1] : '';
  const newBody = `${body.replace(/\s+$/, '')}\n${indent}<${tag}>${value}</${tag}>\n${trailingIndent}`;
  const start = m.index + m[1].length;
  const end = start + body.length;
  const newText = text.slice(0, start) + newBody + text.slice(end);
  return { text: newText, inserted: true };
}

/**
 * True when `dir` (recursively) contains a `.java` file. Gates the compiler-level
 * insert: javac only checks the source level when there are sources to compile.
 * Missing/unreadable dir → false.
 * @param {string} dir
 * @returns {boolean}
 */
function _hasJavaFiles(dir) {
  if (!existsSync(dir)) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (_hasJavaFiles(full)) return true;
    } else if (e.name.endsWith('.java')) {
      return true;
    }
  }
  return false;
}

/**
 * True when a `maven-compiler-plugin` block declares a `<source>`, `<target>`,
 * or `<release>` level (the plugin-config form the property-tag replace loop in
 * editPomRuntime does NOT catch). Comment-safe via `_findPluginBlocks`.
 * @param {string} text
 * @returns {boolean}
 */
function _compilerPluginHasLevel(text) {
  for (const b of _findPluginBlocks(text)) {
    if (_pluckChild(b.inner, 'artifactId') === 'maven-compiler-plugin') {
      if (/<(?:source|target|release)>[^<]*<\/(?:source|target|release)>/.test(b.inner)) return true;
    }
  }
  return false;
}

/**
 * True when a compiler-level property is present (non-comment). Detects by
 * PRESENCE, not by whether we changed it — a property already at target is
 * `changed:false` yet still declared, and must not trigger a redundant insert.
 * @param {string} text
 * @returns {boolean}
 */
function _hasLevelProperty(text) {
  const tags = [
    'maven.compiler.source', 'maven.compiler.target', 'maven.compiler.release',
    'java.version', 'jdk.version', 'javaVersion',
  ];
  const comments = _commentRanges(text);
  for (const t of tags) {
    for (const m of text.matchAll(new RegExp(`<${_escapeRegExp(t)}>`, 'g'))) {
      if (!_inComment(m.index, comments)) return true;
    }
  }
  return false;
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
  // absent (a POM that doesn't declare them shouldn't sprout new ones). The one
  // exception is the maven.compiler.release insert below, gated on custom Java.
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

  // Compiler level: with none declared, javac uses an ancient default that
  // JDK >= 9 rejects ("Source option 5 is no longer supported"), failing the
  // build. Only matters when there's Java to compile. So if custom Java exists
  // and no level is declared here (property or plugin config), insert the target.
  // A declared level is left alone (property form already bumped in place above).
  const projectDir = path.dirname(pomPath);
  const hasJavaSources =
    _hasJavaFiles(path.join(projectDir, 'src/main/java')) ||
    _hasJavaFiles(path.join(projectDir, 'src/test/java'));
  const compilerLevelDeclared = _hasLevelProperty(text) || _compilerPluginHasLevel(text);
  if (hasJavaSources && !compilerLevelDeclared) {
    const ins = insertProperty(text, 'maven.compiler.release', targetJava);
    if (ins.inserted) {
      text = ins.text;
      changes.push(`maven.compiler.release=${targetJava} (inserted — custom Java, no compiler level declared)`);
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
  // in the munit-maven-plugin config (see editMunitRuntimeVersion).
  const minMule = _featureLineVersion(targetMule);
  if (artifact.minMuleVersion !== minMule) {
    artifact.minMuleVersion = minMule;
    changes.push(`minMuleVersion=${minMule}`);
  }

  // Set javaSpecificationVersions to exactly the target Java. This is a REPLACE,
  // not an append: an upgrade drops the EOL Java the app used to support (e.g.
  // moving to 17 must not leave a stale "8" claiming the app still runs on it).
  // Also covers the insert-if-absent case for a manifest that omits it entirely.
  const existing = artifact.javaSpecificationVersions;
  if (!Array.isArray(existing) || existing.length !== 1 || existing[0] !== targetJava) {
    artifact.javaSpecificationVersions = [targetJava];
    changes.push(`javaSpecificationVersions=[${targetJava}]`);
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
  const comments = _commentRanges(text);
  const depRe = /<dependency>([\s\S]*?)<\/dependency>/g;
  const matches = text.matchAll(depRe);
  for (const m of matches) {
    if (_inComment(m.index, comments)) continue; // skip commented-out dependencies
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

  // Composite / nested version (e.g. ${major}.${minor}.${patch}, 1.7.${patch}).
  // Map the target back onto the component properties deterministically and bump
  // each — never overwrite the composite expression with a literal (that would
  // destroy the property structure the POM deliberately uses). If it can't be
  // mapped cleanly, warn and leave it for the operator rather than guess.
  if (/\$\{[^}]+\}/.test(vText)) {
    const decomposed = decomposeComposite(vText, newVersion);
    if (!decomposed) {
      log.push({ file: pomPath, status: 'warn', reason: `composite version ${vText} could not be mapped to target ${newVersion} (irregular shape) — left unchanged, bump its component properties by hand` });
      return;
    }
    let changed = false;
    for (const [name, val] of Object.entries(decomposed)) {
      if (setProperty(pomPath, name, val, log)) changed = true;
    }
    log.push({ file: pomPath, status: changed ? 'ok' : 'no-op', from: vText, to: newVersion, properties: decomposed });
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
  const comments = _commentRanges(text);
  const re = /<plugin>([\s\S]*?)<\/plugin>/g;
  for (const m of text.matchAll(re)) {
    if (_inComment(m.index, comments)) continue; // skip commented-out plugins
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
 * MUnit spreads across several shapes, and a real pom can mix them (a
 * `<munit.version>` property that some artifacts reference and others ignore in
 * favour of a hardcoded literal — seen in the wild). This bumps every version
 * site in one pass so none is left stale:
 *   - the `<munit.version>` property (if declared),
 *   - the `munit-maven-plugin` `<plugin>` block's literal version,
 *   - the `munit-runner` / `munit-tools` `<dependency>` blocks' literal versions,
 *   - any property referenced by a MUnit `${prop}` version (deps or plugin),
 *     whatever it is named — e.g. `<munit-runner.version>` /
 *     `<munit-tools.version>` or a custom `<munit.plugin.version>` — so a
 *     property-driven pom under a non-`munit.version` name isn't silently skipped.
 * The literal writers skip `${property}` versions; the reference pass bumps the
 * property those refs point at (mirrors the follow in `editPomDependency`). Per the MUnit-in-Maven docs the
 * groupIds differ: the `munit-maven-plugin` is `com.mulesoft.munit.tools`, while
 * the `munit-runner` / `munit-tools` dependencies are `com.mulesoft.munit`.
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
  const PLUGIN_GROUP = 'com.mulesoft.munit.tools'; // munit-maven-plugin
  const DEP_GROUP = 'com.mulesoft.munit';          // munit-runner / munit-tools

  const prop = replaceElement(text, 'munit.version', version);
  if (prop.changed) {
    text = prop.text;
    changes.push(`munit.version=${version}`);
  }

  const plug = _setPluginVersionInText(text, { groupId: PLUGIN_GROUP, artifactId: 'munit-maven-plugin', version });
  if (plug.changed) {
    text = plug.text;
    changes.push(`munit-maven-plugin <version>=${version} (literal)`);
  }

  for (const artifactId of ['munit-runner', 'munit-tools']) {
    const dep = _setDependencyVersionInText(text, { groupId: DEP_GROUP, artifactId, version });
    if (dep.changed) {
      text = dep.text;
      changes.push(`${artifactId} <version>=${version} (literal)`);
    }
  }

  // The literal passes above skip ${...} versions, so follow every MUnit
  // ${prop} reference to its property and bump that (deps or plugin, whatever
  // the property is named). Each property bumped once — a shared one is one edit.
  const refProps = []; // { propName, from }
  // munit-runner / munit-tools dependency <version> refs.
  for (const b of _findDependencyBlocks(text)) {
    if (_pluckChild(b.inner, 'groupId') !== DEP_GROUP) continue;
    const artifactId = _pluckChild(b.inner, 'artifactId');
    if (artifactId !== 'munit-runner' && artifactId !== 'munit-tools') continue;
    const refMatch = _pluckChild(b.inner, 'version').match(/^\$\{([^}]+)\}$/);
    if (refMatch) refProps.push({ propName: refMatch[1], from: artifactId });
  }
  // munit-maven-plugin <version> ref.
  for (const b of _findPluginBlocks(text)) {
    if (_pluckChild(b.inner, 'artifactId') !== 'munit-maven-plugin') continue;
    const gid = _pluckChild(b.inner, 'groupId');
    if (gid && gid !== PLUGIN_GROUP) continue;
    const refMatch = _pluckChild(b.inner, 'version').match(/^\$\{([^}]+)\}$/);
    if (refMatch) refProps.push({ propName: refMatch[1], from: 'munit-maven-plugin' });
  }

  const bumpedProps = new Set(['munit.version']); // already handled above
  for (const { propName, from } of refProps) {
    if (bumpedProps.has(propName)) continue;
    bumpedProps.add(propName);
    const ref = replaceElement(text, propName, version);
    if (ref.changed) {
      text = ref.text;
      changes.push(`${propName}=${version} (property ref from ${from})`);
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
 * Pin the munit-maven-plugin's embedded test runtime to the target runtime.
 *
 * Why required: MUnit picks its runtime from <runtimeVersion>, else falls back
 * to minMuleVersion. We write minMuleVersion as the x.y.0 feature line, so that
 * fallback boots the x.y.0 runtime — whose bundled mule-sdk-api JavaVersion enum
 * can lack newer constants (e.g. JAVA_25). Connectors compiled against the target
 * patch then throw EnumConstantNotPresentException and MUnit never runs. Pinning
 * runtimeVersion forces the test runtime to match the deploy runtime.
 *
 * ${prop} reference → bump the named property to targetRuntime; literal pin →
 * left untouched; absent → insert ${app.runtime}. No-op if the plugin is absent.
 *
 * @param {string} pomPath
 * @param {string|null} targetRuntime Target runtime (`.mule.to`, the full patch);
 *   used only to bump a `${prop}`-referenced `<runtimeVersion>`. When absent, a
 *   property-referenced pin is left unchanged (with a warn).
 * @param {Array<object>} log Mutated with a per-file status entry.
 */
export function editMunitRuntimeVersion(pomPath, targetRuntime, log) {
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

  // Already declared. A ${prop} reference is followed and its property bumped to
  // the target runtime; a literal pin is a deliberate value and left untouched.
  const rvMatch = block.inner.match(/<runtimeVersion>([^<]*)<\/runtimeVersion>/);
  if (rvMatch) {
    const refMatch = rvMatch[1].trim().match(/^\$\{([^}]+)\}$/);
    if (refMatch) {
      const propName = refMatch[1];
      if (!targetRuntime) {
        log.push({ file: pomPath, status: 'warn', reason: `runtimeVersion references \${${propName}} but no target runtime supplied — left unchanged` });
        return;
      }
      const ref = replaceElement(text, propName, targetRuntime);
      if (ref.changed) {
        _write(pomPath, ref.text);
        log.push({ file: pomPath, status: 'applied', changes: [`${propName}=${targetRuntime} (runtimeVersion property ref)`] });
      } else {
        // No change: don't claim "already X" for a property absent here (it may
        // live in a parent) — distinguish absent from already-at-target.
        const declared = new RegExp(`<${_escapeRegExp(propName)}>`).test(text);
        const reason = declared
          ? `runtimeVersion property ${propName} already ${targetRuntime}`
          : `runtimeVersion references \${${propName}} but that property is not declared in this pom — left unchanged`;
        log.push({ file: pomPath, status: 'no-op', reason });
      }
      return;
    }
    // Literal pin — deliberate, never clobber.
    log.push({ file: pomPath, status: 'no-op', reason: 'runtimeVersion is a literal pin — left untouched' });
    return;
  }
  if (/<runtimeVersion>/.test(block.inner)) {
    // Present but not a simple <runtimeVersion>value</runtimeVersion> shape — leave it.
    log.push({ file: pomPath, status: 'no-op', reason: 'runtimeVersion present (unrecognized shape) — left untouched' });
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

// ---------- Parent-POM fork primitives (Step 18) ----------
//
// These are the WRITE-side counterparts to _pom_utils.mjs's read-side chain
// walk. They are all POM-path-parameterized (operate on ANY pom.xml, not just
// the child) and single-purpose so the Step 18 orchestrator can compose them:
// bump the versions an ancestor owns, fork that ancestor's own <version>, then
// repoint the downstream <parent> ref. Regex-based like the rest of this file,
// so original whitespace/layout is preserved.

/**
 * Locate every `<dependencyManagement>…</dependencyManagement>` region so a
 * dependency-block edit can be told whether it sits under management or under a
 * live `<dependencies>`. Returns [{start,end}] byte ranges over `text`.
 * @param {string} text
 * @returns {Array<{start:number, end:number}>}
 */
function _dependencyManagementRanges(text) {
  const ranges = [];
  const re = /<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g;
  for (const m of text.matchAll(re)) {
    ranges.push({ start: m.index, end: m.index + m[0].length });
  }
  return ranges;
}

/**
 * Set a single `<properties>` child element's value in place. Only rewrites an
 * EXISTING property — never inserts (an ancestor that doesn't declare the
 * property doesn't own it, so there is nothing to fork there). Rewrites the
 * property wherever it is declared in the file, but scoped to the FIRST
 * `<properties>` block (Maven's project-level properties); a `<profiles>`-local
 * property is intentionally not touched.
 * @param {string} pomPath
 * @param {string} name Property local-name, e.g. "app.runtime" or "db.version".
 * @param {string} value New value.
 * @param {Array<object>} log
 * @returns {boolean} true when a change was written.
 */
export function setProperty(pomPath, name, value, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found', property: name });
    return false;
  }
  let text = _read(pomPath);
  const propsMatch = text.match(/<properties>([\s\S]*?)<\/properties>/);
  if (!propsMatch) {
    log.push({ file: pomPath, status: 'not-found', reason: 'no <properties> block', property: name });
    return false;
  }
  const propRe = new RegExp(`(<${_escapeRegExp(name)}>)([^<]*)(</${_escapeRegExp(name)}>)`);
  const bodyMatch = propsMatch[1].match(propRe);
  if (!bodyMatch) {
    log.push({ file: pomPath, status: 'not-found', reason: `property ${name} not declared`, property: name });
    return false;
  }
  const oldValue = bodyMatch[2].trim();
  if (oldValue === value) {
    log.push({ file: pomPath, status: 'no-op', property: name, from: oldValue, to: value });
    return false;
  }
  const propsStart = propsMatch.index + '<properties>'.length;
  const oldBody = propsMatch[1];
  const newBody = oldBody.replace(propRe, (m, open, _b, close) => `${open}${value}${close}`);
  text = text.slice(0, propsStart) + newBody + text.slice(propsStart + oldBody.length);
  _write(pomPath, text);
  log.push({ file: pomPath, status: 'ok', property: name, from: oldValue, to: value });
  return true;
}

/**
 * Bump a connector's `<version>` at EVERY site it is declared in one POM —
 * across both `<dependencies>` and `<dependencyManagement>` — for the matching
 * groupId+artifactId. Mirrors the read side, which resolves a version from
 * either region:
 *   - inline `<version>x.y.z</version>` → rewritten in place;
 *   - `<version>${prop}</version>` → the referenced `<properties>` entry is
 *     bumped instead (so a property shared by several connectors is a single
 *     edit; each connector site is a no-op that records which property it rode);
 *   - a version-less managed dependency → the site carrying the `<version>`
 *     (the dependencyManagement entry) is the one edited.
 * Composite/nested `${a}.${b}` versions in a live dependency are left to the
 * property bumps of their parts — this writer only follows a WHOLE-string
 * `${prop}` ref, matching how an ancestor typically owns a single version prop.
 * @param {string} pomPath
 * @param {{groupId:string, artifactId:string, version:string}} gav Target GAV.
 * @param {Array<object>} log
 * @returns {boolean} true when at least one site (inline or property) changed.
 */
export function bumpDependencyVersionSites(pomPath, gav, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return false;
  }
  let text = _read(pomPath);
  const { groupId, artifactId, version: newVersion } = gav;
  const dmRanges = _dependencyManagementRanges(text);
  const inDm = (pos) => dmRanges.some((r) => pos >= r.start && pos < r.end);

  const blocks = _findDependencyBlocks(text).filter(
    (b) => _pluckChild(b.inner, 'groupId') === groupId && _pluckChild(b.inner, 'artifactId') === artifactId,
  );
  if (blocks.length === 0) {
    log.push({ file: pomPath, status: 'not-found', reason: `dependency ${groupId}:${artifactId} not declared here` });
    return false;
  }

  // Two passes so property edits and inline edits don't shift each other's
  // offsets: first collect what to do, then apply inline edits back-to-front and
  // property edits by name. A ${prop} site defers to setProperty.
  const propNames = new Set();          // whole-${prop} sites → property gets newVersion
  const compositeProps = new Map();     // composite ${a}.${b} sites → propName -> its own value
  const inlineEdits = []; // {start, end, innerNew}
  const results = [];
  for (const b of blocks) {
    const region = inDm(b.start) ? 'dependencyManagement' : 'dependencies';
    const vMatch = b.inner.match(/<version>([^<]*)<\/version>/);
    if (!vMatch) {
      results.push({ status: 'skip', region, reason: 'no <version> — inherits from a managed/parent site' });
      continue;
    }
    const vText = vMatch[1].trim();
    const whole = vText.match(/^\$\{([^}]+)\}$/);
    if (whole) {
      propNames.add(whole[1]);
      results.push({ status: 'via-property', region, property: whole[1] });
      continue;
    }
    if (/\$\{[^}]+\}/.test(vText)) {
      // Composite/nested (e.g. ${major}.${minor}.${patch}, 1.7.${patch}). Map the
      // target back onto the component properties deterministically; each property
      // is then bumped to ITS OWN value below. If the target can't be mapped
      // cleanly (literal mismatch / segment-count / conflicting property), warn —
      // never write a wrong value. The verify pass re-resolves via resolveValue.
      const decomposed = decomposeComposite(vText, newVersion);
      if (decomposed) {
        for (const [name, val] of Object.entries(decomposed)) {
          const prev = compositeProps.get(name);
          if (prev !== undefined && prev !== val) {
            // Same property forced to two different values across sites — unsafe.
            log.push({ file: pomPath, status: 'warn', dependency: `${groupId}:${artifactId}`, reason: `composite version ${vText} maps property \${${name}} to conflicting values (${prev} vs ${val}) — left unchanged, bump by hand` });
            compositeProps.delete(name);
          } else {
            compositeProps.set(name, val);
          }
        }
        results.push({ status: 'via-composite', region, from: vText, to: newVersion, properties: decomposed });
      } else {
        log.push({ file: pomPath, status: 'warn', dependency: `${groupId}:${artifactId}`, reason: `composite version ${vText} could not be mapped to target ${newVersion} (irregular shape) — left unchanged, bump its component properties by hand` });
        results.push({ status: 'skip', region, from: vText, reason: `composite ${vText} not mappable to ${newVersion} — operator attention` });
      }
      continue;
    }
    if (vText === newVersion) {
      results.push({ status: 'no-op', region, from: vText, to: newVersion });
      continue;
    }
    const innerNew = b.inner.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
    inlineEdits.push({ start: b.start, end: b.end, innerNew });
    results.push({ status: 'ok', region, from: vText, to: newVersion });
  }

  let changed = false;
  for (const e of [...inlineEdits].sort((a, c) => c.start - a.start)) {
    text = text.slice(0, e.start) + `<dependency>${e.innerNew}</dependency>` + text.slice(e.end);
    changed = true;
  }
  if (changed) _write(pomPath, text);

  // Whole-${prop} sites: bump each referenced property once to the full target
  // (setProperty reads fresh from disk, so it sees the inline edits above).
  for (const prop of propNames) {
    if (setProperty(pomPath, prop, newVersion, log)) changed = true;
  }
  // Composite sites: bump each component property to ITS OWN decomposed value.
  for (const [name, val] of compositeProps) {
    if (setProperty(pomPath, name, val, log)) changed = true;
  }

  log.push({ file: pomPath, status: changed ? 'ok' : 'no-op', dependency: `${groupId}:${artifactId}`, to: newVersion, sites: results });
  return changed;
}

/**
 * Bump a POM's OWN top-level `<project><version>` — the fork. The hazard is that
 * a POM contains many `<version>` elements (inside `<parent>`, every
 * `<dependency>`, every `<plugin>`); only the project-level one may move. This
 * targets the `<version>` that is a DIRECT child of `<project>`: the first
 * `<version>` that appears after the `</parent>` close (or after `<modelVersion>`
 * when there is no `<parent>`) and before the first `<dependencies>`/`<build>`/
 * `<dependencyManagement>`/`<properties>` section.
 * @param {string} pomPath
 * @param {string} newVersion
 * @param {Array<object>} log
 * @returns {{changed:boolean, from:string|null}}
 */
export function bumpOwnVersion(pomPath, newVersion, log) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return { changed: false, from: null };
  }
  let text = _read(pomPath);

  // Anchor the search window: after </parent> if present, else after
  // <modelVersion>. End it at the first section that can carry nested <version>s.
  const parentClose = text.indexOf('</parent>');
  const afterParent = parentClose >= 0 ? parentClose + '</parent>'.length : 0;
  const modelVer = text.match(/<modelVersion>[^<]*<\/modelVersion>/);
  const afterModel = modelVer ? modelVer.index + modelVer[0].length : 0;
  const windowStart = Math.max(afterParent, afterModel);

  const sectionRe = /<(dependencies|dependencyManagement|build|properties|profiles|modules)\b/;
  const rest = text.slice(windowStart);
  const secMatch = rest.match(sectionRe);
  const windowEnd = secMatch ? windowStart + secMatch.index : text.length;

  const window = text.slice(windowStart, windowEnd);
  const verRe = /<version>([^<]*)<\/version>/;
  const vm = window.match(verRe);
  if (!vm) {
    log.push({ file: pomPath, status: 'not-found', reason: 'no project-level <version> element to fork' });
    return { changed: false, from: null };
  }
  const oldVersion = vm[1].trim();
  if (oldVersion === newVersion) {
    log.push({ file: pomPath, status: 'no-op', ownVersion: { from: oldVersion, to: newVersion } });
    return { changed: false, from: oldVersion };
  }
  const abs = windowStart + vm.index;
  text = text.slice(0, abs) + `<version>${newVersion}</version>` + text.slice(abs + vm[0].length);
  _write(pomPath, text);
  log.push({ file: pomPath, status: 'ok', ownVersion: { from: oldVersion, to: newVersion } });
  return { changed: true, from: oldVersion };
}

/**
 * Repoint a POM's `<parent><version>` to `newVersion` — the downstream half of a
 * fork (after the parent's own <version> was bumped, its children must follow).
 * Edits ONLY the `<version>` inside the `<parent>` block, leaving the project's
 * own version and all dependency/plugin versions untouched. Optionally verifies
 * the block's coordinates match the expected parent GAV before editing.
 * @param {string} pomPath
 * @param {string} newVersion
 * @param {Array<object>} log
 * @param {{groupId?:string, artifactId?:string}} [expect] Optional identity check.
 * @returns {{changed:boolean, from:string|null}}
 */
export function repointParentVersion(pomPath, newVersion, log, expect = {}) {
  if (!existsSync(pomPath)) {
    log.push({ file: pomPath, status: 'error', reason: 'pom.xml not found' });
    return { changed: false, from: null };
  }
  let text = _read(pomPath);
  const parentMatch = text.match(/<parent>([\s\S]*?)<\/parent>/);
  if (!parentMatch) {
    log.push({ file: pomPath, status: 'not-found', reason: 'no <parent> block' });
    return { changed: false, from: null };
  }
  const inner = parentMatch[1];
  if (expect.artifactId && _pluckChild(inner, 'artifactId') !== expect.artifactId) {
    log.push({ file: pomPath, status: 'skip', reason: `<parent> artifactId ${_pluckChild(inner, 'artifactId')} != expected ${expect.artifactId}` });
    return { changed: false, from: null };
  }
  if (expect.groupId && _pluckChild(inner, 'groupId') !== expect.groupId) {
    log.push({ file: pomPath, status: 'skip', reason: `<parent> groupId ${_pluckChild(inner, 'groupId')} != expected ${expect.groupId}` });
    return { changed: false, from: null };
  }
  const vMatch = inner.match(/<version>([^<]*)<\/version>/);
  if (!vMatch) {
    log.push({ file: pomPath, status: 'not-found', reason: '<parent> has no <version>' });
    return { changed: false, from: null };
  }
  const oldVersion = vMatch[1].trim();
  if (oldVersion === newVersion) {
    log.push({ file: pomPath, status: 'no-op', parentVersion: { from: oldVersion, to: newVersion } });
    return { changed: false, from: oldVersion };
  }
  const innerNew = inner.replace(/<version>[^<]*<\/version>/, `<version>${newVersion}</version>`);
  const start = parentMatch.index;
  const end = start + parentMatch[0].length;
  text = text.slice(0, start) + `<parent>${innerNew}</parent>` + text.slice(end);
  _write(pomPath, text);
  log.push({ file: pomPath, status: 'ok', parentVersion: { from: oldVersion, to: newVersion } });
  return { changed: true, from: oldVersion };
}
