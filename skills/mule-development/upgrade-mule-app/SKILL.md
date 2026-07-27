---
name: upgrade-mule-app
description: Upgrades Java version and/or Mule Runtime, gets latest compatible connector versions, updates connector versions, and fixes impacts from operation changes in flows, DataWeave scripts, and MUnit tests. Supports Java upgrades, Mule Runtime upgrades, or both. Call this skill when users request to upgrade Java version, Mule runtime version, or modernize existing Mule applications.
license: Apache-2.0
compatibility: Requires Anypoint CLI v4 with the `@salesforce/anypoint-cli-dx-mule-plugin` DX plugin, Java 8+, Mule Runtime
metadata:
  author: mule-dx-tooling
  version: "2.0.0"
  cli: anypoint-cli-v4
  theme: professional
allowed-tools: Bash Read Write Edit AskUserQuestion
---

# Mule App Upgrader

Upgrade Mule applications with automated version updates and end-to-end compatibility resolution.

## When to Use This Skill

**Use this skill when users request:**

- "Upgrade my Mule app Java version"
- "Upgrade Mule runtime"
- "Upgrade Java and Mule runtime"
- "Modernize Mule application"
- "Update dependencies for new Java/runtime"

**Trigger keywords:** upgrade, migrate, update, modernize · java, java version · mule runtime, runtime version · dependencies, compatibility.

---

## Prerequisites

```bash
anypoint-cli-v4 --version
anypoint-cli-v4 dx --help
echo $JAVA_HOME && java -version   # Java 8+
anypoint-cli-v4 conf
```

If tools are missing:

```bash
npm install -g @mulesoft/anypoint-cli-v4
npm install -g @salesforce/anypoint-cli-dx-mule-plugin
anypoint-cli-v4 conf username <username>
anypoint-cli-v4 conf password <password>
```

**Required files in project:**
- `mule-artifact.json` - Mule application metadata
- `pom.xml` - Maven configuration
- Parent POM (if referenced in `pom.xml`)

---

## Bundled scripts

This skill ships small Node.js (ESM, zero-dep) scripts under `scripts/`. Invoke them with the `Bash` tool — do not inline their contents into a response. The scripts persist their output to disk so later steps can consume it mechanically and are not at the mercy of shell variables that vanish when a Bash tool call returns:

| Script | Purpose | Output location |
| --- | --- | --- |
| `describe_connector.mjs` | Mode-A/B/C describe of a NEW connector version (summary, per-op, per-config-provider). Invocations (flags — not positional): Mode-A `<nick>-new`; Mode-B `<nick>-new --type operation --name <op>` (or `--type source --name <src>`); Mode-C `<nick>-new --type connection-provider --name <provider> --config-name <config>`. See `references/plan-connector-upgrades.md §2, §4, §5`. | `tmp/connector-metadata/<nick>-new.json`, `<nick>-new-<op>.json`, `<nick>-new-<config>-<provider>.json` |
| `enumerate_usage.mjs` | Scans `src/main/mule/**/*.xml` for a connector's ops, configs, error types, namespace prefix used by the app. The OLD-side source of truth — replaces re-describing the old connector version. See `references/plan-connector-upgrades.md §3`. | `tmp/connector-usage/<nick>.json` |
| `get_java17_compatible_connector.mjs` | Walks Exchange latest→oldest (max 5 versions) for a `(groupId, artifactId)`; first `is-java-17-supported=true` wins. See `references/plan-connector-upgrades.md §1.5`. | `tmp/connector-choices/<nick>-new.json` |
| `check_java_compatibility.mjs` | Probes a connector version's `supportedJavaVersions`. Empty metadata → assume Java-17 OK (`feedback_upgrade_java17_defaults`). | stdout `pass` / `warn` / `block` |
| `apply_connector_pin.mjs` | Bumps one connector's version in `pom.xml` and rewrites its `xsi:schemaLocation` in every flow XML. Deterministic — never hand-edit `xsi:schemaLocation`. | mutates `pom.xml` + `src/main/mule/**/*.xml` |
| `apply_runtime_bump.mjs` | Bumps `<app.runtime>`, `<javaVersion>`, `<maven.compiler.source/target>`, `<mule.maven.plugin.version>` in `pom.xml`, and `minMuleVersion` + `javaSpecificationVersions` in `mule-artifact.json`. Matrix in `references/runtime-bump-matrix.md`. Exits 2 if running Java doesn't match the target. | mutates `pom.xml` + `mule-artifact.json` (+ `.mvn/jvm.config` on Java 17) |
| `promote_new_connector_pins.mjs` | Copies every `tmp/connector-choices/<nick>-new.json` → `tmp/connector-versions/<nick>.json` so Phase 2's pin script can consume them. Run once, before `apply_connector_pin.mjs`. | `tmp/connector-versions/<nick>.json` |
| `verify_metadata_coverage.mjs` | Step 11.5 gate — for every op / source / provider in `tmp/connector-usage/*.json`, verify a Mode-B / Mode-C JSON exists in `tmp/connector-metadata/`. Exits 1 with FAIL rows when any required per-op / per-provider describe is missing. Configs whose Mode-A `.connectionProviders[]` is empty (D7 fallback — some DB configs) emit INFO and do not fail; Phase C reads Mode-A `.configs[]` directly for those. Optional `--strict` also fails on WARN rows (renamed / removed ops that lack a `<nick>-op-renames.json` entry). | stdout FAIL/WARN/INFO rows |

Shared helpers live in `lib/*.mjs` alongside `scripts/`: `anypoint.mjs` (CLI env scrubbing), `fsx.mjs` (I/O), `platform.mjs` (Java version parsing), `pom-edit.mjs` (pom.xml + mule-artifact.json + XSD rewrites), `xml-flow.mjs` (flow XML grep primitives). The pre-2.0.0 bash + Python originals live under `scripts/archive/` for parity reference and rollback; the skill runtime does not invoke them.

Invoke scripts by the absolute path you were given in the "skill is now active" message (it is the directory containing this `SKILL.md`). Do **not** construct relative paths like `../scripts/...` — Cline's working directory shifts across turns and relative paths have produced "No such file or directory" errors in real runs. The inline step examples below write `scripts/...` as shorthand; substitute `<skill-dir>/scripts/...` when you actually execute them.

