#!/usr/bin/env node
// detect-current-java-version.mjs
//
// Determine the current Java version of a Mule application.
//
// Deterministic order (see SKILL.md Step 2b):
//   1. Child mule-artifact.json : javaSpecificationVersions
//        - exactly one entry  -> that is the current version
//        - multiple entries   -> compatibility list, no single "current":
//                                caller must prompt the user to choose
//        - absent / empty     -> fall through to the POM
//   2. pom.xml (child, then parent): compiler settings, in order
//        maven.compiler.release -> maven.compiler.source ->
//        maven.compiler.target  -> java.version property
//        (resolving ${...} against the merged child+parent properties)
//   3. Otherwise : caller must prompt the user
//
// Key rules:
//   - A value from the POM is a slightly weaker signal than a single-entry
//     javaSpecificationVersions (it is the compile target, not necessarily the
//     runtime). It is still used as-is (needsUserPrompt stays false), but the
//     `source` field records where it came from so the caller MAY confirm it.
//   - A ${prop} reference is resolved against the MERGED property table
//     (child <properties> first, then parent <properties>).
//   - An unresolvable ${prop} is NEVER accepted literally; the search falls
//     through to the next source.
//
// Usage:
//   node detect-current-java-version.mjs [projectDir] [--out <file>]
//
// Default projectDir = cwd. Default out = <projectDir>/tmp/current-java-version.json
// Prints a JSON summary to stdout and persists the same object to disk.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import {
  PROP_REF,
  parseXml,
  children,
  child,
  textOf,
  projectOf,
  extractProperties,
  resolveValue,
  findParentPomPath,
} from "./_pom_utils.mjs";

// ---------------------------------------------------------------------------
// Extraction (Java-specific)
// ---------------------------------------------------------------------------
// POM compiler sources, in precedence order.
const POM_COMPILER_PROPS = ["maven.compiler.release", "maven.compiler.source", "maven.compiler.target", "java.version"];

// Lowest CURRENT Java version the skill will upgrade from. Apps below this are
// out of scope; the caller must stop. Documented in SKILL.md Prerequisites as
// "Java 8+".
const MIN_SUPPORTED_JAVA_VERSION = 8;

// maven-compiler-plugin <configuration> release/source/target (direct children).
function extractCompilerPluginSettings(project) {
  const out = {};
  const build = child(project, "build");
  if (!build) return out;
  const collectPlugins = (buildNode) => {
    const plugins = [];
    for (const ps of children(buildNode, "plugins")) plugins.push(...children(ps, "plugin"));
    for (const pm of children(buildNode, "pluginManagement")) {
      for (const ps of children(pm, "plugins")) plugins.push(...children(ps, "plugin"));
    }
    return plugins;
  };
  for (const plugin of collectPlugins(build)) {
    if (textOf(child(plugin, "artifactId")) !== "maven-compiler-plugin") continue;
    const config = child(plugin, "configuration");
    if (!config) continue;
    for (const key of ["release", "source", "target"]) {
      const raw = textOf(child(config, key));
      if (raw && !(key in out)) out[key] = raw;
    }
  }
  return out;
}

// Normalize a Java version token to its "spec" number where obvious:
//   "1.8" -> "8", "1.7" -> "7"; "11", "17", "21" pass through.
function normalizeJava(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^1\.(\d+)$/);
  if (m) return m[1];
  return s;
}

