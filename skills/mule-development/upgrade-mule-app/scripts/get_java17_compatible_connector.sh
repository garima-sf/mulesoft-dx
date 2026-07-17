#!/usr/bin/env bash
# get_java17_compatible_connector.sh — Step 6 of upgrade-mule-app
#
# Usage:
#   get_java17_compatible_connector.sh <group_id> <artifact_id> <nick>
#
# Resolves the latest Java-17-compatible version of a connector via Exchange metadata
# (anypoint-cli-v4 exchange asset list / describe → .tags[] is-java-17-supported).
# Walks from latest version backward at most 5 releases and picks the first Java-17 hit.
#
# Output (on success):
#   tmp/connector-choices/<nick>-new.json  — {groupId, assetId, version, java17, walkback_steps}
#
# Exit codes:
#   0  — Java-17-compatible version found; JSON written.
#   2  — No versions returned by `exchange asset list` for this assetId.
#   3  — Latest 5 versions checked, none flagged is-java-17-supported=true.
#   >0 — any anypoint-cli-v4 / jq failure propagates via `set -e`.
#
# Runs safely in parallel — writes to a unique per-nick output file, no shared temp state.

set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <group_id> <artifact_id> <nick>" >&2
  exit 64
fi

GROUP="$1"
ARTIFACT="$2"
NICK="$3"

OUT_DIR="tmp/connector-choices"
mkdir -p "$OUT_DIR"

# 1. Enumerate versions from Exchange, filter to type=Extension.
LIST_JSON=$(anypoint-cli-v4 exchange asset list "$ARTIFACT" --type Extension --output json)

# 2. Pull versions for this exact assetId, sort semver-descending, keep top 5.
VERSIONS=$(echo "$LIST_JSON" | jq -r --arg a "$ARTIFACT" '
  [ .[] | select(.assetId == $a) | .version ]
  | sort_by(split(".") | map(tonumber? // 0))
  | reverse
  | .[]
' | head -5)

if [ -z "$VERSIONS" ]; then
  echo "{\"error\":\"not-found\",\"nick\":\"$NICK\",\"artifact\":\"$ARTIFACT\"}"
  exit 2
fi

# 3. Walk latest → oldest; describe each; the first is-java-17-supported=true wins.
STEP=0
while IFS= read -r V; do
  [ -z "$V" ] && continue
  DESC=$(anypoint-cli-v4 exchange asset describe "$GROUP/$ARTIFACT/$V" --output json)
  J17=$(echo "$DESC" | jq -r '.tags[]? | select(.key == "is-java-17-supported") | .value' | head -1)
  if [ "$J17" = "true" ]; then
    jq -n \
      --arg g "$GROUP" \
      --arg a "$ARTIFACT" \
      --arg v "$V" \
      --argjson s "$STEP" \
      '{groupId: $g, assetId: $a, version: $v, java17: "ok", walkback_steps: $s}' \
      > "$OUT_DIR/${NICK}-new.json"
    echo "$OUT_DIR/${NICK}-new.json"
    exit 0
  fi
  STEP=$((STEP + 1))
done <<< "$VERSIONS"

# 4. No hit in latest 5 → HALT this connector; SKILL.md turns per-connector failures into
#    a whole-upgrade HALT after collecting all parallel results.
echo "{\"error\":\"no-java17-in-latest-5\",\"nick\":\"$NICK\",\"artifact\":\"$ARTIFACT\"}"
exit 3