**Why scripts instead of inline bash:** Persisting to a file on disk makes data available across responses. Shell variables die when the `Bash` tool call returns, but files persist and can be read by later steps.

---

## Workflow shape (two phases)

This workflow has two phases separated by a hard user-approval gate.

- **Phase 1: Plan (Steps 1–12).** Validate prerequisites, get current versions, build baseline, determine target versions, run introspection, analyze connector/plugin/DataWeave/MUnit compatibility, present upgrade plan, wait for user approval. Phase 1 writes **nothing** to project files — all artifacts live under workspace-relative `tmp/` directory. No modifications to `mule-artifact.json`, `pom.xml`, or flows until approval.
- **Phase 2: Execute (Steps 13–21).** Download runtime/Java, update versions, update application code (flows/configs/DW/custom Java), run build loop, run MUnit loop, cleanup workspace, declare completion. Phase 2 is the only phase that modifies project files.

Phase 2 MUST NOT start until Step 12's approval gate has been passed explicitly. Skipping the plan or modifying files before approval defeats the purpose of the two-phase structure.

---

## Workflow-Wide Discipline (read before Phase 1)

- **Build → cleanup → completion separation.** Three responses, in order, each with a single tool call: `mvn clean package`, then `rm -r tmp/`, then the completion signal. Do not bundle them. Wait for each result before moving on.
- **One mvn invocation per response.** When re-running a build after a fix, emit only the `mvn` command in that response. Do not bundle it with further edits, follow-up shell commands, or the completion signal.
- **"Completion" means the build already passed.** You may only declare completion after a response that ran `mvn clean package` came back with `BUILD SUCCESS` and `mvn test` came back with all tests passing.
- **Version resolution from scripts/CLI only.** All versions come from scripts or CLI commands, never hardcoded. Use Exchange CLI for connector versions. Use release notes/CLI for plugin versions. Never paste versions from memory or documentation.
- **Java 17+ REQUIRED for every `describe_connector.mjs` call.** Under Java 8 or 11 the Anypoint CLI's `dx mule describe-connector` still exits 0 but returns a DEGRADED response — `configs[]` collapse to `{name, connectionProviders: []}` with no `parameters` / `attributes`, silently hiding required-attribute breaking changes. The skill's Phase-C diff then signs off on a config that is actually broken, and `mvn` fails at `process-classes` with an XSD-validation error (`cvc-complex-type.4: Attribute 'X' must appear on element '<prefix>:<config>'`). Before invoking `describe_connector.mjs` (Mode-A/B/C) in Steps 5, 7, and 14, export a Java 17+ `JAVA_HOME` (Zulu 17 preferred on SFDC laptops for Nexus TLS — see Step 13). The script itself refuses to run under < Java 17 and exits with a fix-it message, so a stale `JAVA_HOME` is caught immediately, not seven steps later at packaging.
- **`not_in_use` skip — the ONLY pre-Mode-B/C skip.** If Step 7's `enumerate_usage.mjs` prints a `not_in_use` JSON on stdout, the connector is declared in `pom.xml` but has zero flow usage. Reduce the plan for that connector to "bump the pom version only — no flow edits, no per-op describe." Skip Mode-B and Mode-C, but keep the connector in the plan under a `pom-only` section so Phase 2 still runs `apply_connector_pin.mjs`. Do NOT invent any other "stable connector" short-circuit — for every connector with real usage, run Mode-B / Mode-C unconditionally and let Step 12's plan synthesis surface "no rewrites" naturally by finding zero per-symbol diffs against the Mode-B / Mode-C JSONs.

---

# Phase 1: Plan

## Step 1: Validate Prerequisites

Run the sibling `build-mule-integration` prerequisites script — it writes `tmp/mule-dev-env.json` and exits non-zero when Anypoint CLI or a JDK is missing. Reuse rather than reinvent.

```bash
<skill-dir>/../build-mule-integration/scripts/validate_prerequisites.sh
```

After the script succeeds, confirm the app directory has both `pom.xml` and `mule-artifact.json` (the script does not check for these — it only validates tooling).

Do **not** gate on JAVA_HOME pointing at Java 17 here. Step 3 builds the app on its **current** Java (usually 8 or 11); Step 13 is the Java-17 gate.

- User is in app directory
- App available locally (mule-artifact.json and pom.xml exist)
- Parent POM availability (if referenced)

---

## Step 2: Get Current Versions

Read the current versions off disk and stage them into `tmp/upgrade-targets.json`. The `to.*` fields are hardcoded in Step 4 for v1 — write them now so the file is complete after this step.

From `pom.xml`:
- `<properties><app.runtime>` (or `<mule.version>`) → `mule.from`
- `<properties><javaVersion>` (or `<maven.compiler.source>` / `<maven.compiler.target>`) → `java.from`
- Every `<dependency>` whose `<classifier>` is `mule-plugin` → the in-scope connector list. Pick a short `nick` per artifact (e.g. `mule-amazon-s3-connector` → `s3`).

From `mule-artifact.json`:
- `<minMuleVersion>` — a secondary check on `mule.from`; if it differs from pom, record both.

Write `tmp/upgrade-targets.json`:

```json
{
  "mule":       { "from": "4.3.0", "to": "4.10.5" },
  "java":       { "from": "8",     "to": "17" },
  "connectors": [
    { "nick": "s3", "groupId": "com.mulesoft.connectors", "artifactId": "mule-amazon-s3-connector", "from": "5.8.4" }
  ]
}
```

- Get current Mule version from pom.xml
- Get current Java version from mule-artifact.json

---

## Step 3: Build Baseline

Confirm the app builds on its **current** Mule + Java versions before we touch anything. This runs against the app's OLD Java (whatever `JAVA_HOME` currently points at) — do NOT force Java 17 yet.

```bash
mvn clean package | tee tmp/baseline-build.log
```

If the exit is non-zero, HALT and hand back to the user:

> "The app does not build on its current version. Fix the baseline build before starting the upgrade — there is no point in propagating a broken build through connector migrations."

The resulting `target/*.jar` is used by Step 5's Mode-A describe if introspection needs the packaged extension model.

