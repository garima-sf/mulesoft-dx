---
name: upgrade-mule-app
description: Workflow required before any Mule application upgrade work. Call use_skill as your FIRST action — before reading project files (pom.xml, mule-artifact.json) or editing versions yourself — whenever the user asks to upgrade, migrate, bump, modernize, or move a Mule app to a newer Java version, a newer Mule Runtime version, or both. Covers upgrading Java and/or Mule Runtime, getting latest compatible connector versions, updating connector and plugin versions, and fixing impacts from operation changes in flows, DataWeave scripts, and MUnit tests. Even a targeted single-version bump like 'move this app to Java 17' or 'upgrade the runtime to 4.6' requires this workflow — do not hand-edit pom.xml versions and attempt the change yourself. When you call this skill, it must be the only tool call in that response.
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

**Requires:** Mule Runtime **4.4+** and Java **8+**. Apps below either are not supported, upgrade to the baseline first.

**Required files in project:**
- `mule-artifact.json` - Mule application metadata
- `pom.xml` - Maven configuration
- Parent POM (if referenced in `pom.xml`)

---

## Bundled scripts

This skill ships small scripts under `scripts/`. Invoke them with the `Bash` tool — do not inline their contents into a response. The scripts persist their output to disk so later steps can consume it mechanically and are not at the mercy of shell variables that vanish when a Bash tool call returns:

| Script | Purpose | Output location |
| --- | --- | --- |
| `scripts/validate_prerequisites.mjs` | Step 1 — validate app directory (`pom.xml` + `mule-artifact.json`), parent-POM availability (if referenced), Anypoint CLI v4, DX plugin. Validation-ONLY; exits non-zero when `errors[]` is non-empty | `tmp/upgrade-prereqs.json` (contains `inAppDir`, `parentDeclared`, `parentFound`, `cliPresent`, `dxPluginPresent`, `errors[]`, ...) |
| `scripts/detect_current_mule_version.mjs` | Step 2a — determine the current Mule Runtime version from the `app.runtime` property (child, then parent `pom.xml`), and flag versions below the supported floor (4.4) | `tmp/current-mule-version.json` (contains `version`, `source`, `resolvedFrom`, `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `warnings[]`, ...) |
| `scripts/detect_current_java_version.mjs` | Step 2b — determine the current Java version from `mule-artifact.json` `javaSpecificationVersions`, and flag versions below the supported floor (8) | `tmp/current-java-version.json` (contains `version`, `source`, `supportedVersions`, `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `warnings[]`, ...) |
| `scripts/resolve_jdk.mjs` | Step 3 & Phase 2 — ensure a JDK for a given Java **major** is available and report a usable `JAVA_HOME`. Resolves major → full build string (e.g. `8` → `8.0.472_8`) via `dx mule runtime list` (matrix-file fallback), reuses an already-installed JDK (`$JAVA_HOME` or the Anypoint Code Builder java dir), and downloads only when none is present. MAY download (network) unless `--no-download` | `tmp/resolve-jdk-<major>.json` (contains `major`, `requestedBuild`, `javaHome`, `javaBin`, `source`, `downloaded`, `available`, `errors[]`, ...) |
| `scripts/resolve_target_versions.mjs` | Step 4 — determine the recommended upgrade target (in-channel: highest minor, latest patch, latest non-EOL Java) from the current versions + live `dx mule runtime list`, and validate a user-requested target (`TARGET_MULE`/`TARGET_JAVA`) against the locked policy. Advisory — always exits 0; caller branches on fields | `tmp/target-versions.json` (contains `currentMule`, `currentJava`, `channel`, `options[]`, `requestedTarget` {`accepted`, `mule`, `java`, `reasonCode`, `reason`, `crossChannel`, `warning`}, `nothingToUpgrade`, `needsUserPrompt`, `warnings[]`, ...) |
| `scripts/test_resolve_target_versions.mjs` | Test-only — runs the target-selection policy against a stubbed runtime list (no app, no CLI, no network) and asserts the recommendation + requested-target rules. Run with `node scripts/test_resolve_target_versions.mjs`; exits non-zero on any failure | (stdout pass/fail; no persisted output) |
| `scripts/_pom_utils.mjs` | Shared library — tolerant XML parser, `${...}` property resolution, and parent-POM location (with parent-identity verification) used by the detection/validation scripts above. Not invoked directly | (imported) |

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

