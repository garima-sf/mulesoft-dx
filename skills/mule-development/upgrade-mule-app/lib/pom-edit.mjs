// pom-edit.mjs — deterministic pom.xml + mule-artifact.json + flow-XML edits.
//
// Regex-based rewrite — no XML parser dependency — so edits are surgical and
// preserve the original file's whitespace/layout.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ---------- runtime → mule-maven-plugin matrix ----------
// Keep in sync with references/runtime-bump-matrix.md.
const MULE_MAVEN_PLUGIN_MATRIX = {
  '4.3.0': '3.6.1',
  '4.3.': '3.6.1',
  '4.4.0': '3.8.0',
  '4.4.': '3.8.0',
  '4.5.0': '4.1.0',
  '4.5.': '4.1.0',
  '4.6.0': '4.3.0',
  '4.6.': '4.3.0',
  '4.7.0': '4.4.0',
  '4.7.': '4.4.0',
  '4.8.0': '4.6.0',
  '4.8.': '4.6.0',
  '4.9.0': '4.9.0',
  '4.9.': '4.9.0',
  '4.10.0': '4.10.1',
  '4.10.': '4.10.1',
};

/** @param {string} runtime Mule runtime version. @returns {string|null} Longest-prefix mule-maven-plugin match, e.g. 4.6.1 → matrix['4.6.']. */
export function muleMavenPluginFor(runtime) {
  const keys = Object.keys(MULE_MAVEN_PLUGIN_MATRIX).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (runtime.startsWith(k)) return MULE_MAVEN_PLUGIN_MATRIX[k];
  }
  return null;
}

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
 * @param {Array<object>} log Mutated with per-file status entries.
 */
export function editPomRuntime(pomPath, targetMule, targetJava, log) {
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

  const mmp = muleMavenPluginFor(targetMule);
  if (mmp) {
    const rr = replaceElement(text, 'mule.maven.plugin.version', mmp);
    if (rr.changed) {
      text = rr.text;
      changes.push(`mule.maven.plugin.version=${mmp}`);
    } else {
      const ins = insertProperty(text, 'mule.maven.plugin.version', mmp);
      if (ins.inserted) {
        text = ins.text;
        changes.push(`mule.maven.plugin.version=${mmp} (inserted)`);
      }
    }
  } else {
    log.push({
      file: pomPath,
      status: 'warn',
      reason: `no mule-maven-plugin matrix entry for ${targetMule} — leaving unchanged`,
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

  if (artifact.minMuleVersion !== targetMule) {
    artifact.minMuleVersion = targetMule;
    changes.push(`minMuleVersion=${targetMule}`);
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