- Run `mvn clean package` on current version
- Verify app builds successfully
- Establish baseline JAR for introspection

If build fails, STOP and inform user the app must build on current version before upgrade.

---

## Step 4: Determine Target Versions

**v1: hardcoded targets, no user prompt.**

The v1 skill always upgrades to:
- Mule runtime: `4.10.5`
- Java: `17`

Both are already written into `tmp/upgrade-targets.json` by Step 2. Do NOT re-prompt the user for "Java-only vs Mule-only vs both" — v1 always upgrades both. Later iterations will restore the choice.

- Ask user: Java upgrade, Mule upgrade, or both?
- Get or suggest target versions
- Confirm with user

---

## Step 5: Run Introspection

**Note on v1 ordering:** Step 6 runs first (Exchange-metadata walker for Java-17 picks). This step then does the Mode-A **summary describe** on the version each connector was pinned to in Step 6.

**Java 17+ REQUIRED before invoking `describe_connector.mjs`.** Export a Java 17 `JAVA_HOME` for the shell that runs this step (see Step 13 for the preferred install — Zulu 17 on SFDC laptops). The script hard-refuses to run under Java 8/11 because those JDKs return a degraded describe (empty `configs[].parameters`) that would silently miss required-attribute breaking changes. If Step 1's `mule-dev-env.json` reported `java_version < 17`, refresh it now:

```bash
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"   # or your Zulu 17 install
<skill-dir>/../build-mule-integration/scripts/validate_prerequisites.sh
```

For each connector nickname `<nick>` in `tmp/upgrade-targets.json`:

```bash
<skill-dir>/scripts/describe_connector.mjs <nick>-new
```

**Nickname discipline (BLOCKER).** `<nick>` MUST equal the XSD prefix the flow XML uses (`crypto`, `os`, `xml-module`, `saml`), NOT the artifact slug (`cryptography`, `objectstore`, `xml`). The prefix is the join key between this step's metadata output and Step 7's usage extraction — pick from the flow XML `xmlns:<prefix>=...` bindings, then keep it consistent across Steps 5 → 7 (Mode-B) → 7 (Mode-C). `enumerate_usage.mjs` will still resolve a mismatched nick by scanning every `*-new.json` for `.namespace.prefix == <nick>`, but relying on that fallback means every downstream script has to be called with the right stem too — cheaper to get it right at Step 5.

Verify `tmp/connector-metadata/<nick>-new.json` exists before proceeding, and that its `.namespace` is an object with a non-empty `.prefix`. `describe_connector.mjs` refuses to persist a Mode-A file whose `.namespace` is a bare string — if the CLI describe is blocked (entitlement-gated connector) and you're hand-drafting metadata, follow the object shape `{"prefix": "...", "namespace": "...", "schemaLocation": "..."}` or Step 7's usage extractor will exit with a jq indexing error.

Writes `tmp/connector-metadata/<nick>-new.json` — the top-level summary (operations, sources, configs, errorTypes, supportedJavaVersions). This is the input to Step 7's Mode-B (per-op) and Mode-C (per-config-provider) describes.

**Mode-A ≠ Mode-B — do NOT grep Mode-A for attribute names.** The summary lists `.operations[].name` and `.configs[].name` only; it does NOT carry `.operations[<op>].attributes[]` or `.childElements[]`. Attribute renames, required-attribute additions, and attribute→child promotions are only visible in Mode-B (`<nick>-new-<op>.json`). Building the plan's per-op attribute diff off Mode-A will silently miss XSD-breaking changes — the build then fails at `process-classes` with `cvc-complex-type.3.2.2` errors that could have been caught at plan time. If Step 7 needs an attribute, run Mode-B for that op.

**Describe is NEW-only.** Do NOT describe the OLD connector version — the OLD-side source of truth is `enumerate_usage.mjs` (flow XML scan) in Step 7, not a second describe. Pre-4.6-era connectors often fail to describe under a Java-17 JDK; the skill is designed to work without OLD describe. See `feedback_upgrade_describe_new_only`.

Full algorithm and JSON shape: `references/plan-connector-upgrades.md §2 (Mode-A summary describe)`.

- Scan app JAR for Mule and Java compatibility

---

## Step 6: Get Connector Versions

For each in-scope connector, resolve the latest Java-17-compatible version via Exchange. Fan out in parallel, capped at 10 concurrent probes.

```bash
mkdir -p tmp/connector-choices

while IFS='|' read -r G A N; do
  <skill-dir>/scripts/get_java17_compatible_connector.mjs "$G" "$A" "$N" &
  # cap at 10 concurrent
  while [ "$(jobs -r | wc -l)" -ge 10 ]; do wait -n; done
done < <(jq -r '.connectors[] | "\(.groupId)|\(.artifactId)|\(.nick)"' tmp/upgrade-targets.json)
wait
```

The script uses `anypoint-cli-v4 exchange asset list <artifactId> --type Extension` to enumerate versions, then walks **latest → oldest for at most 5 versions** calling `anypoint-cli-v4 exchange asset describe "<groupId>/<assetId>/<version>" --output json` and checking `.tags[] | select(.key=="is-java-17-supported") | .value`. First `true` wins; writes `tmp/connector-choices/<nick>-new.json`.

Full algorithm: `references/plan-connector-upgrades.md §1.5 (Step 6 — Java-17-compatible connector version pick)`.

**HALT rule.** After `wait`, check that every in-scope nickname produced an output file:

```bash
missing=$(jq -r '.connectors[].nick' tmp/upgrade-targets.json | while read n; do
  [ -f "tmp/connector-choices/${n}-new.json" ] || echo "$n"
done)

if [ -n "$missing" ]; then
  echo "HALT: no Java-17-compatible version found in latest 5 releases for: $missing"
  exit 1
fi
```

If any connector's walk-back exhausts 5 versions without a Java-17 hit, HALT the entire upgrade with:

> "Cannot upgrade: connector `<artifactId>` has no Java-17-compatible version in its latest 5 releases on Exchange. Upgrade is not possible for this project."

Do NOT proceed to Step 7 until every connector has a `tmp/connector-choices/<nick>-new.json`.

