#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill (copied and extended from
# build-mule-integration/scripts/describe_connector.sh).
#
# Runs `anypoint-cli-v4 dx mule describe-connector` for the drafted GAV
# and persists the full response to tmp/connector-metadata/. Echoes a
# human-readable digest to stdout so the agent sees the key fields in
# tool output and cannot plausibly ignore them.
#
# Three describe modes are supported:
#   A — Connector summary (no flags)
#   B — Per-operation / per-source (--type operation|source --name <name>)
#   C — Per-config connection provider (--type connection-provider
#        --name <provider> --config-name <config>)
#
# Mode C is the fix for DRAWBACKS.md #17: the connection-provider
# element name (e.g. `basic-connection`, `active-mq-connection`) cannot
# be derived from a Mode-A summary alone — the summary only carries the
# provider's SDK identifier. Mode C's response includes the DSL
# `elementName` for the provider, which is what Phase C needs to write
# inside `<prefix:config>`.
#
# Usage:
#   scripts/describe_connector.sh <nickname>
#   scripts/describe_connector.sh <nickname> --type operation|source --name <name>
#   scripts/describe_connector.sh <nickname> --type connection-provider --name <provider> --config-name <config>
#
# Where <nickname> matches the filename used in Step 3 — e.g. 'sfdc'.
# The GAV is read from the draft tmp/connector-choices/<nick>.json
# (written by pick_connector.sh). Drafts are promoted to the pinned
# tmp/connector-versions/<nick>.json by commit_connectors.sh after the
# Technical Design Summary is approved; describe_connector.sh falls back
# to that location so Phase-2 re-describes still work.
#
# Modes:
#   A — Connector summary: no flags.
#       Writes tmp/connector-metadata/<nick>.json
#         and tmp/connector-errors/<nick>.json   (connector-wide errorTypes).
#   B — Per-operation / per-source: --type operation|source --name <name>.
#       Writes tmp/connector-metadata/<nick>-<name>.json
#         and tmp/connector-errors/<nick>.<name>.json (per-op/source subset).
#   C — Per-config connection provider: --type connection-provider
#       --name <provider> --config-name <config>.
#       Writes tmp/connector-metadata/<nick>-<config>-<provider>.json
#         and tmp/connector-errors/<nick>.<config>.<provider>.json.
#
# Pre-conditions:
#   - tmp/connector-choices/<nickname>.json exists (from Step 3 pick_connector.sh)
#     OR tmp/connector-versions/<nickname>.json exists (post-commit / Phase 2).
#
# Rationale: Step 4's output is what Step 5 (trigger selection)
# actually branches on. Echoing sources[] and configs[] to stdout puts
# those fields in the tool-output stream where the agent re-reads them
# naturally instead of falling back to prompt-text intuition about
# triggers. The tmp/connector-errors/ cache is consumed by the Step 16
# pre-mvn validator (validate_before_build.sh) to gate `mvn clean package`
# on a real error-type whitelist.
#
# Exit code:
#   0  describe succeeded; JSON saved; digest echoed
#   1  missing/partial args / missing GAV file / CLI failure
set -euo pipefail

usage() {
    echo "Usage: $0 <nickname>" >&2
    echo "       $0 <nickname> --type operation|source --name <name>" >&2
    echo "       $0 <nickname> --type connection-provider --name <provider> --config-name <config>" >&2
    echo "  e.g. $0 sfdc" >&2
    echo "       $0 sfdc --type operation --name query" >&2
    echo "       $0 sfdc --type connection-provider --name basic-connection --config-name sfdc-config" >&2
}

NICKNAME="${1:-}"
if [ -z "$NICKNAME" ]; then
    usage
    exit 1
fi
shift

