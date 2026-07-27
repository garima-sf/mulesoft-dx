#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill.
#
# Phase E helper — promote every `<nick>-new` draft in
# tmp/connector-choices/ to the pinned tmp/connector-versions/<nick>.json
# location that Phase E's validate_before_build.sh reads.
#
# Why this skill needs its own promotion script (not build-mule-integration's
# commit_connectors.sh):
#
#   The upgrade skill uses the `<nick>-new` naming convention to distinguish
#   the Exchange pick from the OLD-side installed dependency. commit_connectors.sh
#   copies file names verbatim — so `s3-new.json` ends up as `s3-new.json` in
#   the versions dir, but downstream consumers (`describe_connector.sh <nick>`
#   without `-new`, `validate_before_build.sh`) read `s3.json`. Every multi-
#   connector run has needed a manual `cp` to bridge the gap. This script
#   strips a trailing `-new` from the basename before writing to VERSIONS_DIR.
#
#   build-mule-integration itself uses bare nicks with no `-new` suffix, so
#   we do NOT touch its commit_connectors.sh; instead we ship a local
#   promoter here that only the upgrade skill invokes. See
#   DRAWBACKS.md #5 for the incident.
#
# Usage:
#   scripts/promote_new_connector_pins.sh
#
# Exit code:
#   0  one or more drafts promoted
#   1  no `-new` drafts found (tmp/connector-choices/ missing or empty of *-new.json)
set -euo pipefail

CHOICES_DIR="${CONNECTOR_CHOICES_DIR:-tmp/connector-choices}"
VERSIONS_DIR="${CONNECTOR_VERSIONS_DIR:-tmp/connector-versions}"

if [ ! -d "$CHOICES_DIR" ]; then
    echo "❌ no drafts directory at $CHOICES_DIR" >&2
    echo "   run pick_connector.sh <nick>-new <gav> in Phase A.3 first" >&2
    exit 1
fi

shopt -s nullglob
NEW_DRAFTS=("$CHOICES_DIR"/*-new.json)
shopt -u nullglob

if [ ${#NEW_DRAFTS[@]} -eq 0 ]; then
    echo "❌ no *-new.json drafts in $CHOICES_DIR" >&2
    echo "   run pick_connector.sh <nick>-new <gav> in Phase A.3 first" >&2
    exit 1
fi

mkdir -p "$VERSIONS_DIR"

NAMES=()
for draft in "${NEW_DRAFTS[@]}"; do
    base=$(basename "$draft")
    stem="${base%.json}"
    stem="${stem%-new}"   # strip trailing -new, if any
    cp "$draft" "$VERSIONS_DIR/${stem}.json"
    NAMES+=("$stem")
done

IFS=$'\n' SORTED=($(printf '%s\n' "${NAMES[@]}" | sort))
unset IFS

echo "✅ promoted ${#NEW_DRAFTS[@]} pin(s): ${SORTED[*]}"
echo "   from: $CHOICES_DIR"
echo "   to:   $VERSIONS_DIR (basename with -new stripped)"
