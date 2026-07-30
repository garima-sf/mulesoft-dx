#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Phase D.6 helper — deterministic connector version + XSD bump.
// Reads:
//   tmp/connector-choices/<nick>-new.json     (NEW GAV)
//   tmp/connector-metadata/<nick>-new.json    (namespace metadata)
// Rewrites:
//   pom.xml — <version> for matching groupId+artifactId
//   src/main/mule/*.xml — xsi:schemaLocation pairs for the connector namespace
//
// Usage:
//   node scripts/apply_connector_pin.mjs <nickname> [<project-dir>]
//
// Exit 0 on success.
import { argv, exit, stderr, stdout } from 'node:process';
import path from 'node:path';
import { readJson, isFile } from '../lib/fsx.mjs';
import { editPomDependency, editFlowXsdUrls } from '../lib/pom-edit.mjs';

/** @param {string} s @returns {boolean} */
function isUnsafeSegment(s) {
  return !s || s.includes('/') || s.includes('\\') || s.includes('..');
}

const [, , nickname, rawProjectDir] = argv;
if (!nickname) {
  stderr.write(`Usage: ${path.basename(argv[1])} <nickname> [<project-dir>]\n`);
  stderr.write('  e.g. apply_connector_pin.mjs s3\n');
  exit(1);
}
if (isUnsafeSegment(nickname)) {
  stderr.write(`❌ unsafe nickname: ${nickname}\n`);
  exit(1);
}
const projectDir = rawProjectDir || '.';

const choiceFile = path.join(projectDir, 'tmp/connector-choices', `${nickname}-new.json`);
const metadataFile = path.join(projectDir, 'tmp/connector-metadata', `${nickname}-new.json`);

if (!isFile(choiceFile)) {
  stderr.write(`❌ missing ${choiceFile} — run Phase C to write connector choices\n`);
  exit(1);
}

let gav;
// metadata is OPTIONAL: pom-only connectors (no flow usage, so no Mode-A describe)
// get a choices file but no metadata file. editFlowXsdUrls is null-safe and no-ops
// the XSD rewrite when metadata is null — the pom <version> bump only needs the GAV.
let metadata = null;
try {
  gav = readJson(choiceFile);
} catch (e) {
  stderr.write(`❌ failed to parse ${choiceFile}: ${e.message}\n`);
  exit(1);
}
if (isFile(metadataFile)) {
  try {
    metadata = readJson(metadataFile);
  } catch (e) {
    stderr.write(`❌ failed to parse ${metadataFile}: ${e.message}\n`);
    exit(1);
  }
}

const pomLog = [];
const xsdLog = [];

editPomDependency(path.join(projectDir, 'pom.xml'), gav, pomLog);
editFlowXsdUrls(projectDir, nickname, metadata, xsdLog);

const summary = {
  nick: nickname,
  pom_edits: pomLog,
  xsd_edits: xsdLog,
};
stdout.write(JSON.stringify(summary, null, 2) + '\n');
exit(0);