TYPE=""
NAME=""
CONFIG_NAME=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --type)
            if [ "$#" -lt 2 ]; then
                echo "❌ --type requires a value" >&2
                usage
                exit 1
            fi
            TYPE="$2"
            shift 2
            ;;
        --name)
            if [ "$#" -lt 2 ]; then
                echo "❌ --name requires a value" >&2
                usage
                exit 1
            fi
            NAME="$2"
            shift 2
            ;;
        --config-name)
            if [ "$#" -lt 2 ]; then
                echo "❌ --config-name requires a value" >&2
                usage
                exit 1
            fi
            CONFIG_NAME="$2"
            shift 2
            ;;
        *)
            echo "❌ Unknown argument: $1" >&2
            usage
            exit 1
            ;;
    esac
done

# --type and --name must appear together (or not at all).
if [ -n "$TYPE" ] && [ -z "$NAME" ]; then
    echo "❌ --type requires --name (both flags must be set together)" >&2
    usage
    exit 1
fi
if [ -n "$NAME" ] && [ -z "$TYPE" ]; then
    echo "❌ --name requires --type (both flags must be set together)" >&2
    usage
    exit 1
fi
if [ -n "$TYPE" ] \
        && [ "$TYPE" != "operation" ] \
        && [ "$TYPE" != "source" ] \
        && [ "$TYPE" != "connection-provider" ]; then
    echo "❌ --type must be 'operation', 'source', or 'connection-provider' (got '$TYPE')" >&2
    usage
    exit 1
fi
if [ "$TYPE" = "connection-provider" ] && [ -z "$CONFIG_NAME" ]; then
    echo "❌ --type connection-provider requires --config-name <config>" >&2
    usage
    exit 1
fi
if [ -n "$CONFIG_NAME" ] && [ "$TYPE" != "connection-provider" ]; then
    echo "❌ --config-name is only valid with --type connection-provider" >&2
    usage
    exit 1
fi

CHOICES_DIR="${CONNECTOR_CHOICES_DIR:-tmp/connector-choices}"
VERSIONS_DIR="${CONNECTOR_VERSIONS_DIR:-tmp/connector-versions}"
METADATA_DIR="${CONNECTOR_METADATA_DIR:-tmp/connector-metadata}"
ERRORS_DIR="${CONNECTOR_ERRORS_DIR:-tmp/connector-errors}"

if [ "$TYPE" = "connection-provider" ]; then
    # Mode C: <nick>-<config>-<provider>.json so Phase C can locate the
    # right file by (config, provider) pair for each entry in
    # usage.config_providers_used[].
    METADATA_JSON="$METADATA_DIR/${NICKNAME}-${CONFIG_NAME}-${NAME}.json"
    ERRORS_JSON="$ERRORS_DIR/${NICKNAME}.${CONFIG_NAME}.${NAME}.json"
elif [ -n "$NAME" ]; then
    METADATA_JSON="$METADATA_DIR/${NICKNAME}-${NAME}.json"
    ERRORS_JSON="$ERRORS_DIR/${NICKNAME}.${NAME}.json"
else
    METADATA_JSON="$METADATA_DIR/${NICKNAME}.json"
    ERRORS_JSON="$ERRORS_DIR/${NICKNAME}.json"
fi

# Drafts (Step 3 pick_connector.sh) take precedence over commits
# (commit_connectors.sh, post-TDD). This lets the agent re-pick through
# Steps 3–5 while keeping Phase-2 re-describes working after commit.
if [ -f "$CHOICES_DIR/${NICKNAME}.json" ]; then
    GAV_JSON="$CHOICES_DIR/${NICKNAME}.json"
elif [ -f "$VERSIONS_DIR/${NICKNAME}.json" ]; then
    GAV_JSON="$VERSIONS_DIR/${NICKNAME}.json"
else
    echo "❌ No GAV file for '$NICKNAME' in $CHOICES_DIR/ or $VERSIONS_DIR/" >&2
    echo "   Run get_latest_connector.sh $NICKNAME, then pick_connector.sh $NICKNAME <gav>" >&2
    exit 1
fi

GAV="$(jq -r '"\(.groupId):\(.assetId):\(.version)"' "$GAV_JSON")"