**Version-downgrade check.** After all `<nick>-new.json` are written, cross-check each pick against `.connectors[].from` in `tmp/upgrade-targets.json`. If any pick is semver-less-than the current pin (e.g. walker returns `vm-connector 2.0.1` when the app is pinned to `2.0.5`), HALT and route through `AskUserQuestion` per `references/plan-connector-upgrades.md §1.5` before proceeding to Step 7. The most common cause is a private (org-visible) pin whose public Exchange listing has a lower latest — the user must consent to downgrade or opt to keep the current pin.

- Check if each connector from pom is available in Exchange
- Get min + latest compatible versions for each connector

---

## Step 7: Check Operations/Configs/Error Types Changes

See `references/plan-connector-upgrades.md` §2–§5 (Mode-A summary, usage enumeration, Mode-B per-op, Mode-C per-config-provider).

**Prerequisite: Java 17+.** Same rule as Step 5 — `describe_connector.mjs` refuses to run under < Java 17. Verify `$JAVA_HOME` still points at your Java-17 JDK before Mode-B / Mode-C fan-out; a subshell or `cd` may have reset it.

**`not_in_use` skip contract.** If `enumerate_usage.mjs` returns a `not_in_use` JSON for a connector (declared in `pom.xml` but zero flow usage), skip Mode-B and Mode-C for that connector. Keep it in the plan under a `pom-only` section so Phase 2 still runs the pin script. Do NOT invent any other pre-Mode-B/C short-circuit — for every connector with real usage, run Mode-B / Mode-C unconditionally; the "no rewrites" verdict falls out of Step 12's plan synthesis when the per-symbol diffs against Mode-B / Mode-C JSONs come back empty.

**Before invoking Mode-B**, intersect `usage.operations_used[]` with `<nick>-new.json .operations[]`:

- Op present in `.operations[]` → run Mode-B on it.
- Op **absent** from `.operations[]` → the op was renamed or removed. Pick the closest rename candidate (Levenshtein-close or same semantic role — e.g. S3 8.x: `createObject` → `putObject`, `readObject` → `getObject`) and run Mode-B on the **candidate**. Log the guessed rename in `tmp/connector-metadata/<nick>-op-renames.json` so §7's plan enumerates it explicitly. Never silently skip an op — the flow XML still calls it.

**Concrete invocations — flag-based, not positional.** The bundled scripts table (top of file) lists the syntax; repeat here so a subagent doesn't have to scroll:

```bash
# Mode-B — per operation or source
<skill-dir>/scripts/describe_connector.mjs <nick>-new --type operation --name <op>
<skill-dir>/scripts/describe_connector.mjs <nick>-new --type source    --name <src>

# Mode-C — per config-provider (both --name and --config-name are required)
<skill-dir>/scripts/describe_connector.mjs <nick>-new --type connection-provider --name <provider> --config-name <config>
```

Passing operation names as positional args (`describe_connector.mjs <nick>-new <op>`) is NOT supported and will trigger a "missing/partial args" exit — a real run in July 2026 burned 2–4 tool calls trial-and-erroring the flag order.

**Mandatory fan-out loop — one Mode-B per op, one Mode-C per provider, NO exceptions.** Do not "sample one op per connector" — every op / source / provider in `tmp/connector-usage/<nick>.json` MUST have its own describe file before Step 11.5. Skipping the fan-out leaves Step 12 blind on attribute renames and required-attribute additions; Step 16's retry loop then burns its whole budget guessing.

Execute the fan-out for every connector via this loop (paste verbatim — do not re-implement it inline). It is idempotent — an existing `<nick>-new-<op>.json` is skipped, so re-running after a partial run is cheap:

```bash
for usage in tmp/connector-usage/*.json; do
    nick="$(basename "$usage" .json)"
    status="$(jq -r '.status // ""' "$usage")"
    [ "$status" = "not_in_use" ] && continue

    modeA="tmp/connector-metadata/${nick}-new.json"
    [ -f "$modeA" ] || { echo "❌ Mode-A missing for $nick — re-run Step 5"; exit 1; }

    # Mode-B per operation (intersect with Mode-A .operations[])
    for op in $(jq -r '.operations_used[]? // empty' "$usage"); do
        known="$(jq -r --arg n "$op" '[.operations[]? | if type == "string" then . else .name end] | index($n) // "none"' "$modeA")"
        if [ "$known" = "none" ]; then
            echo "⚠️  $nick/$op — op absent from Mode-A .operations[] (rename/removed); Step 12 must consult <nick>-op-renames.json"
            continue
        fi
        out="tmp/connector-metadata/${nick}-new-${op}.json"
        [ -f "$out" ] && continue
        <skill-dir>/scripts/describe_connector.mjs "${nick}-new" --type operation --name "$op"
    done

    # Mode-B per source
    for src in $(jq -r '.sources_used[]? // empty' "$usage"); do
        out="tmp/connector-metadata/${nick}-new-${src}.json"
        [ -f "$out" ] && continue
        <skill-dir>/scripts/describe_connector.mjs "${nick}-new" --type source --name "$src"
    done

    # Mode-C per (config, provider). Skip pairs where Mode-A .configs[<cfg>].connectionProviders[] is empty — D7 fallback.
    for cfg in $(jq -r '.configs_used[]? // empty' "$usage"); do
        declared="$(jq -c --arg c "$cfg" '[.configs[]? | select((.elementName // .name) == $c) | .connectionProviders[]? | if type == "string" then . else (.elementName // .name) end]' "$modeA")"
        [ "$(jq 'length' <<<"$declared")" = "0" ] && continue
        for prov in $(jq -r '.config_providers_used[]? // empty' "$usage"); do
            declared_hit="$(jq -r --arg n "$prov" 'index($n) // "none"' <<<"$declared")"
            [ "$declared_hit" = "none" ] && continue
            out="tmp/connector-metadata/${nick}-new-${cfg}-${prov}.json"
            [ -f "$out" ] && continue
            <skill-dir>/scripts/describe_connector.mjs "${nick}-new" --type connection-provider --name "$prov" --config-name "$cfg"
        done
    done
done
```

**Post-condition (self-check) — must pass before Step 7 declares "done".** Do not defer this to Step 11.5:

