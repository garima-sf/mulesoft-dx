#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill.
#
# Phase D.5 helper — deterministic runtime + Java bumps.
#
# Reads tmp/upgrade-targets.json (written in Phase A) and rewrites:
#   pom.xml — <app.runtime>, <javaVersion>, <maven.compiler.source/target>,
#             <mule.maven.plugin.version>
#   mule-artifact.json — minMuleVersion, javaSpecificationVersions
#
# JAVA_HOME check: reads tmp/mule-dev-env.json (from validate_prerequisites.sh).
# If the running Java version doesn't match the target, exit 2 with the
# fix instruction in the summary — the skill hands that instruction to
# the user; the script never mutates shell state.
#
# All XML/JSON mutation is Python; sed is fragile on pom.xml.
#
# Usage:
#   scripts/apply_runtime_bump.sh [<project-dir>]
#
# Reads:
#   tmp/upgrade-targets.json
#   tmp/mule-dev-env.json         (via check_java_home)
#
# Effect:
#   Rewrites pom.xml + mule-artifact.json in place.
set -euo pipefail

PROJECT_DIR="${1:-.}"

TARGETS_FILE="${UPGRADE_TARGETS_FILE:-tmp/upgrade-targets.json}"
ENV_FILE="${MULE_DEV_ENV_FILE:-tmp/mule-dev-env.json}"

if [ ! -f "$TARGETS_FILE" ]; then
    echo "❌ missing $TARGETS_FILE — write this in Phase A of the skill" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python"

"$PY" "$SCRIPT_DIR/_apply_runtime_bump.py" \
    --targets "$TARGETS_FILE" \
    --project-dir "$PROJECT_DIR" \
    --env-file "$ENV_FILE"
