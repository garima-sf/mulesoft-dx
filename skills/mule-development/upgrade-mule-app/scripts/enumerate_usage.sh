#!/usr/bin/env bash
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
# Part of upgrade-mule-connector skill.
#
# Phase B0 helper — enumerate the connector's actual usage in a Mule
# project's flow XMLs. Deterministic; no LLM.
#
# What it grep's for, per <prefix> pulled from the NEW connector metadata:
#   - Operations / sources used  → <prefix:...> element names
#   - Configs referenced         → config-ref="..." values and <prefix:config> names
#   - Config providers used      → child elements of each <prefix:config>
#   - Error types caught         → type="PREFIX:..." on <on-error-*>
#   - Error types raised         → type="PREFIX:..." on <raise-error> (rare, but tracked)
#   - Line-numbered usage sites  → per-op file+line+attributes_set for the plan step
#
# Usage:
#   scripts/enumerate_usage.sh <nickname> [<project-dir>]
#
# Where:
#   <nickname>    matches tmp/connector-metadata/<nick>-new.json (base nick, no -new suffix)
#   <project-dir> defaults to the current directory
#
# Reads:
#   tmp/connector-metadata/<nick>-new.json  (for the canonical namespace prefix)
#   <project-dir>/src/main/mule/*.xml       (flow XMLs)
#
# Writes:
#   tmp/connector-usage/<nick>.json
#
# The NEW metadata drives the prefix and is the sole source for element
# classification. The workflow is NEW-describe-only; OLD metadata is not
# consulted.
set -euo pipefail

usage() {
    echo "Usage: $0 <nickname> [<project-dir>]" >&2
    echo "  e.g. $0 file ." >&2
}

NICKNAME="${1:-}"
PROJECT_DIR="${2:-.}"

if [ -z "$NICKNAME" ]; then
    usage
    exit 1
fi

METADATA_DIR="${CONNECTOR_METADATA_DIR:-tmp/connector-metadata}"
NEW_META="$METADATA_DIR/${NICKNAME}-new.json"
OLD_META="$METADATA_DIR/${NICKNAME}-old.json"

if [ ! -f "$NEW_META" ]; then
    echo "❌ missing $NEW_META — run describe_connector.sh ${NICKNAME}-new first" >&2
    exit 1
fi

FLOW_DIR="$PROJECT_DIR/src/main/mule"
if [ ! -d "$FLOW_DIR" ]; then
    echo "❌ no flow directory at $FLOW_DIR" >&2
    exit 1
fi

