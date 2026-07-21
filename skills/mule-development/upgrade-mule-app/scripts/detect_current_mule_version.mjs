#!/usr/bin/env node
// detect-current-mule-version.mjs
//
// Determine the current Mule Runtime version of a Mule application by parsing
// pom.xml (child, then parent) and cross-checking mule-artifact.json.
//
// Deterministic order (see SKILL.md Step 2):
//   1. Child  pom.xml : mule-maven-plugin <configuration><muleVersion>
//   2. Child  pom.xml : runtime property  (app.runtime, then mule.version)
//   3. Parent pom.xml : repeat 1 then 2
//   4. Otherwise      : caller must prompt the user
// Then cross-check against mule-artifact.json minMuleVersion.
//
// Key rules:
//   - A ${prop} reference is resolved against the MERGED property table
//     (child <properties> first, then parent <properties>). This lets a child
//     <muleVersion>${app.runtime}</muleVersion> resolve even when app.runtime
//     is declared only in the parent.
//   - An unresolvable ${prop} is NEVER accepted as a literal version; the
//     search falls through to the next source.
//   - Only <configuration><muleVersion> (direct child) is authoritative.
//     A muleVersion inside a deployment block is a weaker signal and ignored
//     here.
//
// Usage:
//   node detect-current-mule-version.mjs [projectDir] [--out <file>]
//
// Default projectDir = cwd. Default out = <projectDir>/tmp/current-mule-version.json
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
// POM extraction (Mule-runtime-specific)
// ---------------------------------------------------------------------------
const RUNTIME_PROPERTY_NAMES = ["app.runtime", "mule.version"];
const MULE_MAVEN_PLUGIN = "mule-maven-plugin";

// Lowest CURRENT Mule Runtime version the skill will upgrade from. Apps below
// this are out of scope; the caller must stop (there is no valid answer to
// prompt for). Documented in SKILL.md Prerequisites as "Mule 4.4+".
const MIN_SUPPORTED_MULE_VERSION = "4.4";

// Direct <configuration><muleVersion> of mule-maven-plugin. Deployment-block
// muleVersion (configuration/*/muleVersion) is intentionally ignored.
function extractPluginMuleVersion(project) {
  const build = child(project, "build");
  if (!build) return null;
  const collectPlugins = (buildNode) => {
    const out = [];
    for (const plugins of children(buildNode, "plugins")) {
      out.push(...children(plugins, "plugin"));
    }
    // pluginManagement -> plugins -> plugin
    for (const pm of children(buildNode, "pluginManagement")) {
      for (const plugins of children(pm, "plugins")) {
        out.push(...children(plugins, "plugin"));
      }
    }
    return out;
  };
  for (const plugin of collectPlugins(build)) {
    if (textOf(child(plugin, "artifactId")) !== MULE_MAVEN_PLUGIN) continue;
    const config = child(plugin, "configuration");
    if (!config) continue;
    const mv = child(config, "muleVersion"); // direct child only
    const raw = textOf(mv);
    if (raw) return raw;
  }
  return null;
}

// Apply Step-1/Step-2 logic to a single POM's project node.
// ownProps: this POM's own <properties> (used for property PRESENCE check).
// mergedProps: child-then-parent table (used to RESOLVE ${...}).
function detectInProject(project, ownProps, mergedProps) {
  // 1. plugin muleVersion
  const pluginRaw = extractPluginMuleVersion(project);
  if (pluginRaw) {
    const resolved = resolveValue(pluginRaw, mergedProps);
    if (resolved) {
      return { version: resolved, source: "mule-maven-plugin.muleVersion", raw: pluginRaw };
    }
    // unresolved -> fall through
  }
  // 2. runtime property (ordered)
  for (const name of RUNTIME_PROPERTY_NAMES) {
    if (!(name in ownProps)) continue;
    const resolved = resolveValue(ownProps[name], mergedProps);
    if (resolved) {
      return { version: resolved, source: `property:${name}`, raw: ownProps[name] };
    }
    // present but unresolved -> keep checking remaining names
  }
  return null;
}

// ---------------------------------------------------------------------------
// Version comparison (numeric dotted prefix; ignores qualifiers).
// Returns negative / 0 / positive.
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
  const pa = numericParts(a);
  const pb = numericParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
