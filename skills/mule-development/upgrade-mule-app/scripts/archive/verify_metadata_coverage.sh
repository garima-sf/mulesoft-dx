#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-app skill.
#
# Step 11.5 gate — verify Mode-A/B/C metadata coverage before Step 12
# plan synthesis. Runs deterministically; no LLM.
#
# For every connector in tmp/connector-usage/*.json (excluding those with
# status="not_in_use"), this script checks:
#
#   1. Mode-A summary exists: tmp/connector-metadata/<nick>-new.json
#   2. Mode-B per-op exists: tmp/connector-metadata/<nick>-new-<op>.json
#      for every op in usage.operations_used[] ∩ modeA.operations[].name
#      (renamed/removed ops that lack a candidate are reported as WARN,
#      not FAIL — Step 7 already flags them via <nick>-op-renames.json).
#   3. Mode-B per-source exists similarly for sources_used[] ∩ modeA.sources[].
#   4. Mode-C per-provider exists: tmp/connector-metadata/<nick>-new-<config>-<provider>.json
#      for every provider in usage.config_providers_used[] AND the Mode-A
#      config declares connectionProviders (see D7 fallback below).
#
# D7 fallback — Mode-C empty-connectionProviders:
#   Some connector configs declare zero providers (e.g. `mule-db-connector`
#   `config` element when the derby/mssql/generic bundle wasn't imported).
#   For those, Mode-C returns `{}` — coverage on such (config, provider)
#   pairs is UN-verifiable via Mode-C. Fall back to Mode-A's `.configs[]`
#   shape: if configs[<config>].connectionProviders[] is empty, we cannot
#   run Mode-C. The gate emits an INFO row ("no providers to describe")
#   and does NOT fail. Phase C consumers must read Mode-A `.configs[]` in
#   this case, not Mode-C.
#
# Usage:
#   scripts/verify_metadata_coverage.sh [--strict]
#
# Exit code:
#   0  every required (op, provider) has a Mode-B / Mode-C JSON; empty-
#      provider configs are logged as INFO but do not fail.
#   1  at least one required per-op / per-provider JSON is missing.
#      With --strict, any WARN (renamed op with no candidate) also fails.
#   2  no tmp/connector-usage/*.json files were produced yet — Step 7
#      hasn't been run.

set -euo pipefail

STRICT=0
if [ "${1:-}" = "--strict" ]; then
    STRICT=1
fi

USAGE_DIR="${CONNECTOR_USAGE_DIR:-tmp/connector-usage}"
METADATA_DIR="${CONNECTOR_METADATA_DIR:-tmp/connector-metadata}"

if [ ! -d "$USAGE_DIR" ]; then
    echo "❌ $USAGE_DIR does not exist — run enumerate_usage.sh (Step 7) first" >&2
    exit 2
fi

