#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill (formerly upgrade-mule-connector).
//
// Phase A.5 helper — gate the upgrade on connector×Java compatibility.
// Reads tmp/connector-metadata/<nick>-new.json and compares
// `.supportedJavaVersions` (or vendor-alt locations) to the target Java.
//
// Emits a JSON verdict to stdout. Exit codes: 0 for ok|warn, 2 for block.
//
// Usage:
//   node scripts/check_java_compatibility.mjs <nickname> <target-java-version>
import { argv, exit, env, stderr, stdout } from 'node:process';
import path from 'node:path';
import { readJson, isFile } from '../lib/fsx.mjs';

/** @param {string} s @returns {boolean} */
function isUnsafeSegment(s) {
  return !s || s.includes('/') || s.includes('\\') || s.includes('..');
}

function usage() {
  stderr.write(`Usage: ${path.basename(argv[1])} <nickname> <target-java-version>\n`);
  stderr.write('  e.g. check_java_compatibility.mjs file 17\n');
}

const [, , nickname, targetJava] = argv;
if (!nickname || !targetJava) {
  usage();
  exit(1);
}
if (isUnsafeSegment(nickname)) {
  stderr.write(`❌ unsafe nickname: ${nickname}\n`);
  exit(1);
}

// Accept `sfdc` or `sfdc-new`; strip trailing `-new` so lookups don't
// double-suffix as `sfdc-new-new.json`. See DRAWBACKS.md #16.
const baseNick = nickname.endsWith('-new') ? nickname.slice(0, -4) : nickname;
const metadataDir = env.CONNECTOR_METADATA_DIR || 'tmp/connector-metadata';
const meta = path.join(metadataDir, `${baseNick}-new.json`);
if (!isFile(meta)) {
  stderr.write(`❌ missing ${meta} — run describe_connector.mjs ${baseNick}-new first\n`);
  exit(1);
}

let modeA;
try {
  modeA = readJson(meta);
} catch (e) {
  stderr.write(`❌ could not parse ${meta}: ${e.message}\n`);
  exit(1);
}

// supportedJavaVersions may live at .supportedJavaVersions or a vendor
// alt path — mirror the bash jq alternation exactly.
const rawWindow = modeA.supportedJavaVersions
  ?? modeA.extensionModel?.supportedJavaVersions
  ?? modeA.describe?.supportedJavaVersions
  ?? [];

/** @param {any} v @returns {string} */
function normalize(v) {
  const s = String(v);
  return s.startsWith('1.') ? s.split('.')[1] || s : s;
}

const window = Array.isArray(rawWindow) ? rawWindow.map(normalize) : [];

let verdict;
if (window.length === 0) {
  verdict = {
    status: 'warn',
    connector: baseNick,
    target_java: targetJava,
    supported: [],
    note: 'connector describe did not report supportedJavaVersions — proceed with -Dmule.jvm.version.extension.enforcement=LOOSE at describe-time; runtime deploy behavior unknown',
  };
} else if (window.includes(targetJava)) {
  verdict = {
    status: 'ok',
    connector: baseNick,
    target_java: targetJava,
    supported: window,
  };
} else {
  verdict = {
    status: 'warn',
    connector: baseNick,
    target_java: targetJava,
    supported: window,
    note: 'target Java is not in the connectors declared window; LOOSE flag tolerated the describe, but the runtime may reject on deploy. Bump the connector to a newer version if one exists.',
  };
}

stdout.write(JSON.stringify(verdict, null, 2) + '\n');

if (verdict.status === 'block') exit(2);
exit(0);
