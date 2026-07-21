// pom.mjs — shared POM/XML helpers for the upgrade-mule-app detection scripts.
//
// Extracted so the parser, property resolution, and parent-POM location logic
// live in one place instead of being copy-pasted across
// detect_current_mule_version.mjs, detect_current_java_version.mjs, and
// validate_prerequisites.mjs. A bug fix to parent resolution should be a
// single edit, not three.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";

export const PROP_REF = /^\$\{([^}]+)\}$/;

// ---------------------------------------------------------------------------
// Minimal, tolerant XML parser -> node tree { name, attrs, children, text }.
// Handles elements, attributes, comments, CDATA, self-closing tags, and
// namespace prefixes (the prefix is stripped so "mule:muleVersion" ->
// "muleVersion"). This is not a general XML validator; it is enough for POMs.
// ---------------------------------------------------------------------------
export function parseXml(xml) {
  xml = xml
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");

  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^<>]*?)?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>/g;

  let lastIndex = 0;
  let m;
  while ((m = tag.exec(xml)) !== null) {
    const between = xml.slice(lastIndex, m.index);
    if (between.trim()) {
      stack[stack.length - 1].text += decodeEntities(between);
    }
    lastIndex = tag.lastIndex;

    if (m[5] !== undefined) {
      stack[stack.length - 1].text += m[5];
      continue;
    }

    const closing = m[1] === "/";
    const rawName = m[2];
    const name = rawName.includes(":") ? rawName.split(":").pop() : rawName;
    const selfClose = m[4] === "/";

    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node = { name, attrs: parseAttrs(m[3] || ""), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

export function parseAttrs(s) {
  const attrs = {};
  const re = /([\w.-]+(?::[\w.-]+)?)\s*=\s*"([^"]*)"|([\w.-]+)\s*=\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const key = (m[1] || m[3]);
    const val = m[2] !== undefined ? m[2] : m[4];
    attrs[key.includes(":") ? key.split(":").pop() : key] = decodeEntities(val);
  }
  return attrs;
}

export function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Tree helpers -------------------------------------------------------------
export function children(node, name) {
  return node ? node.children.filter((c) => c.name === name) : [];
}
export function child(node, name) {
  return node ? node.children.find((c) => c.name === name) : undefined;
}
export function textOf(node) {
  return node ? node.text.trim() : "";
}
// The <project> element (root has a single #root wrapper).
export function projectOf(root) {
  return child(root, "project") || root;
}

export function extractProperties(project) {
  const props = {};
  const p = child(project, "properties");
  if (!p) return props;
  for (const c of p.children) props[c.name] = c.text.trim();
  return props;
}

// Resolve a possibly-${prop} raw value against a merged property table.
// Returns a concrete string, or null if it cannot be resolved (unknown prop or
// a reference cycle). Supports nested references like ${a} -> ${b} -> 4.6.0.
export function resolveValue(raw, mergedProps, seen = new Set()) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  const m = v.match(PROP_REF);
  if (!m) return v; // literal
  const key = m[1];
  if (seen.has(key)) return null; // cycle
  seen.add(key);
  if (!(key in mergedProps)) return null; // unresolved reference
  return resolveValue(mergedProps[key], mergedProps, seen);
}

// Locate the parent pom.xml on disk via <parent><relativePath> or ../pom.xml.
// Returns the absolute path, or null if there is no <parent> / it is not found.
export function findParentPomPath(childProject, childPomPath) {
  const parent = child(childProject, "parent");
  if (!parent) return null;
  const childDir = dirname(childPomPath);
  const relRaw = textOf(child(parent, "relativePath"));
  // Maven default relativePath is ../pom.xml. Empty <relativePath/> disables it.
  const relIsExplicitlyEmpty =
    child(parent, "relativePath") !== undefined && relRaw === "";
  if (relIsExplicitlyEmpty) return null;

  const candidates = [];
  if (relRaw) {
    const p = resolve(childDir, relRaw);
    candidates.push(p, join(p, "pom.xml"));
  }
  candidates.push(resolve(childDir, "..", "pom.xml"));
  for (const c of candidates) {
    if (existsSync(c) && c.endsWith(".xml")) return c;
  }
  return null;
}

// Convenience: parse a POM file from disk into its <project> node.
export function readPomProject(pomPath) {
  return projectOf(parseXml(readFileSync(pomPath, "utf8")));
}