shopt -s nullglob
USAGE_FILES=( "$USAGE_DIR"/*.json )
shopt -u nullglob
if [ "${#USAGE_FILES[@]}" -eq 0 ]; then
    echo "❌ no usage files in $USAGE_DIR — run enumerate_usage.sh (Step 7) first" >&2
    exit 2
fi

MISSING=0
WARNS=0
INFO_COUNT=0
declare -a REPORT

_add_report() {
    REPORT+=( "$1" )
}

for usage_file in "${USAGE_FILES[@]}"; do
    nick="$(basename "$usage_file" .json)"

    # Skip not_in_use — the connector has zero flow references, no
    # Mode-B/C coverage is required.
    status="$(jq -r '.status // ""' "$usage_file" 2>/dev/null || echo "")"
    if [ "$status" = "not_in_use" ]; then
        _add_report "INFO  $nick — not_in_use, skipping"
        INFO_COUNT=$((INFO_COUNT + 1))
        continue
    fi

    modeA="$METADATA_DIR/${nick}-new.json"
    if [ ! -f "$modeA" ]; then
        _add_report "FAIL  $nick — missing Mode-A: $modeA"
        MISSING=$((MISSING + 1))
        continue
    fi

    # Mode-A canonical op / source / config lists.
    modeA_ops="$(jq -c '[.operations[]? | if type == "string" then . else .name end]' "$modeA")"
    modeA_srcs="$(jq -c '[.sources[]? | if type == "string" then . else .name end]' "$modeA")"

    # --- Mode-B ops ---
    while IFS= read -r op; do
        [ -z "$op" ] && continue

        # Is this op known to Mode-A? If not, it was renamed/removed —
        # Step 7 handles those via <nick>-op-renames.json; we don't
        # double-flag here.
        known="$(jq -r --arg n "$op" 'index($n) // "none"' <<<"$modeA_ops")"
        if [ "$known" = "none" ]; then
            _add_report "WARN  $nick/$op — op not in Mode-A .operations[] (rename or removed; check <nick>-op-renames.json)"
            WARNS=$((WARNS + 1))
            continue
        fi

        modeB="$METADATA_DIR/${nick}-new-${op}.json"
        if [ ! -f "$modeB" ]; then
            _add_report "FAIL  $nick/$op — missing Mode-B: $modeB"
            MISSING=$((MISSING + 1))
        fi
    done < <(jq -r '.operations_used[]? // empty' "$usage_file")

    # --- Mode-B sources ---
    while IFS= read -r src; do
        [ -z "$src" ] && continue
        known="$(jq -r --arg n "$src" 'index($n) // "none"' <<<"$modeA_srcs")"
        if [ "$known" = "none" ]; then
            _add_report "WARN  $nick/$src — source not in Mode-A .sources[]"
            WARNS=$((WARNS + 1))
            continue
        fi
        modeB="$METADATA_DIR/${nick}-new-${src}.json"
        if [ ! -f "$modeB" ]; then
            _add_report "FAIL  $nick/$src — missing Mode-B (source): $modeB"
            MISSING=$((MISSING + 1))
        fi
    done < <(jq -r '.sources_used[]? // empty' "$usage_file")

    # --- Mode-C providers ---
    # For each config in usage.configs_used[], look up Mode-A's declared
    # connectionProviders. If the config has zero declared providers,
    # emit INFO and skip (D7 fallback). Otherwise expect a Mode-C file
    # for every provider in usage.config_providers_used[] that matches
    # one of the declared providers.
    while IFS= read -r config_name; do
        [ -z "$config_name" ] && continue

        # The Mode-A config lookup is by .elementName (DSL name) OR
        # .name — different SDK versions surface it either way.
        declared_providers="$(jq -c \
            --arg cfg "$config_name" \
            '[.configs[]? | select((.elementName // .name) == $cfg) | .connectionProviders[]? | if type == "string" then . else (.elementName // .name) end]' \
            "$modeA" 2>/dev/null || echo '[]')"

        declared_count="$(jq 'length' <<<"$declared_providers")"

        if [ "$declared_count" = "0" ]; then
            # Either the config isn't in Mode-A (foreign config-ref
            # pointing at another connector) OR the config has empty
            # connectionProviders[]. Both are non-fatal — Phase C reads
            # Mode-A .configs[] directly in this case.
            in_modeA="$(jq -r --arg cfg "$config_name" \
                '[.configs[]? | (.elementName // .name)] | index($cfg) // "none"' \
                "$modeA" 2>/dev/null || echo "none")"
            if [ "$in_modeA" = "none" ]; then
                # Not this connector's config — silently skip (usage
                # scanner captures every config-ref regardless of ns).
                :
            else
                _add_report "INFO  $nick/$config_name — no providers declared in Mode-A (Phase C reads .configs[] directly)"
                INFO_COUNT=$((INFO_COUNT + 1))
            fi
            continue
        fi

        # For each provider in usage that's actually declared, require Mode-C.
        while IFS= read -r prov; do
            [ -z "$prov" ] && continue
            declared_hit="$(jq -r --arg n "$prov" 'index($n) // "none"' <<<"$declared_providers")"
            if [ "$declared_hit" = "none" ]; then
                # Provider in usage but not in Mode-A → renamed/removed.
                _add_report "WARN  $nick/$config_name/$prov — provider not in Mode-A .configs[].connectionProviders[] (rename or removed)"
                WARNS=$((WARNS + 1))
                continue
            fi
            modeC="$METADATA_DIR/${nick}-new-${config_name}-${prov}.json"
            if [ ! -f "$modeC" ]; then
                _add_report "FAIL  $nick/$config_name/$prov — missing Mode-C: $modeC"
                MISSING=$((MISSING + 1))
            fi
        done < <(jq -r '.config_providers_used[]? // empty' "$usage_file")
    done < <(jq -r '.configs_used[]? // empty' "$usage_file")
done

# --- Report ---
printf '%s\n' "${REPORT[@]}"
echo ""
echo "Coverage: ${#REPORT[@]} rows — ${MISSING} FAIL, ${WARNS} WARN, ${INFO_COUNT} INFO"

if [ "$MISSING" -gt 0 ]; then
    echo "" >&2
    echo "❌ Metadata coverage incomplete — Step 12's plan will be blind on the FAIL rows above." >&2
    echo "   Re-run describe_connector.sh for the missing (op, provider) pairs before proceeding." >&2
    exit 1
fi
if [ "$STRICT" = "1" ] && [ "$WARNS" -gt 0 ]; then
    echo "" >&2
    echo "❌ --strict: WARN rows are not permitted (renamed/removed ops must be resolved via <nick>-op-renames.json before Step 12)." >&2
    exit 1
fi

echo "✅ metadata coverage complete"
exit 0