shopt -s nullglob
FLOW_FILES=( "$FLOW_DIR"/*.xml )
shopt -u nullglob
if [ "${#FLOW_FILES[@]}" -eq 0 ]; then
    echo "❌ no flow XML in $FLOW_DIR" >&2
    exit 1
fi

# Extract the prefix from NEW metadata.
NEW_PREFIX="$(jq -r '.namespace.prefix // empty' "$NEW_META")"
if [ -z "$NEW_PREFIX" ]; then
    echo "❌ $NEW_META has no .namespace.prefix" >&2
    exit 1
fi

# Extract the namespace URI too — used for the OLD-prefix fallback below.
# The URI is the *stable* identity of a connector's DSL across versions,
# even when the prefix name changes (e.g. SFDC 10 uses prefix `sfdc` for
# namespace URI `.../mule/salesforce`; SFDC 11 keeps the same URI but
# reports prefix `salesforce`).
NEW_URI="$(jq -r '.namespace.uri // .namespace.namespace // empty' "$NEW_META")"

# --- OLD-prefix fallback (DRAWBACKS.md #15) ---
#
# Pre-4.6-era connector releases sometimes ship a DSL prefix that later
# releases rename (SFDC 10 `sfdc` → SFDC 11 `salesforce`). The NEW-side
# prefix from `<nick>-new.json` won't grep-match the OLD flow XMLs, so
# operations_used[] would come back empty and Phase C would be blind.
#
# Strategy: probe the flow XMLs for any `xmlns:<candidate>="<NEW_URI>"`
# binding. If we find one — and it's not already the NEW prefix — treat
# it as the OLD prefix and re-run the grep with it. Emit
# `namespace_prefix_changed = {from, to}` in the output so Phase C
# knows to rewrite `<oldprefix:...>` → `<newprefix:...>`.
_scan_flow_prefixes_for_uri() {
    local uri="$1"
    [ -z "$uri" ] && return 0
    # Match `xmlns:<name>="<uri>"`. BSD grep on macOS lacks -P; sed handles
    # the extraction portably.
    grep -hoE "xmlns:[a-zA-Z][a-zA-Z0-9._-]*=\"[^\"]+\"" "${FLOW_FILES[@]}" 2>/dev/null \
        | sed -E 's/xmlns:([^=]+)="([^"]+)"/\1\t\2/' \
        | awk -F'\t' -v u="$uri" '$2 == u { print $1 }' \
        | sort -u
}

PREFIX="$NEW_PREFIX"
PREFIX_CHANGED_FROM=""

# Manual override — when both prefix AND URI changed between OLD and NEW
# (e.g. mcrm:.../mule/mcrm → crm:.../mule/crm), the URI-based fallback below
# can't match. Caller can pass PREFIX_OVERRIDE=<oldprefix> to skip URI matching.
if [ -n "${PREFIX_OVERRIDE:-}" ]; then
    cand_hit="$(grep -hoE "<${PREFIX_OVERRIDE}:[a-zA-Z]" "${FLOW_FILES[@]}" 2>/dev/null | wc -l | tr -d ' ' || true)"
    if [ "${cand_hit:-0}" -gt 0 ]; then
        PREFIX="$PREFIX_OVERRIDE"
        PREFIX_CHANGED_FROM="$PREFIX_OVERRIDE"
        echo "ℹ️  override: using OLD prefix '$PREFIX_OVERRIDE' (URI-changed connector; PREFIX_OVERRIDE env)" >&2
    fi
fi

# Quick probe: does the NEW prefix appear as an element opener in the flow?
# NOTE: `|| true` on the grep pipeline is load-bearing. `set -euo pipefail` at
# the top of this script (line 37) combined with grep's exit-1-on-no-match
# would otherwise terminate the script here before the fallback loop below
# had a chance to run — the very scenario the fallback was written to handle.
# Regression fixed 2026-07-08 (DRAWBACKS.md #18). Do NOT remove `|| true`.
NEW_PREFIX_HIT_COUNT="$(grep -hoE "<${NEW_PREFIX}:[a-zA-Z]" "${FLOW_FILES[@]}" 2>/dev/null | wc -l | tr -d ' ' || true)"
if [ "${NEW_PREFIX_HIT_COUNT:-0}" -eq 0 ] && [ -n "$NEW_URI" ]; then
    # NEW prefix isn't in the flow. Look for a different prefix bound to
    # the same namespace URI — that's the OLD prefix.
    while IFS= read -r cand; do
        [ -z "$cand" ] && continue
        [ "$cand" = "$NEW_PREFIX" ] && continue
        # Confirm the candidate actually appears as an element opener.
        # Same `|| true` reasoning as line 116 — grep exits 1 on no match.
        cand_hit="$(grep -hoE "<${cand}:[a-zA-Z]" "${FLOW_FILES[@]}" 2>/dev/null | wc -l | tr -d ' ' || true)"
        if [ "${cand_hit:-0}" -gt 0 ]; then
            PREFIX="$cand"
            PREFIX_CHANGED_FROM="$cand"
            echo "ℹ️  fallback: NEW prefix '$NEW_PREFIX' not found in flow — grepping with OLD prefix '$cand' (same namespace URI '$NEW_URI')" >&2
            break
        fi
    done < <(_scan_flow_prefixes_for_uri "$NEW_URI")
fi

# Element names in flow XML are DSL-form (kebab-case: `create-object`),
# but SDK metadata (operations/sources/configs) uses camelCase
# (`createObject`). Convert DSL → camel so downstream classify/diff
# comparisons hit. See DRAWBACKS.md #1 for the incident.
_grep_elems() {
    local prefix="$1"
    grep -hoE "<${prefix}:[a-zA-Z][a-zA-Z0-9_-]*" "${FLOW_FILES[@]}" 2>/dev/null \
        | sed -E "s/^<${prefix}://" \
        | sort -u \
        | while IFS= read -r name; do
            [ -z "$name" ] && continue
            # Kebab → camel. `create-object` → `createObject`.
            parts_head="${name%%-*}"
            if [ "$parts_head" = "$name" ]; then
                printf '%s\n' "$name"
            else
                python3 -c "
import sys
s = sys.argv[1]
parts = s.split('-')
print(parts[0] + ''.join(p.capitalize() for p in parts[1:]))
" "$name"
            fi
        done
}

ELEMS="$(_grep_elems "$PREFIX")"

# Classify each element name into operations / sources / configs from
# the NEW connector metadata. Anything the metadata doesn't recognize
# lands in operations_used (best-effort — the diff step will surface
# genuine removals via rename_candidates).
OPS_JSON="$(jq -c '[.operations[]?.name // .operations[]? | select(type == "string")]' "$NEW_META" 2>/dev/null || echo '[]')"
# .operations may be array of strings OR array of {name: ...}; support both.
OPS_JSON="$(jq -c '
    [.operations[]? | if type == "string" then . else .name end]
' "$NEW_META")"
SRCS_JSON="$(jq -c '
    [.sources[]? | if type == "string" then . else .name end]
' "$NEW_META")"
CFG_ELEMS_JSON="$(jq -c '
    [.configs[]? | .elementName // .name]
' "$NEW_META")"
CFG_PROVIDERS_JSON="$(jq -c '
    [.configs[]?.connectionProviders[]? | if type == "string" then . else (.elementName // .name) end]
' "$NEW_META")"

operations_used=()
sources_used=()
config_elems_used=()
provider_hits_from_classify=()
child_elements_used=()
while IFS= read -r name; do
    [ -z "$name" ] && continue
    if jq -e --arg n "$name" 'index($n) != null' <<<"$OPS_JSON" >/dev/null 2>&1; then
        operations_used+=( "$name" )
    elif jq -e --arg n "$name" 'index($n) != null' <<<"$SRCS_JSON" >/dev/null 2>&1; then
        sources_used+=( "$name" )
    elif jq -e --arg n "$name" 'index($n) != null' <<<"$CFG_ELEMS_JSON" >/dev/null 2>&1; then
        config_elems_used+=( "$name" )
    elif jq -e --arg n "$name" 'index($n) != null' <<<"$CFG_PROVIDERS_JSON" >/dev/null 2>&1; then
        # Known child element of <prefix:config> (e.g. `basicConnection`,
        # `active-mq-connection`) — bucket in child_elements_used[], NOT
        # operations_used[]. Fix for DRAWBACKS.md POC-remaining #5.
        provider_hits_from_classify+=( "$name" )
        child_elements_used+=( "$name" )
    else
        # Unknown to NEW metadata — could be a removed/renamed operation,
        # an operation-scoped child element (e.g. `content`, `objectContent`,
        # `records`), or a source. The Phase B intersect
        # (usage.operations_used[] ∩ new.operations[]) filters these out
        # before per-op describe runs, so remaining downstream logic is
        # unaffected. Emit into operations_used[] AND child_elements_used[]
        # so Phase C can see the ambiguity explicitly — unions can be
        # de-duped by (operations_used ∩ new.operations[]) at read time.
        operations_used+=( "$name" )
        child_elements_used+=( "$name" )
    fi
done <<<"$ELEMS"

# Config-ref values ("File_Config") — collected from every attribute in
# the flow XML (any element can reference a config, not only connector ops).
# bash 3.2 on macOS lacks `mapfile`; use a while-read loop instead.
configs_used=()
while IFS= read -r cref; do
    [ -z "$cref" ] && continue
    configs_used+=( "$cref" )
done < <(grep -hoE 'config-ref="[^"]+"' "${FLOW_FILES[@]}" 2>/dev/null \
    | sed -E 's/config-ref="([^"]+)"/\1/' | sort -u)

# Config-provider elements actually declared inside a <prefix:...-config> block.
# Uses a small Python filter (bash + BSD awk on macOS lacks the gawk 3-arg
# match() extension, which is what a portable awk pass would need).
config_providers_used=()
for elem in "${provider_hits_from_classify[@]+"${provider_hits_from_classify[@]}"}"; do
    already=0
    for existing in "${config_providers_used[@]+"${config_providers_used[@]}"}"; do
        [ "$existing" = "$elem" ] && { already=1; break; }
    done
    [ "$already" -eq 0 ] && config_providers_used+=( "$elem" )
done
for f in "${FLOW_FILES[@]}"; do
    while IFS= read -r elem; do
        [ -z "$elem" ] && continue
        already=0
        for existing in "${config_providers_used[@]+"${config_providers_used[@]}"}"; do
            [ "$existing" = "$elem" ] && { already=1; break; }
        done
        [ "$already" -eq 0 ] && config_providers_used+=( "$elem" )
    done < <(python3 -c '
import re, sys
prefix = sys.argv[1]
path = sys.argv[2]
open_re = re.compile(rf"<{re.escape(prefix)}:[a-zA-Z0-9_-]*[Cc]onfig(\s[^>]*)?>")
close_re = re.compile(rf"</{re.escape(prefix)}:[a-zA-Z0-9_-]*[Cc]onfig>")
child_re = re.compile(rf"<{re.escape(prefix)}:([a-zA-Z][a-zA-Z0-9_-]*)")
inside = False
with open(path, "r", encoding="utf-8", errors="replace") as fh:
    for line in fh:
        if not inside:
            if open_re.search(line):
                inside = True
            continue
        if close_re.search(line):
            inside = False
            continue
        for m in child_re.finditer(line):
            name = m.group(1)
            # DSL kebab-case → SDK camelCase (see DRAWBACKS.md #1).
            parts = name.split("-")
            print(parts[0] + "".join(p.capitalize() for p in parts[1:]))
' "$PREFIX" "$f")
done

# Error types caught (on-error-propagate / on-error-continue) — PREFIX namespace only.
PREFIX_UPPER="$(printf '%s' "$PREFIX" | tr '[:lower:]' '[:upper:]')"
errortypes_caught=()
while IFS= read -r et; do
    [ -z "$et" ] && continue
    errortypes_caught+=( "$et" )
done < <(grep -hoE '<on-error-(propagate|continue)[^>]*type="[A-Z][A-Z0-9_]*:[A-Z][A-Z0-9_]*"' "${FLOW_FILES[@]}" 2>/dev/null \
    | sed -E 's/.*type="([^"]+)".*/\1/' \
    | grep -E "^${PREFIX_UPPER}:" \
    | sort -u)

errortypes_raised=()
while IFS= read -r et; do
    [ -z "$et" ] && continue
    errortypes_raised+=( "$et" )
done < <(grep -hoE '<raise-error[^>]*type="[A-Z][A-Z0-9_]*:[A-Z][A-Z0-9_]*"' "${FLOW_FILES[@]}" 2>/dev/null \
    | sed -E 's/.*type="([^"]+)".*/\1/' \
    | grep -E "^${PREFIX_UPPER}:" \
    | sort -u)

# Per-op usage sites: file + line + op name + attributes_set. One row
# per <prefix:op> hit, with the literal attributes map from the opening tag.
USAGE_SITES_JSON="[]"
tmpsites="$(mktemp -t upgrade-usage-sites.XXXXXX)"
trap 'rm -f "$tmpsites"' EXIT
for f in "${FLOW_FILES[@]}"; do
    { grep -nHoE "<${PREFIX}:[a-zA-Z][a-zA-Z0-9_-]*" "$f" 2>/dev/null || true; } | while IFS= read -r hit; do
        file="${hit%%:*}"; rest="${hit#*:}"
        lineno="${rest%%:*}"; rest="${rest#*:}"
        op_dsl="$(printf '%s' "$rest" | sed -E "s/^<${PREFIX}://")"
        # DSL (kebab) form is what the source XML holds; camelCase is
        # what metadata uses. Emit both so downstream tools can compare
        # against metadata AND locate edits in the source file.
        op_camel="$(python3 -c "
import sys
s = sys.argv[1]
parts = s.split('-')
print(parts[0] + ''.join(p.capitalize() for p in parts[1:]))
" "$op_dsl")"
        # Extract attributes from the opening tag on this line.
        # Use Python to handle multi-line tags and attribute parsing.
        attrs_json="$(python3 -c "
import re, json, sys
file_path = sys.argv[1]
target_line = int(sys.argv[2])
prefix = sys.argv[3]
op_dsl = sys.argv[4]

attrs = {}
with open(file_path, 'r', encoding='utf-8', errors='replace') as fh:
    lines = fh.readlines()
    if target_line <= len(lines):
        # Start at target line (1-indexed), read until we find the closing > or />
        i = target_line - 1
        full_tag = ''
        while i < len(lines):
            full_tag += lines[i]
            if '>' in lines[i]:
                break
            i += 1
        # Extract the opening tag portion up to first > or />
        tag_match = re.search(rf'<{re.escape(prefix)}:{re.escape(op_dsl)}([^>]*?)(/?)>', full_tag)
        if tag_match:
            attr_string = tag_match.group(1)
            # Parse attributes: capture optional namespace prefix so downstream
            # tools can distinguish real connector attributes (e.g. bucketName)
            # from foreign-namespace ones (e.g. doc:name, xsi:type). Prior
            # behavior stripped the prefix, so doc:name landed as bare 'name'
            # and looked like a real attribute — fix for DRAWBACKS.md
            # POC-remaining #6.
            for attr_match in re.finditer(
                r'((?:[a-zA-Z][a-zA-Z0-9_-]*:)?[a-zA-Z][a-zA-Z0-9_-]*)=\"([^\"]*)\"',
                attr_string,
            ):
                name = attr_match.group(1)
                # Skip layout/metadata attributes that carry no signal for
                # connector-behavior editing. doc:* is Studio metadata;
                # xsi: / xmlns: are XSD wiring.
                if name.startswith(('doc:', 'xmlns:', 'xsi:')) or name == 'xmlns':
                    continue
                attrs[name] = attr_match.group(2)
print(json.dumps(attrs))
" "$file" "$lineno" "$PREFIX" "$op_dsl")"
        printf '%s\t%s\t%s\t%s\t%s\n' "$op_camel" "$op_dsl" "$file" "$lineno" "$attrs_json" >> "$tmpsites"
    done
done
if [ -s "$tmpsites" ]; then
    # Convert tab-delimited data to JSON with attributes_set field.
    USAGE_SITES_JSON="$(python3 -c "
import sys, json
sites = []
for line in sys.stdin:
    line = line.rstrip('\n')
    if not line:
        continue
    parts = line.split('\t', 4)
    if len(parts) == 5:
        op_camel, op_dsl, file_path, lineno, attrs_json = parts
        attrs = json.loads(attrs_json)
        sites.append({
            'op': op_camel,
            'op_dsl': op_dsl,
            'file': file_path,
            'line': int(lineno),
            'attributes_set': attrs
        })
print(json.dumps(sites))
" < "$tmpsites")"
fi

_json_array() {
    if [ "$#" -eq 0 ]; then
        printf '[]'
    else
        printf '%s\n' "$@" | jq -R . | jq -s .
    fi
}

OUT_DIR="${CONNECTOR_USAGE_DIR:-tmp/connector-usage}"
mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/${NICKNAME}.json"

# Dedup arrays; leave sites as-is (agent reads line numbers).
OPS_ARR="$(_json_array "${operations_used[@]+"${operations_used[@]}"}" | jq 'unique')"
SRC_ARR="$(_json_array "${sources_used[@]+"${sources_used[@]}"}" | jq 'unique')"
CFG_ARR="$(_json_array "${configs_used[@]+"${configs_used[@]}"}" | jq 'unique')"
CFGP_ARR="$(_json_array "${config_providers_used[@]+"${config_providers_used[@]}"}" | jq 'unique')"
CHILD_ARR="$(_json_array "${child_elements_used[@]+"${child_elements_used[@]}"}" | jq 'unique')"
ETC_ARR="$(_json_array "${errortypes_caught[@]+"${errortypes_caught[@]}"}" | jq 'unique')"
ETR_ARR="$(_json_array "${errortypes_raised[@]+"${errortypes_raised[@]}"}" | jq 'unique')"

# If the OLD-prefix fallback fired, emit namespace_prefix_changed so
# Phase C can rewrite element prefixes on the touched elements.
if [ -n "$PREFIX_CHANGED_FROM" ]; then
    PREFIX_CHANGE_JSON="$(jq -n --arg from "$PREFIX_CHANGED_FROM" --arg to "$NEW_PREFIX" '{from: $from, to: $to}')"
else
    PREFIX_CHANGE_JSON="null"
fi

jq -n \
    --arg conn "$NICKNAME" \
    --arg prefix "$PREFIX" \
    --argjson ops "$OPS_ARR" \
    --argjson srcs "$SRC_ARR" \
    --argjson cfgs "$CFG_ARR" \
    --argjson cfgp "$CFGP_ARR" \
    --argjson children "$CHILD_ARR" \
    --argjson etc "$ETC_ARR" \
    --argjson etr "$ETR_ARR" \
    --argjson sites "$USAGE_SITES_JSON" \
    --argjson prefix_change "$PREFIX_CHANGE_JSON" \
    '{
        connector: $conn,
        namespace_prefix: $prefix,
        namespace_prefix_changed: $prefix_change,
        operations_used: $ops,
        sources_used: $srcs,
        configs_used: $cfgs,
        config_providers_used: $cfgp,
        child_elements_used: $children,
        errorTypes_caught: $etc,
        errorTypes_raised: $etr,
        usage_sites: $sites
    }' > "$OUT_FILE"