function numericParts(v) {
  const m = String(v).match(/^\d+(?:\.\d+)*/);
  if (!m) return [];
  return m[0].split(".").map(Number);
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
  if (!outPath) outPath = join(projectDir, "tmp", "current-mule-version.json");

  const result = {
    projectDir,
    version: null,          // resolved current Mule Runtime version, or null
    source: null,           // where it came from
    resolvedFrom: null,     // "child" | "parent" | null (needs user prompt)
    needsUserPrompt: false,
    belowFloor: false,      // true if detected version < MIN_SUPPORTED_MULE_VERSION
    minSupportedVersion: MIN_SUPPORTED_MULE_VERSION,
    muleArtifact: {
      present: false,
      minMuleVersion: null,
      consistency: null,    // "ok" | "no-min" | "below-min" | "unknown"
    },
    warnings: [],
    notes: [],
  };

  // --- Read child pom.xml ---
  const childPomPath = join(projectDir, "pom.xml");
  if (!existsSync(childPomPath)) {
    result.warnings.push(`No pom.xml found at ${childPomPath}`);
    result.needsUserPrompt = true;
    return emit(result, outPath);
  }
  const childProject = projectOf(parseXml(readFileSync(childPomPath, "utf8")));
  const childProps = extractProperties(childProject);

  // --- Read parent pom.xml (if any) ---
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
  // Child declares a <parent> we could not load locally. How loud to be about
  // this depends on whether detection actually needed the parent, so defer the
  // message until after resolution (see below).
  const parentDeclaredButMissing = !parentProject && !!child(childProject, "parent");

  // Merged table for ${...} resolution: child wins over parent.
  const mergedProps = { ...parentProps, ...childProps };

  // --- Step 1-2: child POM ---
  let found = detectInProject(childProject, childProps, mergedProps);
  if (found) {
    result.resolvedFrom = "child";
  } else if (parentProject) {
    // --- Step 3: parent POM (own props for presence, merged for resolution) ---
    found = detectInProject(parentProject, parentProps, mergedProps);
    if (found) result.resolvedFrom = "parent";
  }

  if (found) {
    result.version = found.version;
    result.source = found.source;
    if (PROP_REF.test(found.raw || "")) {
      result.notes.push(`Resolved ${found.raw} -> ${found.version}`);
    }
    // Parent was declared but missing, yet we resolved from the child anyway:
    // the missing parent did not matter here, so keep it as a low-key note.
    if (parentDeclaredButMissing) {
      result.notes.push(
        "Child declares a <parent> whose POM was not found locally, but the " +
        "Mule runtime version was resolved from the child pom.xml, so it was not needed."
      );
    }
  } else {
    // --- Step 4: caller must prompt the user ---
    result.needsUserPrompt = true;
    if (parentDeclaredButMissing) {
      // The missing parent is the likely cause: a child ${...} reference or the
      // muleVersion itself may be defined in the parent we could not load. Do NOT
      // attempt to download it — ask the user to make it available locally.
      result.warnings.push(
        "Child declares a <parent>, but the parent POM was not found locally. " +
        "Parent-defined Mule runtime configuration cannot be resolved. Ask the " +
        "user to make the parent POM available locally and re-run."
      );
    } else {
      result.warnings.push(
        "Could not determine Mule Runtime version from child or parent pom.xml. " +
        "Prompt the user for the current version."
      );
    }
  }

  // --- Step 5: cross-check mule-artifact.json ---
  const artifactPath = join(projectDir, "mule-artifact.json");
  if (existsSync(artifactPath)) {
    result.muleArtifact.present = true;
    try {
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
      const min = artifact.minMuleVersion || null;
      result.muleArtifact.minMuleVersion = min;
      if (!min) {
        result.muleArtifact.consistency = "no-min";
      } else if (!result.version) {
        result.muleArtifact.consistency = "unknown";
      } else if (compareVersions(result.version, min) >= 0) {
        result.muleArtifact.consistency = "ok";
      } else {
        result.muleArtifact.consistency = "below-min";
        // Contradiction: the app builds today, so it cannot really run below its
        // own floor. Either the detected version or minMuleVersion is stale. Do
        // not proceed silently — force the caller back to the user to re-confirm.
        result.needsUserPrompt = true;
        result.warnings.push(
          `Detected version ${result.version} is below mule-artifact.json ` +
          `minMuleVersion ${min}. The project configuration appears inconsistent. ` +
          `Please verify the current Mule Runtime version before proceeding.`
        );
      }
    } catch (e) {
      result.warnings.push(`Failed to parse mule-artifact.json: ${e.message}`);
    }
  } else {
    result.muleArtifact.consistency = "unknown";
    result.notes.push("No mule-artifact.json found (will surface at build time).");
  }

  // --- Floor check: skill only upgrades apps already on Mule 4.4+ ---
  // Only meaningful for a detected version; a user-supplied version must be
  // floor-checked by the caller (SKILL.md) after prompting.
  if (result.version && compareVersions(result.version, MIN_SUPPORTED_MULE_VERSION) < 0) {
    result.belowFloor = true;
    result.warnings.push(
      `Detected Mule Runtime version ${result.version} is below the minimum ` +
      `supported version (${MIN_SUPPORTED_MULE_VERSION}). This skill only upgrades ` +
      `apps already on Mule ${MIN_SUPPORTED_MULE_VERSION}+. Upgrade the app to at ` +
      `least ${MIN_SUPPORTED_MULE_VERSION} before running this skill.`
    );
  }

  return emit(result, outPath);
}

function emit(result, outPath) {
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