mkdir -p "$METADATA_DIR"
mkdir -p "$ERRORS_DIR"

# Run describe and save the full response. On failure the CLI
# prints to stderr; forward its exit status so the agent sees the
# real error rather than a truncated JSON.
#
# NODE_NO_WARNINGS=1 silences Node's DEP0040 punycode warning that
# would otherwise leak into the agent's tool output on every call.
# Scoped to this invocation so it does not affect the surrounding shell.
#
# _JAVA_OPTIONS=-Dmule.jvm.version.extension.enforcement=LOOSE is forwarded
# to the bundled mule-dx-flow-design-service-impl-*.jar so older connectors
# whose extension model declares supportedJavaVersions=[1.8, 11] (e.g.
# mule-microsoft-dynamics365-connector 2.2.3 / 2.40.0) still describe under
# the Java 17 runtime that ships with the CLI plugin. Without LOOSE the
# Mule framework throws JavaVersionNotSupportedByExtensionException and the
# launcher's logger.severe() silently exits 1 with an empty stdout/stderr
# (CliOptions.configureLogging() routes JUL to OFF and replaces System.err
# with a no-op PrintStream — confirmed via -Xlog:exceptions trace).
mkdir -p tmp
ERR_TMP="$(mktemp tmp/mule-dev-describe-err.XXXXXX)"
# Stage CLI stdout in a temp file so a failed describe never leaves a
# 0-byte artifact at $METADATA_JSON. Downstream tooling reads size and
# treats "file exists, empty" as "connector has no metadata", which is
# false when the real cause is a wrong --name / --config-name pair
# (bug found 2026-07-14: Mode-C calls with the user's flow-XML config
# names produced empty JSONs that then hid Phase C's contract-diff step).
OUT_TMP="$(mktemp tmp/mule-dev-describe-out.XXXXXX)"
# Cleanup on any exit path.
trap 'rm -f "$ERR_TMP" "$OUT_TMP"' EXIT

# Build the CLI argv into an array so summary-mode and per-op/source-mode
# share one invocation. The two branches differ only by the optional
# --type/--name pair.
CMD_ARGS=( --connector "$GAV" --output json )
if [ -n "$TYPE" ]; then
    CMD_ARGS+=( --type "$TYPE" --name "$NAME" )
fi
if [ -n "$CONFIG_NAME" ]; then
    CMD_ARGS+=( --config-name "$CONFIG_NAME" )
fi

if ! NODE_NO_WARNINGS=1 \
        _JAVA_OPTIONS="${_JAVA_OPTIONS:-} -Dmule.jvm.version.extension.enforcement=LOOSE" \
        anypoint-cli-v4 dx mule describe-connector \
        "${CMD_ARGS[@]}" > "$OUT_TMP" 2>"$ERR_TMP"; then
    cat "$ERR_TMP" >&2
    if [ "$TYPE" = "connection-provider" ]; then
        echo "❌ describe-connector failed for $GAV (--type $TYPE --name $NAME --config-name $CONFIG_NAME)" >&2
        echo "   hint: --name and --config-name must be the SDK-side names from ${METADATA_DIR}/${NICKNAME}.json — .configs[].name for --config-name, .configs[].connectionProviders[] entry for --name. Do NOT use flow XML names like 'Warehouse_DB_Config' or 'basic-connection'." >&2
    elif [ -n "$TYPE" ]; then
        echo "❌ describe-connector failed for $GAV (--type $TYPE --name $NAME)" >&2
    else
        echo "❌ describe-connector failed for $GAV" >&2
    fi
    exit 1
fi

# Guard: if stdout was empty despite exit 0, the CLI likely emitted the
# real error via stderr under a "Picked up _JAVA_OPTIONS" banner and the
# error formatter still returned 0. Refuse to persist an empty file.
if [ ! -s "$OUT_TMP" ]; then
    cat "$ERR_TMP" >&2
    echo "❌ describe-connector returned empty JSON for $GAV (args: ${CMD_ARGS[*]})" >&2
    echo "   hint: check --name / --config-name spelling against ${METADATA_DIR}/${NICKNAME}.json (SDK names, not flow XML names)" >&2
    exit 1