# Detect the "declared in pom but zero flow usage" case — this happens
# when a connector dependency exists but no `<prefix:...>` element is
# present in any flow XML (JMS `scripting` case surfaced in the file-app
# run; DRAWBACKS.md POC-remaining #7). Emit an explicit not_in_use
# status on stdout so Phase C can skip the connector cleanly rather than
# treating the empty arrays as "everything works".
if [ "$(jq '.operations_used | length' "$OUT_FILE")" -eq 0 ] \
   && [ "$(jq '.sources_used | length' "$OUT_FILE")" -eq 0 ] \
   && [ "$(jq '.configs_used | length' "$OUT_FILE")" -eq 0 ] \
   && [ "$(jq '.config_providers_used | length' "$OUT_FILE")" -eq 0 ] \
   && [ "$(jq '.usage_sites | length' "$OUT_FILE")" -eq 0 ]; then
    jq -n \
        --arg conn "$NICKNAME" \
        --arg prefix "$NEW_PREFIX" \
        --arg out "$OUT_FILE" \
        '{
            status: "not_in_use",
            connector: $conn,
            expected_prefix: $prefix,
            note: "connector is declared in pom.xml but no <prefix:...> element was found in any flow XML — Phase C can skip this connector; Phase D still runs to bump the pom version.",
            usage_file: $out
        }'
    echo "ℹ️  $NICKNAME → not_in_use (usage file written empty at $OUT_FILE)" >&2
    exit 0
fi

echo "✅ $NICKNAME → $OUT_FILE"
jq -r '{operations_used, sources_used, configs_used, config_providers_used, child_elements_used, errorTypes_caught, sites: (.usage_sites | length)}' "$OUT_FILE"
