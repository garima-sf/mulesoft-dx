#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill.
#
# Phase A.5 helper — gate the upgrade on connector×Java compatibility.
#
# Every Mule connector's extension model declares supportedJavaVersions.
# When that window excludes the target Java version, the runtime may
# still deploy under -Dmule.jvm.version.extension.enforcement=LOOSE but
# it's not guaranteed to work at runtime (only at describe-time).
#
# This script reads tmp/connector-metadata/<nick>-new.json and compares
# `.supportedJavaVersions` to the target Java version. Three outcomes:
#
#   ok    — target Java is in the connector's declared window
#   warn  — target is outside the window; LOOSE tolerated the describe;
#           runtime deploy MAY fail. POC behavior: proceed with warning.
#   block — target is outside the window AND no newer version is
#           available in Exchange (up to the caller — this script just
#           reports the state; it does not query Exchange itself).
#
# Emits a JSON verdict to stdout. Exit code:
#   0  ok or warn
#   2  block
#
# Usage:
#   scripts/check_java_compatibility.sh <nickname> <target-java-version>
#   e.g. scripts/check_java_compatibility.sh file 17
#
# Reads:
#   tmp/connector-metadata/<nick>-new.json
set -euo pipefail

usage() {
    echo "Usage: $0 <nickname> <target-java-version>" >&2
    echo "  e.g. $0 file 17" >&2
}

NICKNAME="${1:-}"
TARGET_JAVA="${2:-}"
if [ -z "$NICKNAME" ] || [ -z "$TARGET_JAVA" ]; then
    usage
    exit 1
fi

# Accept either the bare nick (`sfdc`) or the pinned nick (`sfdc-new`).
# The metadata file is always `<base-nick>-new.json`; stripping a trailing
# `-new` here means SKILL.md can keep the `<nick>-new` convention it uses
# for describe/pick calls without producing a double-suffix lookup like
# `sfdc-new-new.json`. See DRAWBACKS.md #16.
BASE_NICK="${NICKNAME%-new}"
METADATA_DIR="${CONNECTOR_METADATA_DIR:-tmp/connector-metadata}"
META="$METADATA_DIR/${BASE_NICK}-new.json"
if [ ! -f "$META" ]; then
    echo "❌ missing $META — run describe_connector.sh ${BASE_NICK}-new first" >&2
    exit 1
fi

# supportedJavaVersions may live at .supportedJavaVersions or a
# vendor-specific path — try the top-level location first, then a
# handful of alternates seen in real describe output.
JAVA_WINDOW="$(jq -c '
  .supportedJavaVersions //
  .extensionModel.supportedJavaVersions //
  .describe.supportedJavaVersions //
  []
' "$META")"

# Normalize each entry to a bare major version — describes emit "1.8" (Java 8),
# "11", "17", "21".
NORM_WINDOW="$(jq -c '
  [ .[] |
    tostring |
    if startswith("1.") then split(".")[1] else . end
  ]
' <<<"$JAVA_WINDOW")"

VERDICT="$(jq -n \
    --arg conn "$BASE_NICK" \
    --arg target "$TARGET_JAVA" \
    --argjson window "$NORM_WINDOW" \
    '
    ($window | length) as $wlen |
    if $wlen == 0 then
      {status: "warn",
       connector: $conn,
       target_java: $target,
       supported: [],
       note: "connector describe did not report supportedJavaVersions — proceed with -Dmule.jvm.version.extension.enforcement=LOOSE at describe-time; runtime deploy behavior unknown"}
    elif ($window | index($target)) != null then
      {status: "ok",
       connector: $conn,
       target_java: $target,
       supported: $window}
    else
      {status: "warn",
       connector: $conn,
       target_java: $target,
       supported: $window,
       note: "target Java is not in the connectors declared window; LOOSE flag tolerated the describe, but the runtime may reject on deploy. Bump the connector to a newer version if one exists."}
    end
    ')"

printf '%s\n' "$VERDICT"

STATUS="$(jq -r '.status' <<<"$VERDICT")"
case "$STATUS" in
    ok|warn) exit 0 ;;
    block)   exit 2 ;;
    *)       exit 0 ;;
esac
