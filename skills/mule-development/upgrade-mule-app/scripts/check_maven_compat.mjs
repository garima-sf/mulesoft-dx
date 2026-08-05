#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Step 3c pre-build guard — verify the LOCAL Maven version is compatible with the
// app's CURRENT `mule-maven-plugin` before the baseline build runs, and hard-stop
// with a clear fix-it message when it is not. Validation-only: never prompts,
// downloads, or mutates the project.
//
// Why this guard exists: `mule-maven-plugin` 3.x was built against Maven 3.8's
// Eclipse Aether (org.eclipse.aether.*). Maven 3.9 replaced Aether with Maven
// Resolver 1.9, so a 3.x plugin crashes on Maven >= 3.9 with a cryptic
//   NoClassDefFoundError: org/eclipse/aether/connector/basic/BasicRepositoryConnectorFactory
// The baseline build (Step 3c) runs on the app's CURRENT (pre-upgrade) plugin,
// which for Mule 4.3/4.4 apps is on the 3.x line — so this mismatch bites at plan
// time on developer machines whose `mvn` is 3.9+. Catch it here with an
// actionable message instead of letting the packaging phase fail obscurely.
// (Mirrors the Step 3b/Phase-2 Java gate: caught immediately, not steps later.)
//
// Usage:
//   node check_maven_compat.mjs [projectDir]
//   Default projectDir = cwd. Output path: ${MAVEN_COMPAT_FILE} when set,
//   otherwise <projectDir>/tmp/maven-compat.json.
//
// Output JSON (file): { mavenVersion, mavenMajor, mavenMinor, pluginVersion,
//   pluginMajor, pluginDefinedIn, compatible, errors[], warnings[], notes[] }.
//   Exit code: 1 when errors[] is non-empty (incompatible or Maven not found).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import {
  parseXml,
  projectOf,
  child,
  children,
  textOf,
  extractProperties,
  resolveValue,
  findParentPomPath,
  readPomProject,
} from "./_pom_utils.mjs";

// Don't crash if a downstream consumer (e.g. `head`) closes stdout early.
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });

function log(msg) {
  process.stdout.write(msg + "\n");
}

const MMP_GROUP_ID = "org.mule.tools.maven";
const MMP_ARTIFACT_ID = "mule-maven-plugin";

// --- helpers ---------------------------------------------------------------

function tryExec(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: "", status: null, error: r.error.message };
  const combined = `${r.stdout || ""}${r.stderr || ""}`;
  return { ok: r.status === 0, out: combined, status: r.status };
}

// Parse "Apache Maven 3.8.8 (...)" from `mvn -v` output. Returns { major, minor,
// patch, version } or null.
function parseMavenVersion(out) {
  const m = /Apache Maven\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(out);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] ? Number(m[3]) : 0,
    version: `${m[1]}.${m[2]}${m[3] ? "." + m[3] : ""}`,
  };
}

// Find the mule-maven-plugin version in ONE project's <build><plugins> or
// <build><pluginManagement><plugins>, resolving ${...} against mergedProps.
function pluginVersionIn(project, mergedProps) {
  const build = child(project, "build");
  if (!build) return null;
  const scanPluginsUnder = (parent) => {
    const plugins = parent ? child(parent, "plugins") : null;
    if (!plugins) return null;
    for (const p of children(plugins, "plugin")) {
      if (textOf(child(p, "artifactId")) !== MMP_ARTIFACT_ID) continue;
      const gid = textOf(child(p, "groupId"));
      if (gid && gid !== MMP_GROUP_ID) continue;
      const rawV = textOf(child(p, "version"));
      const resolved = rawV ? resolveValue(rawV, mergedProps) : null;
      if (resolved) return resolved;
    }
    return null;
  };
  return scanPluginsUnder(build) || scanPluginsUnder(child(build, "pluginManagement"));
}

// Numeric major of a version string ("3.3.5" -> 3, "4.9.0" -> 4). null if unparsable.
function majorOf(v) {
  const m = String(v).match(/^(\d+)/);
  return m ? Number(m[1]) : null;
}