// Detect the Java version from a single POM project node, in precedence order:
// compiler-plugin release/source/target, then properties
// (maven.compiler.release/source/target, java.version). Returns {version, source} or null.
function detectJavaInProject(project, ownProps, mergedProps) {
  const pluginCfg = extractCompilerPluginSettings(project);
  for (const key of ["release", "source", "target"]) {
    if (!(key in pluginCfg)) continue;
    const resolved = resolveValue(pluginCfg[key], mergedProps);
    if (resolved) {
      return { version: normalizeJava(resolved), source: `pom.maven-compiler-plugin.${key}`, raw: pluginCfg[key] };
    }
  }
  for (const name of POM_COMPILER_PROPS) {
    if (!(name in ownProps)) continue;
    const resolved = resolveValue(ownProps[name], mergedProps);
    if (resolved) {
      return { version: normalizeJava(resolved), source: `pom.property:${name}`, raw: ownProps[name] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  let projectDir = process.cwd();
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i];
    else if (!argv[i].startsWith("--")) projectDir = resolve(argv[i]);
  }
  projectDir = resolve(projectDir);
  if (!outPath) outPath = join(projectDir, "tmp", "current-java-version.json");

  const result = {
    projectDir,
    version: null,            // resolved current Java version (spec number), or null
    source: null,             // where it came from
    supportedVersions: null,  // javaSpecificationVersions array, if present
    needsUserPrompt: false,
    belowFloor: false,        // true if detected version < MIN_SUPPORTED_JAVA_VERSION
    minSupportedVersion: String(MIN_SUPPORTED_JAVA_VERSION),
    warnings: [],
    notes: [],
  };

  // --- Step 1: mule-artifact.json javaSpecificationVersions ---
  const artifactPath = join(projectDir, "mule-artifact.json");
  let javaSpecs = null;
  if (existsSync(artifactPath)) {
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      const raw = artifact.javaSpecificationVersions;
      if (Array.isArray(raw)) javaSpecs = raw.map((x) => normalizeJava(String(x))).filter(Boolean);
    } catch (e) {
      result.warnings.push(`Failed to parse mule-artifact.json: ${e.message}`);
    }
  } else {
    result.notes.push("No mule-artifact.json found; will check pom.xml compiler settings.");
  }

  if (javaSpecs && javaSpecs.length > 0) {
    result.supportedVersions = javaSpecs;
    if (javaSpecs.length === 1) {
      result.version = javaSpecs[0];
      result.source = "mule-artifact.json:javaSpecificationVersions";
      return emit(result, outPath);
    }
    // Multiple: compatibility list, no single "current" -> prompt to choose.
    result.needsUserPrompt = true;
    result.warnings.push(
      `mule-artifact.json declares support for multiple Java versions ` +
      `(${javaSpecs.join(", ")}). This is a compatibility list, not a single ` +
      `current version. Ask the user which one the app currently runs on.`
    );
    return emit(result, outPath);
  }

  // javaSpecificationVersions absent or empty -> fall through to POM.
  if (existsSync(artifactPath)) {
    result.notes.push("javaSpecificationVersions absent/empty in mule-artifact.json; checking pom.xml.");
  }

  // --- Step 2: pom.xml (child, then parent) compiler settings ---
  const childPomPath = join(projectDir, "pom.xml");
  if (existsSync(childPomPath)) {
    const childProject = projectOf(parseXml(readFileSync(childPomPath, "utf8")));
    const childProps = extractProperties(childProject);

    const parentPomPath = findParentPomPath(childProject, childPomPath);
    let parentProject = null;
    let parentProps = {};
    if (parentPomPath) {
      try {
        parentProject = projectOf(parseXml(readFileSync(parentPomPath, "utf8")));
        parentProps = extractProperties(parentProject);
        result.notes.push(`Parent POM: ${parentPomPath}`);
      } catch (e) {
        result.warnings.push(`Failed to read parent POM ${parentPomPath}: ${e.message}`);
      }
    }
    const parentDeclaredButMissing = !parentProject && !!child(childProject, "parent");
    const mergedProps = { ...parentProps, ...childProps };

    let found = detectJavaInProject(childProject, childProps, mergedProps);
    if (!found && parentProject) {
      found = detectJavaInProject(parentProject, parentProps, mergedProps);
    }

    if (found) {
      result.version = found.version;
      result.source = found.source;
      if (PROP_REF.test(found.raw || "")) {
        result.notes.push(`Resolved ${found.raw} -> ${found.version}`);
      }
      // POM value is the compile target, not guaranteed to be the runtime Java.
      // Used as-is, but flagged so the caller MAY confirm.
      result.notes.push(
        "Java version came from pom.xml compiler settings (compile target). " +
        "The caller may confirm it matches the runtime Java version."
      );
      // Parent declared but missing, yet we resolved without it: keep it low-key.
      if (parentDeclaredButMissing) {
        result.notes.push(
          "Child declares a <parent> whose POM was not found locally, but the " +
          "Java version was resolved without it, so it was not needed."
        );
      }
      return emit(result, outPath);
    }

    // Not found in the POM(s). If the cause is a missing parent, say so
    // specifically and stop here — do not also emit the generic prompt message.
    result.needsUserPrompt = true;
    if (parentDeclaredButMissing) {
      result.warnings.push(
        "Child declares a <parent>, but the parent POM was not found locally. " +
        "Java compiler settings inherited from the parent cannot be resolved. Ask " +
        "the user to make the parent POM available locally and re-run."
      );
    } else {
      result.warnings.push(
        "Could not determine the current Java version from mule-artifact.json or " +
        "pom.xml. Prompt the user for the current Java version."
      );
    }
    return emit(result, outPath);
  }

  // --- Step 3: no pom.xml at all, and mule-artifact.json had nothing usable -> prompt ---
  result.needsUserPrompt = true;
  result.warnings.push(`No pom.xml found at ${childPomPath}.`);
  result.warnings.push(
    "Could not determine the current Java version from mule-artifact.json or " +
    "pom.xml. Prompt the user for the current Java version."
  );
  return emit(result, outPath);
}

function emit(result, outPath) {
  // Floor check: skill only upgrades apps already on Java 8+. Only meaningful
  // for a version the script itself resolved; a user-supplied version must be
  // floor-checked by the caller (SKILL.md) after prompting.
  if (result.version != null) {
    const n = Number(result.version);
    if (Number.isFinite(n) && n < MIN_SUPPORTED_JAVA_VERSION) {
      result.belowFloor = true;
      result.warnings.push(
        `Detected Java version ${result.version} is below the minimum supported ` +
        `version (${MIN_SUPPORTED_JAVA_VERSION}). This skill only upgrades apps ` +
        `already on Java ${MIN_SUPPORTED_JAVA_VERSION}+. Upgrade the app to at ` +
        `least Java ${MIN_SUPPORTED_JAVA_VERSION} before running this skill.`
      );
    }
  }
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    result.outPath = outPath;
  } catch (e) {
    result.warnings.push(`Failed to write ${outPath}: ${e.message}`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return result;
}

main();
