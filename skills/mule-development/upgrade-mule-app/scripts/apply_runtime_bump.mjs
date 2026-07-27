#!/usr/bin/env node
//
// Copyright (c) 2026, Salesforce, Inc.
// All rights reserved.
// For full license text, see the LICENSE.txt file
//
// Part of upgrade-mule-app skill.
//
// Phase D.5 helper — deterministic Mule runtime + Java bumps to pom.xml
// and mule-artifact.json. Reads tmp/upgrade-targets.json (Phase A) and
// tmp/mule-dev-env.json (validate_prerequisites.sh output).
//
// Exit 0 on success, 1 for missing/malformed inputs, 2 for JAVA_HOME
// mismatch (caller surfaces the fix instruction).
//
// Usage:
//   node scripts/apply_runtime_bump.mjs [<project-dir>]
import { argv, exit, env, stderr, stdout } from 'node:process';
import path from 'node:path';
import { readJson, isFile } from '../lib/fsx.mjs';
import {
  editPomRuntime,
  editMuleArtifact,
  checkJavaHome,
  muleMavenPluginFor,
} from '../lib/pom-edit.mjs';

const projectDir = argv[2] || '.';

const targetsFile = env.UPGRADE_TARGETS_FILE || 'tmp/upgrade-targets.json';
const envFile = env.MULE_DEV_ENV_FILE || 'tmp/mule-dev-env.json';

if (!isFile(targetsFile)) {
  stderr.write(`❌ missing ${targetsFile} — write this in Phase A of the skill\n`);
  exit(1);
}

let targets;
try {
  targets = readJson(targetsFile);
} catch (e) {
  stderr.write(`❌ failed to parse ${targetsFile}: ${e.message}\n`);
  exit(1);
}

const targetMule = targets?.mule?.to;
const targetJava = targets?.java?.to;
if (!targetMule || !targetJava) {
  stderr.write(`❌ ${targetsFile} is missing mule.to or java.to\n`);
  exit(1);
}

const log = [];
editPomRuntime(path.join(projectDir, 'pom.xml'), targetMule, targetJava, log);
editMuleArtifact(path.join(projectDir, 'mule-artifact.json'), targetMule, targetJava, log);

const javaCheck = checkJavaHome(envFile, targetJava);

const summary = {
  targets: {
    mule: targetMule,
    java: targetJava,
    mule_maven_plugin: muleMavenPluginFor(targetMule),
  },
  applied: log,
  java_home_check: javaCheck,
};
stdout.write(JSON.stringify(summary, null, 2) + '\n');

exit(javaCheck.status === 'mismatch' ? 2 : 0);
