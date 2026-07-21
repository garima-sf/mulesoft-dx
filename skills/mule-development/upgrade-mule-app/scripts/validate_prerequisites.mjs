#!/usr/bin/env node
// validate-prerequisites.mjs
//
// Step 1 — deterministic prerequisite validation for the upgrade-mule-app
// skill. Checks only facts about the filesystem and toolchain; it never
// prompts and never mutates the project. The caller (SKILL.md Step 1) reads
// the result and STOPs if `errors[]` is non-empty.
//
// Checks:
//   - in an app directory (child pom.xml + mule-artifact.json present)
//   - parent POM: if the child declares <parent>, is it resolvable locally?
//   - toolchain: JAVA_HOME set, `java -version` works, Anypoint CLI v4 present,
//     DX plugin present.
//
// Usage:
//   node validate-prerequisites.mjs [projectDir] [--out <file>]
//
// Default projectDir = cwd. Default out = <projectDir>/tmp/upgrade-prereqs.json
// Exits non-zero when `errors[]` is non-empty (mirrors build-mule-integration's
// validate_prerequisites.sh contract), and always writes/prints the result.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { readPomProject, child, findParentPomPath } from "./_pom_utils.mjs";

function tryExec(cmd, args) {
  // Capture BOTH streams; many CLIs (notably `java -version`) print to stderr.
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: "", error: r.error.message };
  const combined = `${r.stdout || ""}${r.stderr || ""}`.trim();
  return { ok: r.status === 0, out: combined };
}

// Parse a `java -version` string (which prints to stderr) into a spec number.
//   'openjdk version "1.8.0_402"' -> "8"
//   'openjdk version "17.0.10"'   -> "17"
function parseJavaVersion(text) {
  if (!text) return null;
  const m = text.match(/version\s+"([^"]+)"/i);
  if (!m) return null;
  const v = m[1];
  const legacy = v.match(/^1\.(\d+)/);
  if (legacy) return legacy[1];
  const modern = v.match(/^(\d+)/);
  return modern ? modern[1] : null;
}

function main() {
  const argv = process.argv.slice(2);
  let projectDir = process.cwd();
  let outPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") outPath = argv[++i];
    else if (!argv[i].startsWith("--")) projectDir = resolve(argv[i]);
  }
  projectDir = resolve(projectDir);
  if (!outPath) outPath = join(projectDir, "tmp", "upgrade-prereqs.json");

  const result = {
    projectDir,
    inAppDir: false,
    pomExists: false,
    muleArtifactExists: false,
    parentDeclared: false,
    parentFound: false,
    parentPath: null,
    javaHome: process.env.JAVA_HOME || null,
    javaVersion: null,
    cliPresent: false,
    dxPluginPresent: false,
    errors: [],
    warnings: [],
    notes: [],
  };

  // --- App directory: child pom.xml + mule-artifact.json ---
  const childPomPath = join(projectDir, "pom.xml");
  const artifactPath = join(projectDir, "mule-artifact.json");
  result.pomExists = existsSync(childPomPath);
  result.muleArtifactExists = existsSync(artifactPath);
  if (!result.pomExists) {
    result.errors.push(`pom.xml not found at ${childPomPath}. Run from the Mule application root.`);
  }
  if (!result.muleArtifactExists) {
    result.errors.push(`mule-artifact.json not found at ${artifactPath}. Run from the Mule application root.`);
  }
  result.inAppDir = result.pomExists && result.muleArtifactExists;

  // --- Parent POM availability (only meaningful if the child POM parsed) ---
  if (result.pomExists) {
    try {
      const childProject = readPomProject(childPomPath);
      result.parentDeclared = !!child(childProject, "parent");
      if (result.parentDeclared) {
        const parentPath = findParentPomPath(childProject, childPomPath);
        if (parentPath) {
          result.parentFound = true;
          result.parentPath = parentPath;
        } else {
          result.parentFound = false;
          result.errors.push(
            "Child pom.xml declares a <parent>, but the parent POM was not found " +
            "locally (workspace or ~/.m2). It is required for version detection and " +
            "for Phase 2 edits (inherited connector/plugin versions). Ask the user " +
            "to make the parent POM available locally and re-run. Do NOT download it."
          );
        }
      }
    } catch (e) {
      result.errors.push(`Failed to parse pom.xml: ${e.message}`);
    }
  }

  // --- JAVA_HOME + java -version ---
  // Prefer the JDK that JAVA_HOME points at (that is what the build uses), so
  // the version we report and enforce is authoritative rather than whatever
  // `java` happens to be first on PATH.
  let javaBin = "java";
  if (!result.javaHome) {
    result.errors.push("JAVA_HOME is not set. Set it to a JDK 8+ install.");
  } else {
    const homeJava = join(result.javaHome, "bin", "java");
    if (existsSync(homeJava)) {
      javaBin = homeJava;
    } else {
      result.errors.push(
        `JAVA_HOME is set to ${result.javaHome}, but ${homeJava} does not exist. ` +
        "Point JAVA_HOME at a valid JDK 8+ install."
      );
    }
  }
  const java = tryExec(javaBin, ["-version"]);
  if (java.ok || java.out) {
    result.javaVersion = parseJavaVersion(java.out);
  }
  if (!result.javaVersion) {
    result.errors.push("`java -version` did not report a usable Java version. Ensure a JDK is on PATH / JAVA_HOME.");
  } else if (Number(result.javaVersion) < 8) {
    result.errors.push(
      `Java ${result.javaVersion} is below the minimum supported version (JDK 8+). ` +
      "Install and point JAVA_HOME at JDK 8 or newer."
    );
  }

  // --- Anypoint CLI v4 + DX plugin ---
  const cli = tryExec("anypoint-cli-v4", ["--version"]);
  result.cliPresent = cli.ok;
  if (!cli.ok) {
    result.errors.push("anypoint-cli-v4 not found. Install: npm install -g @mulesoft/anypoint-cli-v4");
  } else {
    const dx = tryExec("anypoint-cli-v4", ["dx", "--help"]);
    result.dxPluginPresent = dx.ok;
    if (!dx.ok) {
      result.errors.push("DX plugin not found. Install: npm install -g @salesforce/anypoint-cli-dx-mule-plugin");
    }
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
  if (result.errors.length > 0) process.exitCode = 1;
  return result;
}

main();