fi

mv "$OUT_TMP" "$METADATA_JSON"

# Persist the error-type whitelist (top-level .errorTypes) so the
# Step 16 validator (validate_before_build.sh) has a connector-wide
# (Mode A) or per-op/source (Mode B) cache without an extra round trip.
# Empty array if .errorTypes is absent.
jq '{errorTypes: (.errorTypes // [])}' "$METADATA_JSON" > "$ERRORS_JSON"

if [ "$TYPE" = "connection-provider" ]; then
    # Mode C digest — surface the provider's DSL elementName + attribute
    # /childElement contract to stdout so Phase C's LLM prompt sees them
    # inline. This is the fix for DRAWBACKS.md #17: without this the
    # LLM has to guess the connection element name.
    echo "✅ $NICKNAME [$TYPE/$CONFIG_NAME/$NAME] → $METADATA_JSON"
    echo "   GAV:        $GAV"
    echo "   errors →    $ERRORS_JSON"
    echo ""
    echo "--- describe digest (--type $TYPE --config-name $CONFIG_NAME --name $NAME) ---"
    # For config-detail (which is what the CLI returns in Mode C for the
    # SDK-connector case), the connection provider we asked for is inside
    # .connectionProviders[]. Show the config-level fields plus that
    # provider's contract explicitly.
    jq -r --arg prov "$NAME" '{
      config: {
        name: (.name // ""),
        prefix: (.prefix // ""),
        elementName: (.elementName // ""),
        attributes: (.attributes // []),
        childElements: (.childElements // [])
      },
      selected_provider: (.connectionProviders // [] | map(select(.name == $prov)) | first // null)
    }' "$METADATA_JSON"
elif [ -n "$TYPE" ]; then
    # Per-op / per-source digest: full attributes, childElements,
    # errorTypes. Echo to stdout so the agent reads them in tool output
    # without a separate jq round trip.
    echo "✅ $NICKNAME [$TYPE/$NAME] → $METADATA_JSON"
    echo "   GAV:        $GAV"
    echo "   errors →    $ERRORS_JSON"
    echo ""
    echo "--- describe digest (--type $TYPE --name $NAME) ---"
    jq -r '{
      name: .name,
      prefix: .prefix,
      elementName: .elementName,
      attributes: (.attributes // []),
      childElements: (.childElements // []),
      errorTypes: (.errorTypes // [])
    }' "$METADATA_JSON"
else
    # Echo the key fields so the agent has them in tool output without
    # needing a separate jq/cat round-trip. This is the content Step 5
    # branches on — particularly sources[], which is the list of real
    # native triggers the connector supports.
    echo "✅ $NICKNAME → $METADATA_JSON"
    echo "   GAV:        $GAV"
    echo ""
    echo "--- describe digest ---"
    # Operations can run into the hundreds on OpenAPI-derived connectors;
    # show a count and a short head-sample rather than spraying them all.
    # sources[] and configs[] are always emitted in full — those are what
    # Step 5 (trigger selection) and Step 6 (provider selection) need.
    # errorTypes is included so the agent sees the connector's actual error
    # catalog (e.g. SALESFORCE:CONNECTIVITY) inline. Without it, the agent
    # may write <on-error-propagate type="..."> values that look plausible
    # but don't match the real namespace, and validate_before_build.sh
    # (Step 16) rejects them.
    jq -r '{
      namespace_prefix: .namespace.prefix,
      sources: .sources,
      configs: [.configs[] | {name: .name, providers: [.connectionProviders[]?]}],
      operations_count: (.operations | length),
      operations_sample: (.operations | if length > 20 then .[0:20] + ["... (see tmp/connector-metadata/'"$NICKNAME"'.json for full list)"] else . end),
      error_types: (.errorTypes // [])
    }' "$METADATA_JSON"
fi
