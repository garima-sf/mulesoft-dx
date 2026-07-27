#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Step 6 helper — resolve the latest Java-17-compatible version of a
// connector via Exchange metadata (`anypoint-cli-v4 exchange asset list
// / describe` → `.tags[] is-java-17-supported`). Walks from latest
// backward at most 5 releases.
//
// Output on success: tmp/connector-choices/<nick>-new.json.
// Exit codes: 0 hit, 2 no versions, 3 no Java-17 hit in latest 5, 64 usage.
//
// Runs safely in parallel — writes to a unique per-nick file.
import { argv, exit, stderr, stdout } from 'node:process';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { mkdirp } from '../lib/fsx.mjs';
import { runProbe } from '../lib/anypoint.mjs';
import { sortVersionStrings } from '../lib/platform.mjs';

/** @param {string} s @returns {boolean} */
function isUnsafeSegment(s) {
  return !s || s.includes('/') || s.includes('\\') || s.includes('..');
}

const [, , groupId, artifactId, nick] = argv;
if (!groupId || !artifactId || !nick) {
  stderr.write(`usage: ${path.basename(argv[1])} <group_id> <artifact_id> <nick>\n`);
  exit(64);
}
if (isUnsafeSegment(nick)) {
  stderr.write(`❌ unsafe nickname: ${nick}\n`);
  exit(64);
}

const outDir = 'tmp/connector-choices';
mkdirp(outDir);

// 1. Enumerate versions.
const listResult = runProbe('anypoint-cli-v4', [
  'exchange', 'asset', 'list', artifactId,
  '--output', 'json',
  '--limit', '200',
]);
if (listResult.status !== 0) {
  stderr.write(`❌ anypoint-cli-v4 exchange asset list failed (status ${listResult.status})\n`);
  if (listResult.stderr) stderr.write(listResult.stderr);
  exit(1);
}

let assets;
try {
  assets = JSON.parse(listResult.stdout);
} catch (e) {
  stderr.write(`❌ failed to parse asset list JSON: ${e.message}\n`);
  exit(5);
}

// 2. Filter to (assetId, type=extension), sort semver-descending, keep top 5.
const versions = sortVersionStrings(
  (Array.isArray(assets) ? assets : [])
    .filter((a) => a.assetId === artifactId && String(a.type || '').toLowerCase() === 'extension')
    .map((a) => a.version),
).reverse().slice(0, 5);

if (versions.length === 0) {
  const errObj = { error: 'not-found', nick, artifact: artifactId };
  stdout.write(JSON.stringify(errObj) + '\n');
  exit(2);
}

// 3. Walk latest → oldest; describe each; first is-java-17-supported=true wins.
let step = 0;
for (const v of versions) {
  const descResult = runProbe('anypoint-cli-v4', [
    'exchange', 'asset', 'describe', `${groupId}/${artifactId}/${v}`,
    '--output', 'json',
  ]);
  if (descResult.status !== 0) {
    stderr.write(`❌ describe ${groupId}/${artifactId}/${v} failed (status ${descResult.status})\n`);
    if (descResult.stderr) stderr.write(descResult.stderr);
    exit(1);
  }
  let desc;
  try {
    desc = JSON.parse(descResult.stdout);
  } catch (e) {
    stderr.write(`❌ describe JSON parse failed: ${e.message}\n`);
    exit(5);
  }
  const tags = Array.isArray(desc.tags) ? desc.tags : [];
  const j17 = tags.find((t) => t && t.key === 'is-java-17-supported');
  if (j17 && j17.value === 'true') {
    const out = {
      groupId,
      assetId: artifactId,
      version: v,
      java17: 'ok',
      walkback_steps: step,
    };
    const outPath = path.join(outDir, `${nick}-new.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
    stdout.write(`${outPath}\n`);
    exit(0);
  }
  step += 1;
}

// 4. No Java-17 in latest 5 → HALT this connector.
const failObj = { error: 'no-java17-in-latest-5', nick, artifact: artifactId };
stdout.write(JSON.stringify(failObj) + '\n');
exit(3);
