#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Step 1 helper — validate filesystem and toolchain prerequisites: app directory
// (pom.xml + mule-artifact.json), parent-POM availability if declared, Anypoint
// CLI v4, DX plugin. Validation-only; never prompts or mutates.
//
// Usage:
//   node validate_prerequisites.mjs [projectDir]
//   Default projectDir = cwd. Output path: ${UPGRADE_PREREQS_FILE} when set,
//   otherwise <projectDir>/tmp/upgrade-prereqs.json.
//
// Output JSON (file): { ok, inAppDir, pomExists, muleArtifactExists,
//   parentDeclared, parentFound, parentPath, cliPresent, dxPluginPresent,
//   errors[], warnings[], notes[] }. `ok` is true when errors[] is empty.
//   Exit code: 1 when errors[] is non-empty.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { readPomProject, child, findParentPomPath } from "./_pom_utils.mjs";

// Don't crash if a downstream consumer (e.g. `head`) closes stdout early.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

function log(msg) {
  process.stdout.write(msg + "\n");
}

// Run a command, capturing both streams.
function tryExec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: "", error: r.error.message };
  const combined = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { ok: r.status === 0, out: combined };
}

function main() {
  const argv = process.argv.slice(2);
  let projectDir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) projectDir = resolve(argv[i]);
  }
  projectDir = resolve(projectDir);
  const outPath = process.env.UPGRADE_PREREQS_FILE || join(projectDir, "tmp", "upgrade-prereqs.json");

  const result = {
    ok: false,          // true when errors[] is empty (set in emit)
    projectDir,
    inAppDir: false,
    pomExists: false,
    muleArtifactExists: false,
    parentDeclared: false,
    parentFound: false,
    parentPath: null,
    cliPresent: false,
    dxPluginPresent: false,
    errors: [],
    warnings: [],
    notes: [],
  };

  log(`Validating prerequisites in ${projectDir}...`);

  // App directory: child pom.xml + mule-artifact.json.
  const childPomPath = join(projectDir, "pom.xml");
  const artifactPath = join(projectDir, "mule-artifact.json");
  result.pomExists = existsSync(childPomPath);
  result.muleArtifactExists = existsSync(artifactPath);
  if (result.pomExists) {
    log("✅ pom.xml found");
  } else {
    log("❌ pom.xml not found");
    result.errors.push(`pom.xml not found at ${childPomPath}. Run from the Mule application root.`);
  }
  if (result.muleArtifactExists) {
    log("✅ mule-artifact.json found");
  } else {
    log("❌ mule-artifact.json not found");
    result.errors.push(`mule-artifact.json not found at ${artifactPath}. Run from the Mule application root.`);
  }
  result.inAppDir = result.pomExists && result.muleArtifactExists;

  // Parent POM availability (only if the child POM parsed).
  if (result.pomExists) {
    try {
      const childProject = readPomProject(childPomPath);
      result.parentDeclared = !!child(childProject, "parent");
      if (result.parentDeclared) {
        const parentPath = findParentPomPath(childProject, childPomPath);
        if (parentPath) {
          result.parentFound = true;
          result.parentPath = parentPath;
          log(`✅ Parent POM found: ${parentPath}`);
        } else {
          result.parentFound = false;
          log("❌ Parent POM declared but not found locally");
          result.errors.push(
            "Child pom.xml declares a <parent>, but the parent POM was not found " +
            "at a local relative path (from <parent><relativePath>, or the default " +
            "../pom.xml). It is required for version detection and for Phase 2 edits " +
            "(inherited connector/plugin versions). Ask the user to make the parent " +
            "POM available locally and re-run. Do NOT download it."
          );
        }
      }
    } catch (e) {
      log("❌ Failed to parse pom.xml");
      result.errors.push(`Failed to parse pom.xml: ${e.message}`);
    }
  }

  // Anypoint CLI v4 + DX plugin.
  const cli = tryExec("anypoint-cli-v4", ["--version"]);
  result.cliPresent = cli.ok;
  if (!cli.ok) {
    log("❌ anypoint-cli-v4 not found");
    result.errors.push("anypoint-cli-v4 not found. Install: npm install -g @mulesoft/anypoint-cli-v4");
  } else {
    log("✅ anypoint-cli-v4 found");
    const dx = tryExec("anypoint-cli-v4", ["dx", "--help"]);
    result.dxPluginPresent = dx.ok;
    if (!dx.ok) {
      log("❌ DX plugin not found");
      result.errors.push("DX plugin not found. Install: npm install -g @salesforce/anypoint-cli-dx-mule-plugin");
    } else {
      log("✅ DX plugin found");
    }
  }

  return emit(result, outPath);
}

function emit(result, outPath) {
  result.ok = result.errors.length === 0;
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    result.outPath = outPath;
    log(`Saved to ${outPath}`);
  } catch (e) {
    result.warnings.push(`Failed to write ${outPath}: ${e.message}`);
    log(`⚠️  Failed to write ${outPath}: ${e.message}`);
  }
  if (result.errors.length > 0) {
    log("\nPrerequisite check FAILED. Resolve these before continuing:");
    for (const err of result.errors) log(`  • ${err}`);
    process.exitCode = 1;
  }
  return result;
}

main();
