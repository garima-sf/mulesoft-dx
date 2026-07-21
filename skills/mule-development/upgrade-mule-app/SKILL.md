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
| `scripts/validate_prerequisites.mjs` | Step 1 — validate app directory (`pom.xml` + `mule-artifact.json`), parent-POM availability (if referenced), `JAVA_HOME` / `java -version`, Anypoint CLI v4, DX plugin. Validation-ONLY; exits non-zero when `errors[]` is non-empty | `tmp/upgrade-prereqs.json` (contains `inAppDir`, `parentDeclared`, `parentFound`, `javaVersion`, `cliPresent`, `dxPluginPresent`, `errors[]`, ...) |
| `scripts/detect_current_mule_version.mjs` | Step 2a — determine the current Mule Runtime version from child/parent `pom.xml`, cross-check `mule-artifact.json` `minMuleVersion`, and flag versions below the supported floor (4.4) | `tmp/current-mule-version.json` (contains `version`, `source`, `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `muleArtifact.consistency`, `warnings[]`, ...) |
| `scripts/detect_current_java_version.mjs` | Step 2b — determine the current Java version from `mule-artifact.json` `javaSpecificationVersions`, falling back to `pom.xml` compiler settings (child/parent), and flag versions below the supported floor (8) | `tmp/current-java-version.json` (contains `version`, `source`, `supportedVersions`, `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `warnings[]`, ...) |
| `scripts/_pom_utils.mjs` | Shared library — tolerant XML parser, `${...}` property resolution, and parent-POM location used by the three scripts above. Not invoked directly | (imported) |

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

It writes `tmp/upgrade-prereqs.json` and prints the same object. **If the script exits non-zero (i.e. `errors[]` is non-empty), STOP and act on the errors before progressing.** The most common ones:

- **Not in an app directory** (`pom.xml` / `mule-artifact.json` missing) → tell the user to run from the Mule application root.
- **Parent POM declared but not found locally** (`parentDeclared: true`, `parentFound: false`) → the parent is required both for version detection (Step 2) and for Phase 2 edits (inherited connector/plugin versions, Steps 14/19). Ask the user to make the parent POM available locally (workspace or `~/.m2`) and re-run. **Do not attempt to download it.**
- **Toolchain missing** (`javaVersion` null, `cliPresent` / `dxPluginPresent` false) → point the user at the install commands in Prerequisites.

Only proceed to Step 2 once the script exits zero.

---

## Step 2: Get Current Versions

### 2a. Current Mule Runtime version

Run the detection script (do not parse the POM inline — the script implements the full child → parent → property-resolution logic):

```bash
node scripts/detect_current_mule_version.mjs .
```

It writes `tmp/current-mule-version.json` and prints the same object. Read the result and branch on it:

- **`belowFloor: true`** → the detected `version` is below the minimum supported Mule Runtime (`minSupportedVersion`, currently 4.4). This app is **out of scope** — there is no valid version to prompt for. **Stop** and tell the user to upgrade the app to at least that version before running this skill (see `warnings`).
- **`version` set, `needsUserPrompt: false`** → use `version` as the current Mule Runtime version. Continue.
- **`needsUserPrompt: true`** → the script could not settle on a trustworthy version. Inspect `warnings` / `consistency`:
  - `consistency: "below-min"` → the detected `version` is **below** `mule-artifact.json`'s `minMuleVersion` (inconsistent config). Show the user both the detected version and the floor, ask them to confirm or correct the current version, then continue with the confirmed value. If they cannot, **stop**.
  - parent declared but not found locally → ask the user to make the parent POM available locally, then re-run this step. **Do not attempt to download it.**
  - otherwise (nothing resolvable) → ask the user for the current Mule Runtime version. If they cannot provide it, **stop**.

**Floor also applies to a user-supplied version.** Whenever you obtain the current Mule version from the user (any prompt above), apply the same floor yourself: if it is below `minSupportedVersion` (4.4), the app is out of scope — **stop** with the same guidance. The script only floor-checks the version *it* detected; a value the user typed is yours to validate.

Detection order (implemented by the script): child `pom.xml` plugin `<muleVersion>`, then child runtime property (`app.runtime`, then `mule.version`), then the same in the parent POM, resolving `${...}` against the merged child+parent properties. Unresolvable references fall through rather than being accepted literally.

### 2b. Current Java version

Run the detection script (do not read `mule-artifact.json` inline — the script implements the full mule-artifact → POM fallback with `${...}` resolution):

```bash
node scripts/detect_current_java_version.mjs .
```

It writes `tmp/current-java-version.json` and prints the same object. Read the result and branch on it:

- **`belowFloor: true`** → the detected `version` is below the minimum supported Java (`minSupportedVersion`, currently 8). This app is **out of scope** — **stop** and tell the user to upgrade the app to at least Java 8 before running this skill (see `warnings`).
- **`version` set, `needsUserPrompt: false`** → use `version` as the current Java version. If `source` starts with `pom.` you MAY confirm it with the user (it is the compile target, not guaranteed to be the runtime Java), but proceeding is fine.
- **`needsUserPrompt: true`** → inspect `warnings` / `supportedVersions`:
  - `supportedVersions` has multiple entries → `mule-artifact.json` declares support for several Java versions; ask the user which one the app currently runs on, then continue.
  - parent declared but not found locally → ask the user to make the parent POM available locally, then re-run this step. **Do not attempt to download it.**
  - otherwise (nothing resolvable) → ask the user for the current Java version. If they cannot provide it, **stop**.

**Floor also applies to a user-supplied version.** Whenever you obtain the current Java version from the user (any prompt above), apply the same floor yourself: if it is below `minSupportedVersion` (8), the app is out of scope — **stop** with the same guidance. The script only floor-checks the version *it* detected.

Detection order (implemented by the script): `mule-artifact.json` `javaSpecificationVersions` (one entry → use it; multiple → prompt); if absent/empty, fall back to `pom.xml` compiler settings (`maven-compiler-plugin` `release`/`source`/`target`, then properties `maven.compiler.release`/`source`/`target`, `java.version`) across child and parent, resolving `${...}` and normalizing `1.8` → `8`.

---

## Step 3: Build Baseline

(To be implemented)

- Run `mvn clean package` on current version
- Verify app builds successfully
- Establish baseline JAR for introspection

If build fails, STOP and inform user the app must build on current version before upgrade.

---

## Step 4: Determine Target Versions

(To be implemented)

- Ask user: Java upgrade, Mule upgrade, or both?
- Get or suggest target versions
- Confirm with user

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
```
