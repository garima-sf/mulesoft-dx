#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Step 4 helper — determine the single recommended upgrade target from the
// current Mule Runtime + Java versions and the live runtime list.
//
// Rules (locked with the skill owner / PM):
//   * Channel is sticky. Never cross channels, even if the other channel offers
//     a higher runtime.
//     - LTS minors are hardcoded (STOPGAP) until the runtime-list API exposes a
//       `channel` field: see LTS_MINORS below. Everything else post-cadence is
//       Edge. 4.4 predates the Edge/LTS cadence and is treated as LTS-lineage
//       (targets the latest LTS).
//   * ONE recommended target: the highest minor in the current channel, at its
//     latest patch, on that runtime's latest non-EOL Java (17 today).
//       - Below the highest minor  -> minor upgrade  (e.g. 4.6.x -> 4.9.19 + 17).
//       - Already on the highest minor -> patch upgrade to its latest patch
//         (e.g. 4.9.5 -> 4.9.19). Patch is ONLY offered on the highest minor.
//   * Java target is always the latest non-EOL Java (Java 8 and 11 are EOL /
//     discouraged and are NEVER an upgrade target). We do not offer a
//     "keep Java 8/11" path — every Mule upgrade also moves Java to 17.
//   * Java-only upgrades are NOT supported yet (revisit when Java 25 ships).
//   * Intermediate minors (e.g. 4.4 -> 4.6) are NOT recommended by default; the
//     agent only pursues one if the user explicitly asks.
//   * Already on the highest minor's latest patch AND latest Java -> nothing to
//     upgrade.
//
// Data sources:
//   * Runtime list + compatibleJDKs — LIVE via `anypoint-cli-v4 dx mule runtime
//     list --output json`. Sole source; no bundled fallback. Each minor's entry
//     is already its latest patch (the CLI returns one row per minor).
//   * Channel (LTS/Edge) — hardcoded LTS_MINORS stopgap (see above), because the
//     runtime-list API does not yet return a channel field.
//
// Usage:
//   node resolve_target_versions.mjs [projectDir]
//   Reads current versions from <projectDir>/tmp/current-mule-version.json and
//   current-java-version.json (Step 2 output), unless overridden by env:
//     CURRENT_MULE=4.6.32 CURRENT_JAVA=8   (for testing all scenarios)
//   Output path: ${TARGET_VERSIONS_FILE} when set, else
//   <projectDir>/tmp/target-versions.json.
//
// Output JSON (file): { currentMule, currentJava, currentMinor, channel,
//   target: { mule, java, kind, muleChanged, javaChanged, note } | null,
//   nothingToUpgrade, runtimeSource, needsUserPrompt, warnings[], notes[] }.
//
// Exit code:
//   0  always — advisory; the caller branches on the fields.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";

process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); });
function log(msg) { process.stdout.write(msg + "\n"); }

// STOPGAP: LTS minors, maintained by hand until the runtime-list API returns a
// `channel` field. Everything else post-cadence is Edge. Update this one list
// when MuleSoft designates a new LTS minor.
const LTS_MINORS = ["4.6", "4.9"];
// 4.4 predates the Edge/LTS cadence; treat it as LTS-lineage per skill owner.
const LEGACY_MINORS = ["4.4"];

// EOL / discouraged Java versions we NEVER recommend as an upgrade target. The
// Java target is always the runtime's latest compatible Java that is NOT in this
// set (17 today). Update when a version reaches EOL (e.g. add "17" once 25 GA's
// and 17 is being sunset).
const DISCOURAGED_JAVA = ["8", "11"];

// --- version helpers -------------------------------------------------------