```bash
<skill-dir>/scripts/verify_metadata_coverage.mjs || { echo "❌ Mode-B/C fan-out incomplete — re-run the loop above until coverage passes"; exit 1; }
```

If `verify_metadata_coverage.mjs` prints FAIL rows, re-run the fan-out loop for just those `(nick, op)` / `(nick, cfg, prov)` pairs. The loop is idempotent — it only re-invokes describe when the target file is missing.

**After Mode-B / Mode-C complete**, run the mandatory diffs listed in §8 (`references/plan-connector-upgrades.md`):

- Mode-B `.attributes[].attributeName` (NOT `.name`) vs `usage.usage_sites[].attributes_set` keys → attribute renames
- `usage.errorTypes_caught[]` vs Mode-B `.errorTypes[]` ∪ Mode-A `.errorTypes[]` → error-type renames (**mandatory**, not opportunistic — deferring these to build-time self-correction consumes retry budget)
- Mode-C child-tree diff — **recursive**, at BOTH scopes:
  - `.childElements[]` (config-level, walked recursively into every nested `.childElements[]` / `.containedElements[]`) vs OLD flow config-child tree
  - `.connectionProviders[].childElements[]` (provider-level, walked recursively) vs OLD flow provider-child tree
  Catches reparenting between config ↔ provider (e.g. `mule-db-connector` 1.16.x moves `<db:pooling-profile>` from `<db:config>` child to `<db:oracle-connection>` child) AND catches nested-structure diffs like `<vm:queues><vm:queue …/></vm:queues>` where the whole subtree lives under a config-level child, not a provider. Do not stop at the top-level names — a rename or restructure two levels deep will be missed.

Every diff residue MUST appear in §7 plan output as an explicit per-symbol edit.

- Describe connector operations for version changes
- Identify changes to operations, configs, error types
- Flag impacts on flows and configuration components

---

## Step 8: Check Custom Java Compatibility

(To be implemented)

- Identify custom Java classes (if any)
- Flag potential Java version incompatibilities

---

## Step 9: Check DataWeave Compatibility

**No scripts for v1.** The agent reads DW sources directly at plan-synthesis time (Step 12) using the `Read` tool. Compare symbols against Mode-B `.output*` keys from `tmp/connector-metadata/<nick>-new-<op>.json`:

- Symbols present in Mode-B → no change
- Symbols absent, sibling present → propose a rewrite in the plan
- Symbols absent AND Mode-B has NO `.output*` keys → mark as `SITE FLAGGED FOR OPERATOR`

Sources to read:
- Every `<ee:transform>` block under `src/main/mule/**/*.xml`
- Every inline `#[...]` expression under `src/main/mule/**/*.xml`

**Java 17 upgrade patterns — check every DW file (inline + `.dwl` under `src/main/resources/**`) for these eight, and add each hit to the plan under "DataWeave downstream impact":**