Run the prerequisite validation script. It only validates — it writes nothing to the project and never prompts:

```bash
node scripts/validate_prerequisites.mjs .
```

It writes the validation findings to `tmp/upgrade-prereqs.json` (read fields with `jq`, e.g. `jq -r '.parentFound' tmp/upgrade-prereqs.json`). **If the script exits non-zero (i.e. `errors[]` is non-empty), STOP and act on the errors before progressing.** The most common ones:

- **Not in an app directory** (`pom.xml` / `mule-artifact.json` missing) → tell the user to run from the Mule application root.
- **Parent POM declared but not found locally** (`parentDeclared: true`, `parentFound: false`) → the parent is required both for version detection (Step 2) and for Phase 2 edits (inherited connector/plugin versions, Steps 14/19). Ask the user to make the parent POM available at a local relative path (resolvable from the child's `<parent><relativePath>`, or the default `../pom.xml`) and re-run. **Do not attempt to download it.**
- **Toolchain missing** (`cliPresent` / `dxPluginPresent` false) → point the user at the install commands in Prerequisites.

Only proceed to Step 2 once the script exits zero.

---

## Step 2: Get Current Versions

### 2a. Current Mule Runtime version

Run the detection script (do not parse the POM inline — the script reads the `app.runtime` property from the child, then parent `pom.xml`, resolving `${...}`):

```bash
node scripts/detect_current_mule_version.mjs .
```

It writes the result to `tmp/current-mule-version.json`. Read fields from the file with `jq` (e.g. `jq -r '.version' tmp/current-mule-version.json`) and branch on it:

- **`belowFloor: true`** → the detected `version` is below the minimum supported Mule Runtime (`minSupportedVersion`, currently 4.4). This app is **out of scope** — there is no valid version to prompt for. **Stop** and tell the user to upgrade the app to at least that version before running this skill (see `warnings`).
- **`version` set, `needsUserPrompt: false`** → use `version` as the current Mule Runtime version. Continue.
- **`needsUserPrompt: true`** → the script could not settle on a trustworthy version. Inspect `warnings`:
  - parent declared but not found locally → ask the user to make the parent POM available locally, then re-run this step. **Do not attempt to download it.**
  - otherwise (nothing resolvable) → ask the user for the current Mule Runtime version. If they cannot provide it, **stop**.

**Floor also applies to a user-supplied version.** Whenever you obtain the current Mule version from the user (any prompt above), apply the same floor yourself: if it is below `minSupportedVersion` (4.4), the app is out of scope — **stop** with the same guidance. The script only floor-checks the version *it* detected; a value the user typed is yours to validate.

Detection source (implemented by the script): the `app.runtime` property — checked in the child `pom.xml`, then the parent `pom.xml` — resolving `${...}` against the merged child+parent properties. This is the only source used for the MRT version. An unresolvable reference falls through to the prompt rather than being accepted literally.

### 2b. Current Java version

Run the detection script (do not read `mule-artifact.json` inline — the script reads `javaSpecificationVersions`):

```bash
node scripts/detect_current_java_version.mjs .
```

It writes the result to `tmp/current-java-version.json`. Read fields from the file with `jq` (e.g. `jq -r '.version' tmp/current-java-version.json`) and branch on it:

- **`belowFloor: true`** → the detected `version` is below the minimum supported Java (`minSupportedVersion`, currently 8). This app is **out of scope** — **stop** and tell the user to upgrade the app to at least Java 8 before running this skill (see `warnings`).
- **`version` set, `needsUserPrompt: false`** → use `version` as the current Java version. Continue.
- **`needsUserPrompt: true`** → inspect `warnings` / `supportedVersions`:
  - `supportedVersions` has multiple entries → `mule-artifact.json` declares support for several Java versions; ask the user which one the app currently runs on, then continue.
  - otherwise (`javaSpecificationVersions` absent/empty, or no `mule-artifact.json`) → ask the user for the current Java version. If they cannot provide it, **stop**.

**Floor also applies to a user-supplied version.** Whenever you obtain the current Java version from the user (any prompt above), apply the same floor yourself: if it is below `minSupportedVersion` (8), the app is out of scope — **stop** with the same guidance. The script only floor-checks the version *it* detected.

Detection source (implemented by the script): `mule-artifact.json` `javaSpecificationVersions` — one entry → use it; multiple → prompt which one; absent/empty (or no `mule-artifact.json`) → prompt the user. This is the only source used for the Java version; `pom.xml` compiler settings are not used as a fallback (they are the compile target, not the deployed runtime Java). Values are normalized (`1.8` → `8`).

---

## Step 3: Build Baseline

Establish that the app builds **on its current versions** before changing anything. A green baseline is the reference point every later step is measured against — if the app doesn't build now, upgrade findings are meaningless.

### 3a. Confirm current versions (detected values only)

Read `tmp/current-mule-version.json` and `tmp/current-java-version.json` from Step 2. For each value that was **auto-detected** (`needsUserPrompt: false`), show the user a single confirmation before building:

> Detected your app's current versions — Mule Runtime **{muleVersion}**, Java **{javaVersion}**. Please confirm to proceed.

- Confirm **only** detected values. A value the user already supplied in Step 2 (via a prompt) is already confirmed — **do not re-ask it.** If both came from the user, skip 3a entirely.
- If the user corrects a value, use the corrected value from here on and re-apply the floor check (Mule ≥ 4.4, Java ≥ 8) yourself — a corrected value is user-supplied.

The **confirmed current Java major** that comes out of this step — the `version` field from `tmp/current-java-version.json` (when 2b auto-detected), or the value the user supplied/corrected — is `<current-java-major>` below. Use that same value in both 3b and 3c; do not fall back to the raw detected value if it was corrected here.

### 3b. Ensure the current Java JDK is available

The baseline must build on the app's **current** Java, which may differ from whatever `$JAVA_HOME` currently points at. Run the helper with the **confirmed current Java major** from Step 3a (`<current-java-major>`):

```bash
node scripts/resolve_jdk.mjs <current-java-major> .
```

It writes `tmp/resolve-jdk-<major>.json`. Read it and branch:

- **`available: true`** → use `javaHome` for the build. It may have come from `$JAVA_HOME`, an already-installed JDK, or a fresh download (`source` / `downloaded` say which).
- **`errors[]` non-empty (exit 1)** → STOP and surface the errors. Common cause: no JDK of that major installed and no build string resolvable (CLI/DX plugin missing or not authenticated).

This is the same helper Phase 2 uses for the target Java — run it once per Java version needed.

### 3c. Build

Run the baseline build with the resolved `JAVA_HOME` (one `mvn` invocation, nothing else in the response):

```bash
JAVA_HOME=$(jq -r .javaHome tmp/resolve-jdk-<major>.json) mvn clean package
```

- **`BUILD SUCCESS`** → baseline established. Continue to Step 4.
- **Build fails** → STOP. Inform the user the app must build cleanly on its current versions before an upgrade can proceed, and surface the failure. Do not attempt upgrade edits to fix a pre-existing baseline failure.

---

## Step 4: Determine Target Versions

Determine the upgrade target from the confirmed current versions and the **live** runtime list. Never hardcode versions or channels — the script derives everything from `anypoint-cli-v4 dx mule runtime list`.

Run the resolver. It reads the current versions from Step 2's `tmp/` files (or accepts `CURRENT_MULE` / `CURRENT_JAVA` overrides), and — **only if the user has already named a specific target** — validates it when you pass `TARGET_MULE` (and optionally `TARGET_JAVA`):

```bash
# User has NOT named a target yet — just compute the recommendation:
node scripts/resolve_target_versions.mjs .

# User explicitly asked for a specific target (e.g. "move me to 4.11"):
TARGET_MULE=4.11 node scripts/resolve_target_versions.mjs .
```

It writes `tmp/target-versions.json`. Read fields with `jq` and branch:

- **`needsUserPrompt: true`** → the script could not settle on a target (no current versions, or the runtime list could not be fetched). Inspect `warnings`: a fetch failure means the CLI is not authenticated (`anypoint-cli-v4 conf`) or offline — surface it and re-run. Do not invent versions.
- **`nothingToUpgrade: true`** → the app is already on the latest runtime in its channel at the latest patch, on the latest non-EOL Java. Tell the user there is nothing to upgrade and **stop** — do not proceed to Phase 2.
- **`options[]` non-empty** → this is the **recommended** target (always in-channel: highest minor in the current channel, latest patch, latest non-EOL Java). There is exactly one entry today. Present it as the recommendation.

### 4a. Present the recommendation and get the user's target

The recommendation in `options[0]` is what you propose by default. **Always recommend staying in-channel**, regardless of what the user later chooses. Show it to the user:

> Recommended upgrade: **Mule {options[0].mule}, Java {options[0].java}** ({kind}). {options[0].note, if present}

Then ask whether they want the recommended target or a different one (Java + Mule vs. a specific Mule version). Use `AskUserQuestion` when the choice is not already clear from their original request.

### 4b. If the user names a specific target, validate it

When the user asks for a target other than the recommendation, re-run the script with `TARGET_MULE` (and `TARGET_JAVA` if they named a Java). Read `requestedTarget` from the output and branch on it:

- **`accepted: false`** → the target violates the locked policy. Surface `requestedTarget.reason` verbatim and re-offer the recommendation. Do **not** hand-edit around the refusal. `reasonCode` is one of:
  - `downgrade` — target is not strictly higher than current (this skill only upgrades).
  - `eol-java` — target keeps/selects EOL Java (8/11); the skill exists to move apps off EOL Java.
  - `unsupported-combo` — the target Mule does not support the requested Java.
  - `unknown-version` — the requested Mule is not in the runtime list.
- **`accepted: true` and `crossChannel: false`** → in-channel target (including a valid intermediate like 4.4→4.6, or 4.4→latest-LTS). Proceed with `requestedTarget.mule` / `requestedTarget.java`.
- **`accepted: true` and `crossChannel: true`** → the target switches support channels (LTS↔Edge). This is **allowed, but you MUST warn first.** Surface `requestedTarget.warning` verbatim and get explicit confirmation before proceeding:

  > ⚠️ {requestedTarget.warning}
  >
  > Do you want to proceed with the channel switch, or stay on the recommended in-channel target ({options[0].mule})?

  Only continue to Step 5 with the cross-channel target once the user explicitly confirms. If they decline, fall back to the recommended in-channel target.

### 4c. Lock the target

The values you carry into Step 5 and Phase 2 are: **target Mule** and **target Java** — either `options[0]` (recommendation accepted) or `requestedTarget` (a validated, user-confirmed target). Note whether Java changes (`javaChanged`) and whether the parent POM will need touching later. Do not proceed until the user has confirmed a single concrete target.

---

## Step 5: Run Introspection

(To be implemented)

- Scan app JAR for Mule and Java compatibility

---

## Step 6: Get Connector Versions

(To be implemented)

- Check if each connector from pom is available in Exchange
- Get min + latest compatible versions for each connector

---

## Step 7: Check Operations/Configs/Error Types Changes

(To be implemented)

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

(To be implemented)

- Identify DataWeave scripts in flows
- Check for Java version incompatibilities
- Flag deprecated functions or syntax

---

## Step 10: Check MUnit Compatibility

(To be implemented)

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

(To be implemented)

- Display all version updates
- Show connector version changes
- Show operation/config/error type changes
- Show plugin updates
- Flag blockers
- **⚠️ APPROVAL GATE:** Wait for user approval before proceeding to execution

---

# Phase 2: Execute

## Step 13: Download Runtime and Java

(To be implemented)

- Download target Java version (if Java upgrade)
- Download target MRT (if MRT upgrade)
- Update JAVA_HOME and runtime paths

---

## Step 14: Update Files - Versions Only

(To be implemented)

- Update mule-artifact.json (minMuleVersion, javaSpecificationVersions)
- Update pom.xml (runtime version, Java version, connector versions, plugin versions)
- Update parent POM (if applicable)

---

## Step 15: Update Application Code

(To be implemented)

Update application code based on analysis from Phase 1:

- Update flows for connector operation changes (based on Step 7 analysis)
- Update configuration components for config changes
- Update DataWeave scripts for compatibility issues (based on Step 9 analysis)
- Update custom Java classes for version incompatibilities (based on Step 8 analysis)
- Update MUnit test files for connector changes (based on Step 10 analysis) <!-- TODO: verify if MUnit test files should be updated before build or after -->

Use metadata from `describe-connector` to ensure operations, configs, and attributes match new connector versions.

---

## Step 16: Build Loop

(To be implemented)

- Run `mvn clean package -DskipTests`
- If build fails, parse errors and fix remaining issues
- Repeat until build succeeds

---

## Step 17: MUnit Loop

(To be implemented)

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

(To be implemented)

Remove temporary files created during upgrade:

```bash
rm -r tmp/
```

---

## Step 21: Declare Completion

(To be implemented)

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

**Parent POM not available:** the parent POM must be accessible locally to resolve inherited versions. Do **not** attempt to download it — ask the user to make it available locally, then re-run Step 2.

**Connector not in Exchange:** cannot upgrade automatically. Flag as blocker and inform user.

**Build fails after version update:** review connector operation changes from describe-connector output. Update flow XML to match new operation signatures.

**MUnit tests fail:** update test mocks and assertions to match new connector operation signatures and response shapes.

---

## Quick Reference

`<skill-dir>` below is the absolute path you were given in the "skill is now active" message. Use it consistently — do not construct relative `../scripts/...` paths.

```bash
# Step 1 — validate prerequisites (writes tmp/upgrade-prereqs.json; non-zero exit => STOP)
node <skill-dir>/scripts/validate_prerequisites.mjs .

# Step 2a — detect current Mule Runtime version (writes tmp/current-mule-version.json)
node <skill-dir>/scripts/detect_current_mule_version.mjs .

# Step 2b — detect current Java version (writes tmp/current-java-version.json)
node <skill-dir>/scripts/detect_current_java_version.mjs .

# Step 3b — ensure the current Java JDK is available (writes tmp/resolve-jdk-<major>.json)
# MAY download over the network; pass --no-download to only detect an installed JDK.
node <skill-dir>/scripts/resolve_jdk.mjs <current-java-major> .

# Step 3c — baseline build on the resolved JAVA_HOME (must be BUILD SUCCESS)
JAVA_HOME=$(jq -r .javaHome tmp/resolve-jdk-<major>.json) mvn clean package

# Step 4 — recommend a target (writes tmp/target-versions.json)
node <skill-dir>/scripts/resolve_target_versions.mjs .

# Step 4 — validate a user-requested target (only when the user named one)
TARGET_MULE=4.11 node <skill-dir>/scripts/resolve_target_versions.mjs .
```
