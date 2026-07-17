---
name: upgrade-mule-app
description: Upgrades Java version and/or Mule Runtime, gets latest compatible connector versions, updates connector versions, and fixes impacts from operation changes in flows, DataWeave scripts, and MUnit tests. Supports Java upgrades, Mule Runtime upgrades, or both. Call this skill when users request to upgrade Java version, Mule runtime version, or modernize existing Mule applications.
license: Apache-2.0
compatibility: Requires Anypoint CLI v4 with the `@salesforce/anypoint-cli-dx-mule-plugin` DX plugin, Java 8+, Mule Runtime
metadata:
  author: mule-dx-tooling
  version: "1.0.0"
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

This skill ships small bash scripts under `scripts/`. Invoke them with the `Bash` tool — do not inline their contents into a response. The scripts persist their output to disk so later steps can consume it mechanically and are not at the mercy of shell variables that vanish when a Bash tool call returns:

| Script | Purpose | Output location |
| --- | --- | --- |
| (To be added as scripts are implemented) | | |

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

For each connector nickname `<nick>` in `tmp/upgrade-targets.json`:

```bash
<skill-dir>/scripts/describe_connector.sh <nick>-new
```

Writes `tmp/connector-metadata/<nick>-new.json` — the top-level summary (operations, sources, configs, errorTypes, supportedJavaVersions). This is the input to Step 7's Mode-B (per-op) and Mode-C (per-config-provider) describes.

Full algorithm and JSON shape: `references/plan-connector-upgrades.md §2 (Mode-A summary describe)`.

- Scan app JAR for Mule and Java compatibility

---

## Step 6: Get Connector Versions

For each in-scope connector, resolve the latest Java-17-compatible version via Exchange. Fan out in parallel, capped at 10 concurrent probes.

```bash
mkdir -p tmp/connector-choices

while IFS='|' read -r G A N; do
  <skill-dir>/scripts/get_java17_compatible_connector.sh "$G" "$A" "$N" &
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

**Before invoking Mode-B**, intersect `usage.operations_used[]` with `<nick>-new.json .operations[]`:

- Op present in `.operations[]` → run Mode-B on it.
- Op **absent** from `.operations[]` → the op was renamed or removed. Pick the closest rename candidate (Levenshtein-close or same semantic role — e.g. S3 8.x: `createObject` → `putObject`, `readObject` → `getObject`) and run Mode-B on the **candidate**. Log the guessed rename in `tmp/connector-metadata/<nick>-op-renames.json` so §7's plan enumerates it explicitly. Never silently skip an op — the flow XML still calls it.

**After Mode-B / Mode-C complete**, run the mandatory diffs listed in §8 (`references/plan-connector-upgrades.md`):

- Mode-B `.attributes[].attributeName` (NOT `.name`) vs `usage.usage_sites[].attributes_set` keys → attribute renames
- `usage.errorTypes_caught[]` vs Mode-B `.errorTypes[]` ∪ Mode-A `.errorTypes[]` → error-type renames (**mandatory**, not opportunistic — deferring these to build-time self-correction consumes retry budget)
- Mode-C `.connectionProviders[].childElements[]` vs OLD flow provider-child tree → child reparenting (e.g. mule-db-connector 1.16.x moves `<db:pooling-profile>` from `<db:config>` child to `<db:oracle-connection>` child)

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

Java-17 coercion hot spots (`as Number`, `now() as String`, `error.errorType.identifier`) are checked opportunistically during the same read pass — no separate scan.

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

## Step 12: Present Plan & Get Approval

See `references/plan-connector-upgrades.md` §7 (plan synthesis, approval gate) and §8 (Phase-C completeness checklist — run before user is asked to approve).

Concrete flow for this step:

1. Verify §8 completeness checklist first — every connector has a `-new.json`, every used op has a `-new-<op>.json`, every used (config, provider) pair has a `-new-<config>-<provider>.json`. If any artifact is missing, loop back to Step 5/6/7 and do not present a partial plan.
2. `Read` the file `tmp/upgrade-plan.md` produced by §7.
3. Print its full contents inline in the response as fenced markdown so the user can review without opening another file.
4. Use `AskUserQuestion` with three options:
   - `Yes, proceed to Execution`
   - `No, I want to change the plan`
   - `No, cancel the upgrade`
5. **WAIT for the explicit "Yes, proceed to Execution."** before advancing to Step 13.

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
<skill-dir>/scripts/promote_new_connector_pins.sh
<skill-dir>/scripts/apply_runtime_bump.sh .
```

`apply_runtime_bump.sh` exits 2 if the running JDK does not match `tmp/upgrade-targets.json .java.to`. Hand its stdout instruction to the user via `AskUserQuestion` verbatim and WAIT for confirmation before continuing.

Then per connector:

```bash
for nick in $(jq -r '.connectors[].nick' tmp/upgrade-targets.json); do
  <skill-dir>/scripts/apply_connector_pin.sh "$nick" .
done
```

Then re-describe each pinned connector so downstream validators use the NEW error catalog:

```bash
for nick in $(jq -r '.connectors[].nick' tmp/upgrade-targets.json); do
  <skill-dir>/scripts/describe_connector.sh "$nick"          # no -new suffix
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

- Run `mvn clean package -DskipTests`
- If build fails, parse errors and fix remaining issues
- Repeat until build succeeds

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