1. **`as Number` / `as Integer` on external strings** — Java 17's `NumberFormat` rejects thousands separators and whitespace that Java 8 tolerated. Wrap with a `sanitizeNumeric()` helper (strip `,` and trim) before the cast.
2. **`sizeOf(x as Object)` / `keysOf(x as Object)` / any `as Object` on a Map or Array** — the `as Object` cast used to opaque-wrap the value; Java 17 + newer DW rejects it. Drop the cast.
3. **`now() + <Number>` / `<DateTime> + <Number>`** — implicit Number→Period coercion is gone. Convert to an explicit period literal, e.g. `now() + |P7D|` or `now() + |PT1H|`.
4. **`formatDate(x, pattern)` / `parseDate(s, pattern)` without `{locale: ...}`** — JEP 252 flipped the default locale provider to CLDR; month/day names drift. Add `{locale: "en-US"}` (or the app's canonical locale) explicitly.
5. **Hardcoded reliance on `Charset.defaultCharset()`** or reading/writing files without an explicit charset — JEP 400 flipped the JVM default to UTF-8. Pin the charset explicitly on every read/write.
6. **`dw::Runtime::run(..., engine: "javascript")` or any Nashorn callout** — JEP 372 removed Nashorn. Rewrite in native DW (`reduce`, `map`, etc.); if the logic genuinely needs a JVM callout, use `java!` and audit that path against pattern 7.
7. **`java!` prefix into `sun.*` / `jdk.internal.*` / any encapsulated JDK internals** — JEP 403 hard-blocks reflective access to JDK internals. Rewrite using DataWeave native representations (locale as `{language, country}` map, timezone as canonical ID string).
8. **Three-letter timezone identifiers** (`"PST"`, `"CST"`, `"EST"`, `"PST8PDT"`) — tzdb drift + ambiguous mappings. Replace with canonical IANA IDs (`"America/Los_Angeles"`, `"America/Chicago"`, `"America/New_York"`).

The model already knows the fix for each pattern from public Java-17 migration guides — you don't need a bundled scanner script. Read each DW source with the `Read` tool, apply the checklist inline, and record every hit as `file:line — pattern-N — proposed fix` in Step 12's plan.

The connector-specific coercion checks (`as Number` on a connector op's payload, `now() as String` for a connector attribute, `error.errorType.identifier` against Mode-B error catalog) also happen during this same read pass — no separate scan.

Findings roll into the plan's "DataWeave downstream impact" section (see `references/plan-connector-upgrades.md §7`).

- Identify DataWeave scripts in flows
- Check for Java version incompatibilities
- Flag deprecated functions or syntax

---

## Step 10: Check MUnit Compatibility

**No scripts for v1.** The agent reads every `src/test/munit/**/*.xml` directly at plan-synthesis time (Step 12) using the `Read` tool. For each operation the plan will rewrite, flag:

- `<munit-tools:mock-when processor="<old-op>">` → rename plan entry
- `<munit-tools:then-return>` payload shapes → schema-mismatch flag
- `<munit-tools:assert-that>` reading op-response fields → cross-reference DW flags
- `<on-error-propagate type="...">` in MUnit error paths → apply error-type map from the plan

Findings roll into the plan's "MUnit downstream impact" section (see `references/plan-connector-upgrades.md §7`). Actual test edits happen in Step 15 and are validated by Step 17 (`mvn test`).

- Identify MUnit test files
- Check for connector operation changes that impact tests
- Flag test configurations that need updates
- Identify mock/assertion changes needed

---

## Step 11: Get Plugin Versions

(To be implemented)

- Get latest Mule Maven plugin version
- Get latest MUnit plugin version

---

## Step 11.5: Verify Metadata Coverage (gate)

Run the coverage gate before touching Step 12. It cross-references every op / source / provider in `tmp/connector-usage/*.json` against the Mode-A / Mode-B / Mode-C JSONs on disk and refuses to advance the plan if any required describe is missing.

```bash
<skill-dir>/scripts/verify_metadata_coverage.mjs
```

Behavior:

- **FAIL** (exit 1) — a required Mode-B or Mode-C JSON is missing on disk for an op/provider that IS present in Mode-A. Re-run `describe_connector.mjs` for those (op, provider) pairs, then re-run this gate.
- **WARN** — an op/provider appears in `usage_sites` but is NOT in Mode-A `.operations[]` / `.configs[].connectionProviders[]`. Usually a rename or removal; Step 7 should have written `<nick>-op-renames.json` with the candidate. Non-fatal by default — pass `--strict` to fail on WARN rows too.
- **INFO** — the connector is `not_in_use`, OR a used config has zero declared providers in Mode-A (D7 fallback). Phase C consumes Mode-A `.configs[]` directly for the empty-provider case; no Mode-C is required.

Do not proceed to Step 12 until this gate exits 0. A blind plan built on a missing per-op describe silently ships a "no rewrites needed" verdict for whatever the missing JSON would have revealed.

---

## Step 12: Present Plan & Get Approval

See `references/plan-connector-upgrades.md` §7 (plan synthesis, approval gate) and §8 (Phase-C completeness checklist — run before user is asked to approve).

Concrete flow for this step:

1. Verify §8 completeness checklist first — every connector has a `-new.json`, every used op has a `-new-<op>.json`, every used (config, provider) pair has a `-new-<config>-<provider>.json`. Step 11.5's `verify_metadata_coverage.mjs` gate already ran the mechanical version of this check; if it exited 0 you are safe to proceed. If any artifact is missing, loop back to Step 5/6/7 and do not present a partial plan.
2. **Resolve renames from the data you already have — do not defer to Step 16.** Every WARN row emitted by Step 11.5 is a rename signal (`WARN <nick>/<op-or-provider> — not in Mode-A ...`). For each WARN:
   - **Op renames**: cross-reference `tmp/connector-metadata/<nick>-new.json` `.operations[]` (all new op names). Pick the semantically closest match to the old op name and confirm by reading its Mode-B `tmp/connector-metadata/<nick>-new-<newOp>.json` `.attributes[]` — does the new op accept the attributes the flow XML sets on the old element? If yes, encode the rewrite as a plan bullet: `Rewrite <ns>:<oldOp> → <ns>:<newOp>` with attribute deltas listed inline (renamed, removed, newly-required).
   - **Provider renames**: cross-reference Mode-A `.configs[].connectionProviders[]` (all new provider names for that config) and read the Mode-C describe `tmp/connector-metadata/<nick>-new-<config>-<newProvider>.json` for each candidate. Pick the new provider whose attributes best cover what the flow XML sets on the old provider element (grep the flow XML: `grep -c 'ns:oldProvider' src/main/mule/*.xml` and then list its attributes). Emit `Rewrite <ns>:<oldProvider> → <ns>:<newProvider>` with attribute deltas.
   - The LLM already has every input needed — old names (from `tmp/connector-usage/<nick>.json` `.config_providers_used[]` / `.operations_used[]`), new names (from Mode-A `.operations[]` / Mode-A `.configs[].connectionProviders[]`), and per-target attribute shape (from Mode-B / Mode-C JSONs). No new script, no new AskUserQuestion — just synthesize the rename bullets into `tmp/upgrade-plan.md` before presenting it. Halt via `AskUserQuestion` only if a match is genuinely ambiguous (2+ new candidates with equal attribute coverage).
   - **Required-attribute additions** — beyond renames, diff each used op / provider / config's Mode-B/Mode-C `.attributes[]` where `required: true` against the attributes actually set on the corresponding element in flow XML. For every new-required attribute not present in the current flow XML:
     - If `.default` is set → emit `Add <ns>:<element> @<attr>="<default>"` (Example: crypto 2.x `<crypto:jce-config>` now requires `type` with `.default = "JCEKS"` → plan bullet `Add crypto:jce-config @type="JCEKS"`).
     - Else if `.type == "enum"` → pick `.values[0]` and note it in the bullet as `(picked first enum value; verify)`.
     - Else → surface as an `AskUserQuestion` bullet (`Connector <nick> op/provider <name> requires new attribute <attr> (<type>) — please supply a value`) before finalizing the plan.
   - This catches the "XSD says attribute X is required and you didn't set it" class of failure at plan time using Mode-B/C data you already fetched, instead of letting Step 16 burn retries reverse-engineering enum values from mvn error text.
3. `Read` the file `tmp/upgrade-plan.md` produced by §7 (with rename bullets from step 2 folded in).
4. Print its full contents inline in the response as fenced markdown so the user can review without opening another file.
5. Use `AskUserQuestion` with three options:
   - `Yes, proceed to Execution`
   - `No, I want to change the plan`
   - `No, cancel the upgrade`
6. **WAIT for the explicit "Yes, proceed to Execution."** before advancing to Step 13.

On `No, change`: collect specifics via a follow-up `AskUserQuestion`, loop back to the affected step (5/6/7/9/10), re-synthesize the plan, re-present. Do NOT rerun Step 1.

On `No, cancel`: stop the workflow. Leave `tmp/` in place for inspection.

- Display all version updates
- Show connector version changes
- Show operation/config/error type changes
- Show plugin updates
- Flag blockers
- **⚠️ APPROVAL GATE:** Wait for user approval before proceeding to execution

---

# Phase 2: Execute

## Step 13: Download Runtime and Java

**v1 does not automate downloads.** This step is a thin gate that verifies Java 17 is installed locally and that a Mule Runtime ≥ 4.9.x is registered with the Anypoint CLI.

```bash
/usr/libexec/java_home -v 17
```

If the command exits non-zero, HALT and prompt the user with `AskUserQuestion`:

> "Java 17 is not installed. Install Azul Zulu 17 (preferred over Microsoft OpenJDK 17 for SFDC Nexus TLS compatibility) via `brew install --cask zulu@17`, then `export JAVA_HOME=$(/usr/libexec/java_home -v 17)` and re-run this step."

Also verify the Mule Runtime path used by `anypoint-cli-v4 dx mule describe-connector`:

```bash
cat ~/.mule-dx/config.json 2>/dev/null | jq -r '.runtimePath // empty'
```

If empty or points at a Mule < 4.9.x install, HALT with the setup command from `references/plan-connector-upgrades.md §1`:

> "anypoint-cli-v4 dx mule runtime path --set ~/AnypointCodeBuilder/runtime/mule-enterprise-standalone-4.11.2"

- Download target Java version (if Java upgrade)
- Download target MRT (if MRT upgrade)
- Update JAVA_HOME and runtime paths

---

## Step 14: Update Files - Versions Only

Deterministic version rewrites — each script call in its own `Bash` response. Order matters: promote drafts → runtime bump → per-connector pin → re-describe pinned.

```bash
<skill-dir>/scripts/promote_new_connector_pins.mjs
<skill-dir>/scripts/apply_runtime_bump.mjs .
```

`apply_runtime_bump.mjs` exits 2 if the running JDK does not match `tmp/upgrade-targets.json .java.to`. Hand its stdout instruction to the user via `AskUserQuestion` verbatim and WAIT for confirmation before continuing.

Then per connector:

```bash
for nick in $(jq -r '.connectors[].nick' tmp/upgrade-targets.json); do
  <skill-dir>/scripts/apply_connector_pin.mjs "$nick" .
done
```

Then re-describe each pinned connector so downstream validators use the NEW error catalog. **Java 17+ REQUIRED here too** — same reason as Steps 5 and 7 (`describe_connector.mjs` will refuse under Java 8/11). Since Step 13 already gated on Java 17, `$JAVA_HOME` should still be set, but verify before the loop:

```bash
java -version 2>&1 | head -1   # must report 17+ before the describe loop
for nick in $(jq -r '.connectors[].nick' tmp/upgrade-targets.json); do
  <skill-dir>/scripts/describe_connector.mjs "$nick"          # no -new suffix
done
```

Full details, xsi:schemaLocation rewriting, and script contracts: `references/execute-connector-upgrades.md §4` (pre-build preparation).

- Update mule-artifact.json (minMuleVersion, javaSpecificationVersions)
- Update pom.xml (runtime version, Java version, connector versions, plugin versions)
- Update parent POM (if applicable)

---

## Step 15: Update Application Code

See `references/execute-connector-upgrades.md` §1–§3 (LLM flow-XML edits, DW updates, MUnit updates). Use `references/llm-prompts.md` verbatim as the model prompts.

Update application code based on analysis from Phase 1:

- Update flows for connector operation changes (based on Step 7 analysis)
- Update configuration components for config changes
- Update DataWeave scripts for compatibility issues (based on Step 9 analysis)
- Update custom Java classes for version incompatibilities (based on Step 8 analysis)
- Update MUnit test files for connector changes (based on Step 10 analysis) <!-- TODO: verify if MUnit test files should be updated before build or after -->

Use metadata from `describe-connector` to ensure operations, configs, and attributes match new connector versions.

---

## Step 16: Build Loop

See `references/execute-connector-upgrades.md` §4 (bounded 3-retry recovery loop). Note: `mvn clean package` BUILD SUCCESS is packaging-only — Step 17 (`mvn test`) is the real gate.

- Run `mvn clean package -DskipTests 2>&1 | tee tmp/mvn-failures/build-<attempt>.log`
- If BUILD SUCCESS → advance to Step 17.
- If BUILD FAILURE → classify the error (`references/execute-connector-upgrades.md §4` — attribute-rename, element-rename, provider-element, enum-value). Apply the fix. Retry.

### Diagnostic escalation ladder — MANDATORY on opaque failures

A "guess-fix-retry" loop that only reads the terse mvn line burns retries when the error message doesn't point at the offending file. Two failure modes are especially opaque and MUST trigger an escalation probe **before** the next code edit — not after a wasted retry.

**Trigger A — XSD "invalid content" on a pinned connector's operation/element.**
Symptom: `cvc-complex-type.2.4.a: Invalid content was found starting with element '<ns>:<op>'`.
Meaning: the flow XML calls an op that the *resolved* XSD doesn't declare. The pom pin may not have taken effect (stale local repo, transitive pin from parent POM, `current/` alias resolving to old version).

Before editing anything, run:
```bash
mvn dependency:tree -Dincludes=<groupId>:<artifactId> 2>&1 | tail -20
```
- If the resolved version ≠ the pinned version → `rm -rf ~/.m2/repository/<groupPath>/<artifactId>/<staleVer>` then re-run `mvn ... -U`.
- If versions match → the operation was genuinely renamed. Re-read the connector's Mode-B / `<nick>-op-renames.json` and apply the rename to the flow XML.

**Trigger B — opaque `ClassCastException` / `NullPointerException` with no app file in the stack.**
Symptom: `java.lang.ClassCastException: class java.lang.String cannot be cast to class java.lang.Integer` (or similar) and the stack trace lives entirely inside `org.mule.runtime.*` / `com.mulesoft.*` classes — no file/line in `src/main/mule/`.

Before editing anything, re-run with debug and grep for the failure frame + bean context:
```bash
mvn clean package -DskipTests -X 2>&1 | grep -B 20 -A 3 'ClassCastException\|NullPointerException' \
  | tee tmp/mvn-failures/build-<attempt>-debug.log
```
Then scan the preceding 20 lines for `Creating bean` / `parsing element` / `BeanDefinition` — those name the flow-XML element being constructed (e.g. `db:pooling-profile`, `http:listener-connection`). That element is where the fix lives. Common cause: a `${property}` placeholder on an attribute the new connector version now types as `xs:int`/`xs:boolean` — quote-strip or wrap in `${int(...)}` per the Mode-B `.attributes[].type`.

**Both probes are cheap (single mvn invocation, no code changes) and MUST run before the third retry** — otherwise the loop hits its 3-retry cap while still guessing.

**Trigger C — XSD error on an element/attribute that the plan already anticipated.**
Symptom, either:
- `cvc-complex-type.2.4.a: Invalid content ... element '<ns>:<name>'` AND grep shows `Rewrite <ns>:<name> →` in `tmp/upgrade-plan.md`; OR
- `cvc-complex-type.4: Attribute '<attr>' must appear on element '<ns>:<name>'` AND grep shows `Add <ns>:<name> @<attr>=` in `tmp/upgrade-plan.md`.

Do NOT re-analyze from XSD error text and do NOT guess an enum value. `grep -A2 "Rewrite <ns>:<name>\|Add <ns>:<name>" tmp/upgrade-plan.md` for the target directive, then apply that edit verbatim. The plan was written with Mode-B/C metadata already in hand (Step 12 sub-step 2) — trust it. If the plan bullet is missing but the WARN was present in Step 11.5 (or the attribute was declared `required: true` in the Mode-B/C JSON), that's a Step 12 skip; loop back to Step 12 and re-synthesize the plan (do not paper over it with a guess in Step 16).

### Retry cap and halt

- Retry budget: **3 build failures max** (log-and-diagnostic pass counts as ½ retry — see §4).
- If BUILD FAILURE persists after 3 real edit-retries with both escalation probes run, HALT via `AskUserQuestion` with:
  1. First 30 lines of the last three `tmp/mvn-failures/build-<N>.log`
  2. Dependency-tree excerpt (Trigger A) or debug stack frame (Trigger B), whichever ran
  3. Classifications applied per retry
  4. 2–4 candidate next actions (typically: pin a different connector version, revert one flow-XML edit, request a Mode-C describe of the failing config)

---

## Step 17: MUnit Loop

Runs ONLY after Step 16 reports `BUILD SUCCESS`. `mvn clean package` validates packaging only — `mvn test` is the authoritative runtime gate.

```bash
grep -c 'munit-maven-plugin' pom.xml
```

- `0` → no MUnit wired. Log `no runtime validation performed — fixture does not declare munit-maven-plugin` and skip the loop.
- `>= 1` → MUnit is present. Enter the loop.

**One `mvn test` per response.** On failure, apply the same recovery classifier from `references/execute-connector-upgrades.md §4` (attribute-rename, element-rename, connection-provider element name, enum-value, assertion-shape). MUnit failures classify against the same Mode-B `.attributes[] / .childElements[] / .output*` JSON as flow-XML failures.

**Retry budget: 5–6 attempts.** MUnit failures are more diffuse than XSD/DSL failures, so the budget is looser than Step 16's 3-retry cap. After the 6th failed `mvn test`, HALT via `AskUserQuestion` with the last three `tmp/mvn-failures/munit-<attempt>.log` excerpts (first 30 lines each), classifications, edits applied, and 2–4 candidate next actions.

Do NOT attempt a 7th retry without user direction. Full loop spec: `references/execute-connector-upgrades.md §4.5`.

- Run `mvn test`
- Fix MUnit tests
- Repeat until all tests pass

---

## Step 18: Check DW Unauthorized Fields

(To be implemented)

- Run introspection for DataWeave unauthorized field access
- Surface results to user

---

## Step 19: Bump Parent POM Version

(To be implemented)

**Conditional:** Only run this step if the parent POM was modified in Step 14 (connector versions inherited from parent).

- Ask user for version bump (major/minor/patch)
- Update parent POM's own `<version>` element
- Update child app's `<parent><version>` reference to match

---

## Step 20: Clean Up Workspace `tmp/`

See `references/execute-connector-upgrades.md` §6 — `rm -r tmp/` must run in a separate response from the build, per the discipline block at the top of this file.

Remove temporary files created during upgrade:

```bash
rm -r tmp/
```

---

## Step 21: Declare Completion

**Its own response.** No `mvn`, no `rm`, no other tool calls. This response's only job is the three-line summary. Preconditions:

1. Step 16 last returned `BUILD SUCCESS` on the upgraded project.
2. Step 17 either recorded `mvn test` passed OR wrote `no runtime validation performed — fixture does not declare munit-maven-plugin`.
3. Step 20 (`rm -r tmp/`) already ran in a previous response.

Emit exactly three lines:

1. `BUILD SUCCESS` with the path to `target/<project>-*.jar`.
2. MUnit verdict from Step 17 (`mvn test: all passing` OR `no runtime validation performed — fixture does not declare munit-maven-plugin`).
3. One-line from-to summary: `Mule <from> → 4.10.5, Java <from> → 17, connectors: <N> updated`.

Do NOT include per-file diffs, "what was done" recaps, or speculative "next steps" — the user can read the diff.

Present final summary:
- Target versions achieved (Java, Mule Runtime)
- Connectors updated (count and versions)
- Build status: SUCCESS
- Tests status: ALL PASSING
- Next steps: review changes, commit, deploy

---

## Troubleshooting

**JAVA_HOME not set:** `export JAVA_HOME=$(/usr/libexec/java_home -v 11)`

**anypoint-cli-v4 not found:** `npm install -g @mulesoft/anypoint-cli-v4`

**DX plugin not found:** `npm install -g @salesforce/anypoint-cli-dx-mule-plugin`

**Runtime path required:** first use of `dx mule describe-connector` or related commands prompts for runtime location. The path is saved to `~/.mule-dx/config.json`.

**Parent POM not available:** check workspace or local `.m2` repository. Parent POM must be accessible locally to resolve inherited versions.

**Connector not in Exchange:** cannot upgrade automatically. Flag as blocker and inform user.

**Build fails after version update:** review connector operation changes from describe-connector output. Update flow XML to match new operation signatures.

**MUnit tests fail:** update test mocks and assertions to match new connector operation signatures and response shapes.

---

## Quick Reference

`<skill-dir>` below is the absolute path you were given in the "skill is now active" message. Use it consistently — do not construct relative `../scripts/...` paths.

```bash
# Placeholder for command reference as scripts are added
```