// "4.9.19" / "4.4.0-20250919" -> "4.9" / "4.4"
function minorOf(version) {
  const m = String(version).match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : null;
}
function numericParts(v) {
  const m = String(v).match(/^\d+(?:\.\d+)*/);
  return m ? m[0].split(".").map(Number) : [];
}
function compareVersions(a, b) {
  const pa = numericParts(a), pb = numericParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
// Java spec number from a JDK entry: description "17" preferred, else parse
// "17.0.13_11" -> "17", "1.8"/"8.0.472_8" -> "8".
function javaSpecOf(jdk) {
  if (jdk && jdk.description) return String(jdk.description).trim();
  const v = String(jdk && jdk.version || "");
  const m18 = v.match(/^1\.(\d+)/);
  if (m18) return m18[1];
  const m = v.match(/^(\d+)/);
  return m ? m[1] : null;
}
function channelOfMinor(minor) {
  if (LEGACY_MINORS.includes(minor)) return "LTS";  // 4.4 -> LTS-lineage
  if (LTS_MINORS.includes(minor)) return "LTS";
  return "Edge";
}

// --- data source -----------------------------------------------------------

function loadRuntimes(result) {
  // Live CLI is the sole source of truth for runtime versions + compatibleJDKs.
  // No bundled fallback — if the call fails, we stop and let the agent surface
  // it rather than reason from stale cached data.
  try {
    const out = execFileSync(
      "anypoint-cli-v4",
      ["dx", "mule", "runtime", "list", "--output", "json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const json = JSON.parse(out.slice(out.indexOf("[")));
    if (Array.isArray(json) && json.length) {
      result.runtimeSource = "runtime-list-cli";
      return json;
    }
    result.warnings.push("`dx mule runtime list` returned no versions.");
  } catch (e) {
    result.warnings.push(
      `Could not fetch the runtime list (${e.message.split("\n")[0]}). ` +
      `Check network/authentication (anypoint-cli-v4 conf) and re-run.`
    );
  }
  return [];
}

// --- current-version inputs ------------------------------------------------

function readCurrent(projectDir, result) {
  let mule = process.env.CURRENT_MULE || null;
  let java = process.env.CURRENT_JAVA || null;
  if (!mule) {
    const p = join(projectDir, "tmp", "current-mule-version.json");
    if (existsSync(p)) { try { mule = JSON.parse(readFileSync(p, "utf8")).version; } catch {} }
  }
  if (!java) {
    const p = join(projectDir, "tmp", "current-java-version.json");
    if (existsSync(p)) { try { java = JSON.parse(readFileSync(p, "utf8")).version; } catch {} }
  }
  if (!mule || !java) {
    result.needsUserPrompt = true;
    if (!mule) result.warnings.push("No current Mule version (run Step 2a or set CURRENT_MULE).");
    if (!java) result.warnings.push("No current Java version (run Step 2b or set CURRENT_JAVA).");
  }
  return { mule, java: java != null ? String(java) : null };
}

// --- core logic ------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  let projectDir = process.cwd();
  for (const a of argv) if (!a.startsWith("--")) projectDir = resolve(a);
  projectDir = resolve(projectDir);
  const outPath = process.env.TARGET_VERSIONS_FILE || join(projectDir, "tmp", "target-versions.json");

  const result = {
    projectDir,
    currentMule: null, currentJava: null, currentMinor: null, channel: null,
    // options[] holds the upgrade paths. The RECOMMENDED path is always the
    // latest Mule (highest minor, latest patch) in the channel + that runtime's
    // latest non-EOL Java. Today exactly one entry survives:
    //   - current Java 8/11 (EOL) -> one "java-and-mule" (moves to latest Java)
    //   - current Java 17+        -> one "mule-only"     (keep Java, bump Mule)
    // A second, distinct option only appears once a newer non-EOL Java ships
    // (e.g. Java 25), when a 17 user could choose keep-17 vs move-to-25.
    // Intermediate minors are NOT shown here — the agent pursues one only if the
    // user explicitly asks.
    options: [],
    // Set only when the user explicitly requested a specific target
    // (TARGET_MULE): { accepted, mule, java, reasonCode, reason }.
    requestedTarget: null,
    nothingToUpgrade: false,
    runtimeSource: null,
    needsUserPrompt: false,
    warnings: [], notes: [],
  };

  const { mule, java } = readCurrent(projectDir, result);
  if (result.needsUserPrompt) return emit(result, outPath);
  result.currentMule = mule;
  result.currentJava = java;
  result.currentMinor = minorOf(mule);
  result.channel = channelOfMinor(result.currentMinor);

  const runtimes = loadRuntimes(result);
  if (!runtimes.length) {
    result.needsUserPrompt = true;
    result.warnings.push("No runtime data available (CLI and fallback both empty).");
    return emit(result, outPath);
  }

  // If the user explicitly asked for a specific target (TARGET_MULE), validate
  // THAT instead of only recommending. We still compute + surface the
  // recommendation below so the agent can show it alongside. Rules:
  //   - target Mule must be strictly higher than current (no downgrade / same;
  //     covers off-channel upgrades too — channel gates recommendation, not
  //     what's allowed).
  //   - target Java must be non-EOL (never keep/select Java 8/11).
  //   - target Mule must support the target Java (buildable combo).
  //   - if no target Java given, pair with the target Mule's latest non-EOL Java.
  const reqMule = process.env.TARGET_MULE || null;
  if (reqMule) {
    result.requestedTarget = validateRequestedTarget(
      reqMule, process.env.TARGET_JAVA || null, mule, runtimes
    );
  }

  // Out-of-matrix guard: if the current minor isn't represented at all, we have
  // no compatibility data to reason from — stop and let the agent ask.
  const knownMinors = new Set(runtimes.map((r) => minorOf(r.version)));
  const currentIsLegacy = LEGACY_MINORS.includes(result.currentMinor);
  if (!knownMinors.has(result.currentMinor) && !currentIsLegacy) {
    result.needsUserPrompt = true;
    result.warnings.push(
      `Current Mule minor ${result.currentMinor} is not in the runtime list; ` +
      `no compatibility data to recommend a target. Ask the user how to proceed.`
    );
    return emit(result, outPath);
  }

  // The recommended target is the highest minor in the channel (at its latest
  // patch — the CLI returns one row per minor, already the latest patch). We
  // include the CURRENT minor as a candidate so a user already on the highest
  // minor can still be moved to its latest patch (patch is only ever offered on
  // the highest minor).
  const sameChannelAtOrAbove = runtimes
    .filter((r) => channelOfMinor(minorOf(r.version)) === result.channel)
    .filter((r) => compareVersions(minorOf(r.version) + ".0", result.currentMinor + ".0") >= 0);

  if (!sameChannelAtOrAbove.length) {
    // No runtime in the channel at/above the current minor — nothing to work
    // with (legacy 4.4 always has higher LTS minors, so this is rare).
    result.nothingToUpgrade = true;
    result.notes.push(`No higher runtime available in your current channel (${result.channel}).`);
    return emit(result, outPath);
  }

  // Highest minor in channel = the recommended Mule target (latest patch of it).
  const highest = sameChannelAtOrAbove
    .slice()
    .sort((a, b) => compareVersions(a.version, b.version))
    .pop();
  const targetMule = highest.version;
  const targetJava = pickLatestNonEolJava(highest);

  if (!targetJava) {
    result.needsUserPrompt = true;
    result.warnings.push(
      `The highest ${result.channel} runtime (${targetMule}) lists no non-EOL ` +
      `Java to upgrade to. Ask the user how to proceed.`
    );
    return emit(result, outPath);
  }

  const muleChanged = compareVersions(targetMule, mule) > 0;
  const javaChanged = String(targetJava) !== String(java);

  // Nothing to upgrade: already on the highest minor's latest patch AND already
  // on the target (latest non-EOL) Java.
  if (!muleChanged && !javaChanged) {
    result.nothingToUpgrade = true;
    result.notes.push(
      `Already on the latest ${result.channel} runtime (${targetMule}) and Java ${targetJava}.`
    );
    return emit(result, outPath);
  }

  // Kind reflects whether Java moves:
  //   - current Java already == target Java  -> "mule-only" (Mule/patch bump).
  //   - current Java is EOL (8/11) or lower   -> "java-and-mule" (Java moves up).
  const kind = javaChanged ? "java-and-mule" : "mule-only";
  const patchOnly = !javaChanged && minorOf(targetMule) === result.currentMinor;

  const option = {
    kind,
    mule: targetMule,
    java: String(targetJava),
    muleChanged,
    javaChanged,
    patchOnly,          // true when this is a same-minor latest-patch bump
    note: null,
  };
  if (DISCOURAGED_JAVA.includes(String(java))) {
    option.note =
      `Java ${java} is end-of-life; the upgrade moves you to the latest ` +
      `supported Java (${targetJava}).`;
  }

  result.options = [option];
  return emit(result, outPath);
}

// Find the runtime-list entry matching a requested Mule version. Accepts an
// exact version (4.9.19) or a bare minor (4.9 -> that minor's latest-patch row).
function findRuntimeForRequest(runtimes, reqMule) {
  const exact = runtimes.find((r) => String(r.version) === String(reqMule));
  if (exact) return exact;
  const wantMinor = minorOf(reqMule);
  const ofMinor = runtimes
    .filter((r) => minorOf(r.version) === wantMinor)
    .sort((a, b) => compareVersions(a.version, b.version));
  return ofMinor.length ? ofMinor[ofMinor.length - 1] : null;
}

// Validate a user-requested target against the locked policy. Returns
// { accepted, mule, java, reasonCode, reason }. reasonCode is one of:
//   downgrade | eol-java | unsupported-combo | unknown-version.
function validateRequestedTarget(reqMule, reqJava, currentMule, runtimes) {
  const rt = findRuntimeForRequest(runtimes, reqMule);
  if (!rt) {
    return {
      accepted: false, mule: reqMule, java: reqJava, reasonCode: "unknown-version",
      reason: `Mule ${reqMule} is not in the runtime list; cannot validate it.`,
    };
  }
  const targetMule = rt.version;

  // Rule 5 (and #2 "upgrades only"): must be strictly higher than current.
  if (compareVersions(targetMule, currentMule) <= 0) {
    return {
      accepted: false, mule: targetMule, java: reqJava, reasonCode: "downgrade",
      reason: `Mule ${targetMule} is not higher than your current ${currentMule}. ` +
              `This skill only upgrades — it never downgrades or re-targets the same version.`,
    };
  }

  // Resolve the Java to pair. If the user gave one, honor+validate it; else pick
  // the target runtime's latest non-EOL Java.
  let targetJava;
  if (reqJava != null && String(reqJava) !== "") {
    // Rule 3: never keep/select an EOL Java.
    if (DISCOURAGED_JAVA.includes(String(reqJava))) {
      return {
        accepted: false, mule: targetMule, java: String(reqJava), reasonCode: "eol-java",
        reason: `Java ${reqJava} is end-of-life. This skill upgrades apps off EOL Java ` +
                `(8/11); pick a supported Java (e.g. ${pickLatestNonEolJava(rt)}).`,
      };
    }
    // Rule 4: target Mule must actually support the requested Java.
    if (!runtimeSupportsJava(rt, reqJava)) {
      return {
        accepted: false, mule: targetMule, java: String(reqJava), reasonCode: "unsupported-combo",
        reason: `Mule ${targetMule} does not support Java ${reqJava}. ` +
                `Supported: ${supportedJavas(rt).join(", ") || "(none)"}.`,
      };
    }
    targetJava = String(reqJava);
  } else {
    targetJava = pickLatestNonEolJava(rt);
    if (!targetJava) {
      return {
        accepted: false, mule: targetMule, java: null, reasonCode: "unsupported-combo",
        reason: `Mule ${targetMule} lists no non-EOL Java to pair with.`,
      };
    }
  }

  return { accepted: true, mule: targetMule, java: String(targetJava), reasonCode: null, reason: null };
}

// Does a runtime list the given Java spec (EOL or not) in its compatibleJDKs?
function runtimeSupportsJava(runtime, javaSpec) {
  return (runtime.compatibleJDKs || []).some((j) => javaSpecOf(j) === String(javaSpec));
}

// Non-EOL Java specs a runtime supports, sorted ascending.
function supportedJavas(runtime) {
  return (runtime.compatibleJDKs || [])
    .map((j) => javaSpecOf(j))
    .filter((s) => s && !DISCOURAGED_JAVA.includes(String(s)))
    .sort((a, b) => compareVersions(a, b));
}

// The latest Java a runtime supports that is NOT EOL/discouraged. Prefers the
// entry flagged `latest`; falls back to the highest non-discouraged spec number.
function pickLatestNonEolJava(runtime) {
  const specs = (runtime.compatibleJDKs || [])
    .map((j) => ({ jdk: j, spec: javaSpecOf(j) }))
    .filter((x) => x.spec && !DISCOURAGED_JAVA.includes(String(x.spec)));
  if (!specs.length) return null;
  const flagged = specs.find((x) => x.jdk.latest);
  if (flagged) return flagged.spec;
  return specs
    .map((x) => x.spec)
    .sort((a, b) => compareVersions(a, b))
    .pop();
}

function emit(result, outPath) {
  if (result.nothingToUpgrade) {
    log(`✅ Already on the latest ${result.channel} runtime (${result.currentMule}) and Java ${result.currentJava} — nothing to upgrade.`);
  } else if (result.needsUserPrompt) {
    log("⚠️  Could not determine an upgrade target — the agent must prompt the user.");
  } else {
    log(`Current: Mule ${result.currentMule} (${result.channel}), Java ${result.currentJava}`);
    log(`Recommended (${result.channel}, latest in channel):`);
    for (const o of result.options) {
      const label = o.kind === "java-and-mule" ? "Java + Mule" : "Mule-only";
      const patch = o.patchOnly ? " (latest patch)" : "";
      log(`  • ${label}: Mule ${o.mule}, Java ${o.java}${patch}`);
      if (o.note) log(`      ${o.note}`);
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
  return result;
}

main();
