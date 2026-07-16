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

(To be implemented)

- User is in app directory
- App available locally (mule-artifact.json and pom.xml exist)
- Parent POM availability (if referenced)

---

## Step 2: Get Current Versions

(To be implemented)

- Get current Mule version from pom.xml
- Get current Java version from mule-artifact.json

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

See `references/plan-connector-upgrades.md` §2–§5 (Mode-A summary, usage enumeration, Mode-B per-op, Mode-C per-config-provider).

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

See `references/plan-connector-upgrades.md` §7 (plan synthesis, approval gate) and §8 (Phase-C completeness checklist — run before user is asked to approve).

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

See `references/execute-connector-upgrades.md` §6 — `rm -r tmp/` must run in a separate response from the build, per the discipline block at the top of this file.

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