function main() {
  const argv = process.argv.slice(2);
  let projectDir = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) projectDir = resolve(argv[i]);
  }
  projectDir = resolve(projectDir);
  const outPath = process.env.MAVEN_COMPAT_FILE || join(projectDir, "tmp", "maven-compat.json");

  const result = {
    projectDir,
    mavenVersion: null,
    mavenMajor: null,
    mavenMinor: null,
    pluginVersion: null,
    pluginMajor: null,
    pluginDefinedIn: null,
    compatible: false,
    errors: [],
    warnings: [],
    notes: [],
  };

  // 1. Local Maven version (the toolchain that will run the build).
  const mvn = tryExec("mvn", ["-v"]);
  const parsed = mvn.ok ? parseMavenVersion(mvn.out) : null;
  if (!parsed) {
    result.errors.push(
      "Could not determine the local Maven version. Ensure `mvn` is on PATH and " +
      "`mvn -v` reports an 'Apache Maven x.y.z' line, then re-run."
    );
    return emit(result, outPath);
  }
  result.mavenVersion = parsed.version;
  result.mavenMajor = parsed.major;
  result.mavenMinor = parsed.minor;

  // 2. The app's CURRENT mule-maven-plugin version (child, then local parent chain).
  const childPomPath = join(projectDir, "pom.xml");
  if (!existsSync(childPomPath)) {
    result.errors.push(`No pom.xml found at ${childPomPath}. Run from the Mule application root.`);
    return emit(result, outPath);
  }
  const childProject = projectOf(parseXml(readFileSync(childPomPath, "utf8")));

  // Build the parent chain and a merged property table (nearer wins) so a
  // ${mule.maven.plugin.version} defined on any ancestor resolves.
  const chain = [{ project: childProject, path: childPomPath }];
  const seen = new Set([childPomPath]);
  let cur = childProject;
  let curPath = childPomPath;
  while (true) {
    const nextPath = findParentPomPath(cur, curPath);
    if (!nextPath || seen.has(nextPath)) break;
    seen.add(nextPath);
    let nextProject;
    try {
      nextProject = readPomProject(nextPath);
    } catch (e) {
      result.warnings.push(`Failed to read parent POM ${nextPath}: ${e.message}`);
      break;
    }
    chain.push({ project: nextProject, path: nextPath });
    cur = nextProject;
    curPath = nextPath;
  }
  const mergedProps = {};
  for (let i = chain.length - 1; i >= 0; i--) Object.assign(mergedProps, extractProperties(chain[i].project));

  for (const { project, path } of chain) {
    const v = pluginVersionIn(project, mergedProps);
    if (v) {
      result.pluginVersion = v;
      result.pluginDefinedIn = path;
      break;
    }
  }

  if (!result.pluginVersion) {
    // No explicit plugin version found locally (may be inherited from a remote
    // parent). Can't assess — warn, don't block; the build will surface a real
    // problem if there is one.
    result.compatible = true;
    result.warnings.push(
      "Could not find an explicit mule-maven-plugin <version> in the pom.xml or its " +
      "local parent chain (it may be inherited from a remote parent). Skipping the " +
      "Maven-compatibility check; if the build fails with a " +
      "'BasicRepositoryConnectorFactory' NoClassDefFoundError, use Maven 3.8.x."
    );
    return emit(result, outPath);
  }
  result.pluginMajor = majorOf(result.pluginVersion);

  // 3. Assess compatibility.
  const mavenIsGte39 = parsed.major > 3 || (parsed.major === 3 && parsed.minor >= 9);
  if (result.pluginMajor === 3 && mavenIsGte39) {
    // The reported crash: 3.x plugin (Aether) on Maven 3.9+ (Maven Resolver).
    result.compatible = false;
    result.errors.push(
      `Incompatible toolchain: this app uses mule-maven-plugin ${result.pluginVersion} ` +
      `(3.x line), but the local Maven is ${result.mavenVersion}. The 3.x plugin was ` +
      `built against Maven 3.8's Eclipse Aether and crashes on Maven 3.9+ with ` +
      `"NoClassDefFoundError: org/eclipse/aether/connector/basic/BasicRepositoryConnectorFactory". ` +
      `Fix: build this baseline with Maven 3.8.x — install a 3.8.x distribution and put ` +
      `its bin/ first on PATH for this session, e.g. ` +
      `PATH="/path/to/apache-maven-3.8.8/bin:$PATH" mvn -v (should report 3.8.x), then re-run Step 3c. ` +
      `(Post-upgrade builds use plugin 4.9.x, which requires Maven 3.9.x — so this only ` +
      `applies to the baseline build on the current plugin.)`
    );
    return emit(result, outPath);
  }
  if (result.pluginMajor >= 4 && parsed.major === 3 && parsed.minor < 9) {
    // Inverse mismatch: 4.x+ plugin wants Maven 3.9.x. Warn (rarely the baseline case).
    result.compatible = true;
    result.warnings.push(
      `mule-maven-plugin ${result.pluginVersion} (4.x+) expects Maven 3.9.x, but the ` +
      `local Maven is ${result.mavenVersion}. If the build fails, upgrade Maven to 3.9.x.`
    );
    return emit(result, outPath);
  }

  result.compatible = true;
  result.notes.push(
    `mule-maven-plugin ${result.pluginVersion} is compatible with Maven ${result.mavenVersion}.`
  );
  return emit(result, outPath);
}

function emit(result, outPath) {
  if (result.compatible && result.errors.length === 0) {
    if (result.pluginVersion) {
      log(`✅ Maven ${result.mavenVersion} is compatible with mule-maven-plugin ${result.pluginVersion}.`);
    } else {
      log(`⚠️  Maven ${result.mavenVersion || "?"} — plugin version not resolved; compatibility check skipped.`);
    }
  }
  for (const w of result.warnings) log(`   • ${w}`);

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
    log("\nMaven compatibility check FAILED:");
    for (const err of result.errors) log(`  • ${err}`);
    process.exitCode = 1;
  }
  return result;
}

main();
