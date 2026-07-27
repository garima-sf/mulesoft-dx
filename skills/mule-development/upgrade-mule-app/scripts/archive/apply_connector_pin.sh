#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill.
#
# Phase D.6 helper — deterministic connector version + XSD bump.
#
# Reads tmp/connector-choices/<nick>-new.json (NEW GAV) and
# tmp/connector-metadata/<nick>-new.json (namespace/XSD URLs) and rewrites:
#   pom.xml — <version> tag for matching groupId:artifactId
#   src/main/mule/*.xml — xsi:schemaLocation URL pairs for the connector namespace
#
# All mutation is Python; sed is fragile on XML.
#
# Usage:
#   scripts/apply_connector_pin.sh <nickname> [<project-dir>]
#
# Reads:
#   tmp/connector-choices/<nick>-new.json
#   tmp/connector-metadata/<nick>-new.json
#   tmp/upgrade-targets.json (optional, for OLD version)
#
# Effect:
#   Rewrites pom.xml + src/main/mule/*.xml in place.
set -euo pipefail

NICKNAME="${1:-}"
PROJECT_DIR="${2:-.}"

if [ -z "$NICKNAME" ]; then
    echo "Usage: $0 <nickname> [<project-dir>]" >&2
    echo "  e.g. $0 s3" >&2
    exit 1
fi

CHOICE_FILE="${PROJECT_DIR}/tmp/connector-choices/${NICKNAME}-new.json"
METADATA_FILE="${PROJECT_DIR}/tmp/connector-metadata/${NICKNAME}-new.json"

if [ ! -f "$CHOICE_FILE" ]; then
    echo "❌ missing $CHOICE_FILE — run Phase C to write connector choices" >&2
    exit 1
fi

if [ ! -f "$METADATA_FILE" ]; then
    echo "❌ missing $METADATA_FILE — run describe_connector.sh for $NICKNAME" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python"

"$PY" "$SCRIPT_DIR/_apply_connector_pin.py" \
    --nick "$NICKNAME" \
    --project-dir "$PROJECT_DIR"
