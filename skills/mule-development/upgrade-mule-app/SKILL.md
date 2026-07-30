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

This skill ships small Node.js (ESM, zero-dep) scripts under `scripts/`. Invoke them with the `Bash` tool — do not inline their contents into a response. The scripts persist their output to disk so later steps can consume it mechanically and are not at the mercy of shell variables that vanish when a Bash tool call returns:

| Script | Purpose | Output location |
| --- | --- | --- |
| `scripts/validate_prerequisites.mjs` | Step 1 — validate app directory (`pom.xml` + `mule-artifact.json`), parent-POM availability (if referenced), Anypoint CLI v4, DX plugin. Validation-ONLY; exits non-zero when `errors[]` is non-empty | `tmp/upgrade-prereqs.json` (contains `inAppDir`, `parentDeclared`, `parentFound`, `cliPresent`, `dxPluginPresent`, `errors[]`, ...) |
| `scripts/detect_current_mule_version.mjs` | Step 2a — determine the current Mule Runtime version from the `app.runtime` property, searching the child `pom.xml` then its full local parent chain (parent, grandparent, …) with `${...}` resolved against the merged chain, and flag versions below the supported floor (4.4) | `tmp/current-mule-version.json` (contains `version`, `source`, `resolvedFrom` (`"child"` \| `"parent"` \| `"ancestor"`), `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `warnings[]`, ...) |
| `scripts/detect_current_java_version.mjs` | Step 2b — determine the current Java version from `mule-artifact.json` `javaSpecificationVersions`, and flag versions below the supported floor (8) | `tmp/current-java-version.json` (contains `version`, `source`, `supportedVersions`, `needsUserPrompt`, `belowFloor`, `minSupportedVersion`, `warnings[]`, ...) |
| `scripts/resolve_jdk.mjs` | Step 3 & Phase 2 — ensure a JDK for a given Java **major** is available and report a usable `JAVA_HOME`. Resolves major → full build string (e.g. `8` → `8.0.472_8`) via `dx mule runtime list` (matrix-file fallback), reuses an already-installed JDK under the Anypoint Code Builder java dir, and downloads only when none is present. MAY download (network) unless `--no-download` | `tmp/resolve-jdk-<major>.json` (contains `major`, `requestedBuild`, `javaHome`, `javaBin`, `source`, `downloaded`, `available`, `errors[]`, ...) |
| `scripts/resolve_target_versions.mjs` | Step 4 — determine the recommended upgrade target (in-channel: highest minor, latest patch, latest non-EOL Java) from the current versions + live `dx mule runtime list`, and validate a user-requested target (`TARGET_MULE`/`TARGET_JAVA`) against the locked policy. Advisory — always exits 0; caller branches on fields | `tmp/target-versions.json` (contains `currentMule`, `currentJava`, `channel`, `options[]`, `requestedTarget` {`accepted`, `mule`, `java`, `reasonCode`, `reason`, `crossChannel`, `warning`, `belowRecommended`, `note`}, `requestedJavaOnly` {`java`, `supported`, `supportedJavas[]`, `recommendedMule`, `recommendedJava`, `note`}, `nothingToUpgrade`, `needsUserPrompt`, `warnings[]`, ...) |
| `scripts/extract_connectors.mjs` | Step 5a — extract the connector dependencies (`<classifier>mule-plugin</classifier>`, non-test-scoped) from the app's `pom.xml` and its full local ancestor chain (parent, grandparent, …), resolving each version from the local POMs: inline, `${...}` (single, nested, or composite like `${major}.${minor}`), inherited `<dependencies>`, and version-less deps managed in any local `<dependencyManagement>` (this POM's own or an ancestor's). Deterministic static parse; no CLI, no network. Advisory — always exits 0 | `tmp/connectors.json` (contains `connectors[]` {`nick`, `groupId`, `artifactId`, `version`, `versionResolved`, `resolvedFrom`, `versionManagedIn?`}, `excluded[]` (test-scoped), `needsUserPrompt`, `warnings[]`, ...) |
| `scripts/check_connector_java_compat.mjs` | Step 5b — for each connector from Step 5a, `exchange asset describe <groupId>/<assetId>/<version>` (exact lookup, with retries) and read its `is-java-*-supported` tags to report which Java versions the CURRENT in-use version supports. HARD-STOPS (exit 1, `stop: true`) when a connector cannot be verified: describe fails (not resolvable in Exchange), or no `is-java-*` tags are present | `tmp/connector-java-compat.json` (contains `connectors[]` {`nick`, `groupId`, `artifactId`, `version`, `supportedJava[]`, `blocked`, `blockReason`}, `blocked[]`, `stop`, `warnings[]`, ...) |
| `scripts/resolve_target_connectors.mjs` | Step 6 — for each connector from Step 5, find the LATEST published version that supports BOTH the target Mule and target Java (from Step 4). One `exchange asset describe` per connector returns every sibling version with its own `min-mule-version` / `is-java-*-supported` tags; filters locally to versions where `is-java-<targetJava>-supported == true` AND `min-mule-version <= targetMule`, then picks the highest by semver. HARD-STOPS (exit 1, `stop: true`) when a connector has no target-compatible version. Target comes from `TARGET_MULE`/`TARGET_JAVA` env or `tmp/target-versions.json` `options[0]` | `tmp/target-connectors.json` (contains `targetMule`, `targetJava`, `connectors[]` {`nick`, `groupId`, `artifactId`, `currentVersion`, `targetVersion`, `changed`, `candidateCount`, `minMuleVersion`, `supportedJava[]`, `blocked`, `blockReason`}, `blocked[]`, `stop`, `warnings[]`, ...) |
| `scripts/_pom_utils.mjs` | Shared library (Steps 1–6) — tolerant XML parser, `${...}` property resolution (single/nested/composite, cycle-guarded), local parent-POM location (with parent-identity verification), and managed-version lookup across the local ancestor chain. Used by the detection/validation/extraction scripts above. Not invoked directly | (imported) |
| `describe_connector.mjs` | Mode-A/B/C describe of a NEW connector version (summary, per-op, per-config-provider). Invocations (flags — not positional): Mode-A `<nick>-new`; Mode-B `<nick>-new --type operation --name <op>` (or `--type source --name <src>`); Mode-C `<nick>-new --type connection-provider --name <provider> --config-name <config>`. See `references/plan-connector-upgrades.md §2, §4, §5`. | `tmp/connector-metadata/<nick>-new.json`, `<nick>-new-<op>.json`, `<nick>-new-<config>-<provider>.json` |
| `enumerate_usage_xml.mjs` | **Preferred** usage enumerator — parses `src/main/mule/**/*.xml` with `fast-xml-parser`. Identical output to `enumerate_usage.mjs` but correct on messy input (ignores commented-out elements; binds `config-ref` to its owning element). Exits rc=3 if `fast-xml-parser` isn't importable → caller falls back to the grep script. See Step 7 "Usage enumeration". | `tmp/connector-usage/<nick>.json` |
| `enumerate_usage.mjs` | Zero-dependency (regex/grep) usage enumerator — the fallback for `enumerate_usage_xml.mjs`. Scans `src/main/mule/**/*.xml` for a connector's ops, configs, error types, namespace prefix used by the app. The OLD-side source of truth — replaces re-describing the old connector version. See `references/plan-connector-upgrades.md §3`. | `tmp/connector-usage/<nick>.json` |
| `apply_connector_pin.mjs` | Bumps one connector's version in `pom.xml` and rewrites its `xsi:schemaLocation` in every flow XML. Reads `tmp/connector-choices/<nick>-new.json` (GAV, required) and `tmp/connector-metadata/<nick>-new.json` (namespace metadata, **optional** — absent for pom-only connectors, in which case the XSD rewrite no-ops). Deterministic — never hand-edit `xsi:schemaLocation`. | mutates `pom.xml` + `src/main/mule/**/*.xml` |
| `apply_runtime_bump.mjs` | Bumps `<app.runtime>`, `<javaVersion>`, `<maven.compiler.source/target>`, `<mule.maven.plugin.version>` in `pom.xml`, and `minMuleVersion` + `javaSpecificationVersions` in `mule-artifact.json`. Reads targets from `tmp/upgrade-targets.json` (`.mule.to` / `.java.to`). Matrix in `references/runtime-bump-matrix.md`. Exits 2 if running Java doesn't match the target. | mutates `pom.xml` + `mule-artifact.json` (+ `.mvn/jvm.config` on Java 17) |
| `promote_new_connector_pins.mjs` | Copies every `tmp/connector-choices/<nick>-new.json` → `tmp/connector-versions/<nick>.json` so Phase 2's pin script can consume them. Run once, before `apply_connector_pin.mjs`. | `tmp/connector-versions/<nick>.json` |
| `verify_metadata_coverage.mjs` | Step 11.5 gate — for every op / source / provider in `tmp/connector-usage/*.json`, verify a Mode-B / Mode-C JSON exists in `tmp/connector-metadata/`. Exits 1 with FAIL rows when any required per-op / per-provider describe is missing. Configs whose Mode-A `.connectionProviders[]` is empty (D7 fallback — some DB configs) emit INFO and do not fail; Phase C reads Mode-A `.configs[]` directly for those. Optional `--strict` also fails on WARN rows (renamed / removed ops that lack a `<nick>-op-renames.json` entry). | stdout FAIL/WARN/INFO rows |

Shared helpers live in `lib/*.mjs` alongside `scripts/`: `anypoint.mjs` (CLI env scrubbing), `fsx.mjs` (I/O), `platform.mjs` (Java version parsing), `pom-edit.mjs` (pom.xml + mule-artifact.json + XSD rewrites), `xml-flow.mjs` (flow XML grep primitives). Steps 1–6's detection/validation/extraction scripts share `scripts/_pom_utils.mjs` (tolerant XML + `${...}` + parent-POM location + managed-version lookup); Steps 7–21's edit scripts use `lib/pom-edit.mjs` — the two POM helpers are independent and both survive. The pre-2.0.0 bash + Python originals live under `scripts/archive/` for parity reference and rollback; the skill runtime does not invoke them.

Invoke scripts by the absolute path you were given in the "skill is now active" message (it is the directory containing this `SKILL.md`). Do **not** construct relative paths like `../scripts/...` — Cline's working directory shifts across turns and relative paths have produced "No such file or directory" errors in real runs. The inline step examples below write `scripts/...` as shorthand; substitute `<skill-dir>/scripts/...` when you actually execute them.

**Why scripts instead of inline bash:** Persisting to a file on disk makes data available across responses. Shell variables die when the `Bash` tool call returns, but files persist and can be read by later steps.

---

## Workflow shape (two phases)

This workflow has two phases separated by a hard user-approval gate.

- **Phase 1: Plan (Steps 1–12).** Validate prerequisites, get current versions, build baseline, determine target versions, extract connectors and check their current Java compatibility, resolve target-compatible connector versions, analyze plugin/DataWeave/MUnit compatibility, present upgrade plan, wait for user approval. Phase 1 writes **nothing** to project files — all artifacts live under workspace-relative `tmp/` directory. No modifications to `mule-artifact.json`, `pom.xml`, or flows until approval.
- **Phase 2: Execute (Steps 13–21).** Download runtime/Java, update versions, update application code (flows/configs/DW/custom Java), run build loop, run MUnit loop, cleanup workspace, declare completion. Phase 2 is the only phase that modifies project files.

Phase 2 MUST NOT start until Step 12's approval gate has been passed explicitly. Skipping the plan or modifying files before approval defeats the purpose of the two-phase structure.

---

## Workflow-Wide Discipline (read before Phase 1)

- **Build → cleanup → completion separation.** Three responses, in order, each with a single tool call: `mvn clean package`, then `rm -r tmp/`, then the completion signal. Do not bundle them. Wait for each result before moving on.
- **One mvn invocation per response.** When re-running a build after a fix, emit only the `mvn` command in that response. Do not bundle it with further edits, follow-up shell commands, or the completion signal.
- **"Completion" means the build already passed.** You may only declare completion after a response that ran `mvn clean package` came back with `BUILD SUCCESS` and `mvn test` came back with all tests passing.
- **Use the bundled scripts — do not reimplement them.** When a step ships a script (see "Bundled scripts"), run *that script* and read its JSON output. Do **not** hand-roll its logic with raw `anypoint-cli-v4 exchange asset list`/`describe` + `jq`, and do not "verify" or "double-check" its result by querying Exchange yourself. The scripts are the source of truth; they use exact `asset describe` lookups, whereas ad-hoc `asset list` is fuzzy and paginated (it silently misses versions and returns sibling assets), which produces wrong answers. If a script seems wrong, say so and stop — don't route around it. In particular, Step 6 connector target versions come **only** from `resolve_target_connectors.mjs`.
- **Version resolution from scripts/CLI only.** All versions come from the bundled scripts (or, where a step has no script, the CLI command that step names), never hardcoded. Never paste versions from memory or documentation.
- **One step at a time.** Do the current step's work and stop. Do not jump ahead to gather data for later steps (e.g. plugin versions, flow/DataWeave review) while still on Step 6 — each step has its own script and instructions.
- **Java 17+ REQUIRED for every `describe_connector.mjs` call.** Under Java 8 or 11 the Anypoint CLI's `dx mule describe-connector` still exits 0 but returns a DEGRADED response — `configs[]` collapse to `{name, connectionProviders: []}` with no `parameters` / `attributes`, silently hiding required-attribute breaking changes. The skill's Phase-C diff then signs off on a config that is actually broken, and `mvn` fails at `process-classes` with an XSD-validation error (`cvc-complex-type.4: Attribute 'X' must appear on element '<prefix>:<config>'`). Before invoking `describe_connector.mjs` (Mode-A/B/C) in Steps 7 and 14, export a Java 17+ `JAVA_HOME` (Zulu 17 preferred on SFDC laptops for Nexus TLS — see Step 13). The script itself refuses to run under < Java 17 and exits with a fix-it message, so a stale `JAVA_HOME` is caught immediately, not seven steps later at packaging.
- **`not_in_use` skip — the ONLY pre-Mode-B/C skip.** If Step 7's `enumerate_usage.mjs` prints a `not_in_use` JSON on stdout, the connector is declared in `pom.xml` but has zero flow usage. Reduce the plan for that connector to "bump the pom version only — no flow edits, no per-op describe." Skip Mode-B and Mode-C, but keep the connector in the plan under a `pom-only` section so Phase 2 still runs `apply_connector_pin.mjs`. Do NOT invent any other "stable connector" short-circuit — for every connector with real usage, run Mode-B / Mode-C unconditionally and let Step 12's plan synthesis surface "no rewrites" naturally by finding zero per-symbol diffs against the Mode-B / Mode-C JSONs.

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

Do **not** gate on JAVA_HOME pointing at Java 17 here. Step 3 builds the app on its **current** Java (usually 8 or 11); Step 13 is the Java-17 gate.

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

- **`available: true`** → use `javaHome` for the build. It may have come from an already-installed JDK under the Anypoint Code Builder java dir, or a fresh download (`source` / `downloaded` say which).
- **`errors[]` non-empty (exit 1)** → STOP and surface the errors. Common cause: no JDK of that major installed and no build string resolvable (CLI/DX plugin missing or not authenticated).

This is the same helper Phase 2 uses for the target Java — run it once per Java version needed.

### 3c. Build

Run the baseline build with the resolved `JAVA_HOME` (one `mvn` invocation, nothing else in the response):

```bash
JAVA_HOME=$(jq -r .javaHome tmp/resolve-jdk-<major>.json) mvn clean package
```

- **`BUILD SUCCESS`** → baseline established. Continue to Step 4.
- **Build fails** → STOP. Inform the user the app must build cleanly on its current versions before an upgrade can proceed, and surface the failure. Do not attempt upgrade edits to fix a pre-existing baseline failure.

The resulting `target/*.jar` is used by Step 7's Mode-A describe if introspection needs the packaged extension model.

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

**A target is a Mule version.** `TARGET_MULE` is what defines a requested target — only pass it when the user named a specific Mule runtime. Do **not** set `TARGET_MULE` to the current version to express "keep Mule"; that would be read as a downgrade/no-op and refused.

A **bare Java mention** ("upgrade my app to Java 17/11/8/21") is not a separate target — the recommendation always moves Java to the latest non-EOL Java as part of the Mule upgrade. Pass the Java they named via `TARGET_JAVA` alone (no `TARGET_MULE`) so the script can check it against what the recommended runtime supports:

```bash
# User mentioned only a Java version (e.g. "upgrade to Java 17"):
TARGET_JAVA=17 node scripts/resolve_target_versions.mjs .
```

Then always present `options[0]` (the Mule + Java path), and read `requestedJavaOnly`:
- **`requestedJavaOnly: null`** → the Java they named is the one we recommend (or they named none). Just present the recommendation; no extra message.
- **`requestedJavaOnly` set** → the named Java is EOL (8/11) or unsupported by the recommended runtime (e.g. 21). Present the recommendation **and** surface `requestedJavaOnly.note` verbatim — it states their Java isn't a supported target and names the Java we do support.

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
- **`accepted: true` and `crossChannel: false`** → in-channel target (including a valid intermediate like 4.4→4.6, or 4.4→latest-LTS). Show **both** the recommendation and their validated target, then let the user pick — unless their request already equals `options[0]` (same Mule + Java), in which case there is no choice to make and you proceed directly:

  > Recommended: **Mule {options[0].mule}, Java {options[0].java}**. Your requested target: **Mule {requestedTarget.mule}, Java {requestedTarget.java}**
  >
  > Which do you want to proceed with?

  When `requestedTarget.belowRecommended: true` (their valid target is lower than the latest in-channel runtime), surface `requestedTarget.note` verbatim alongside the choice — it states their target isn't the latest and names the one we recommend. Proceed with whichever the user confirms (`requestedTarget.mule` / `requestedTarget.java` if they keep their choice, else `options[0]`).
- **`accepted: true` and `crossChannel: true`** → the target switches support channels (LTS↔Edge). This is **allowed, but you MUST warn first.** Surface `requestedTarget.warning` verbatim and get explicit confirmation before proceeding:

  > ⚠️ {requestedTarget.warning}
  >
  > Do you want to proceed with the channel switch, or stay on the recommended in-channel target ({options[0].mule})?

  Only continue to Step 5 with the cross-channel target once the user explicitly confirms. If they decline, fall back to the recommended in-channel target.

### 4c. Lock the target

The values you carry into Step 5 and Phase 2 are: **target Mule** and **target Java** — either `options[0]` (recommendation accepted) or `requestedTarget` (a validated, user-confirmed target). Note whether Java changes (`javaChanged`) and whether the parent POM will need touching later. Do not proceed until the user has confirmed a single concrete target.

---

## Step 5: Extract Connectors and Check Current Java Compatibility

Identify every connector the app depends on, then report — for the version each one is **currently** pinned to — which Java versions Exchange says it supports. This is what the user sees in the plan: the connectors in use and where each stands on Java today. Resolving the *target*-compatible version is a later step (Step 6).

### 5a. Extract connectors from the POM

Run the extractor. It parses the child `pom.xml` and its full local ancestor chain (parent, grandparent, …) and collects every `<dependency>` carrying `<classifier>mule-plugin</classifier>` that is **not** `<scope>test</scope>`. It captures public and custom connectors identically (the classifier is publisher-agnostic) and, for the same `groupId:artifactId` declared at more than one level, keeps the **nearest** declaration (child over parent over grandparent — Maven's "nearest wins").

```bash
node scripts/extract_connectors.mjs .
```

It writes `tmp/connectors.json`. Read it and branch:

- **`connectors[]`** → the connectors to check. Each has `groupId`, `artifactId`, `version`, `versionResolved`, `resolvedFrom` (`"child"` | `"parent"` | `"ancestor"` for grandparent+), and — when the version came from a `<dependencyManagement>` — `versionManagedIn` (the POM path where an edit must happen, used later by Steps 6/14/19). `version` is `null` **only** when it cannot be resolved from any local POM (see below); Step 5b treats an unresolved version as a block.
- **`excluded[]`** → test-scoped mule-plugins (MUnit tooling). Not application connectors; their versions are handled later with the other build plugins, not via Exchange. Do not check them here.
- **`needsUserPrompt: true`** → no connectors found, or the child POM was missing. Inspect `warnings[]` and confirm with the user before continuing.

**How versions are resolved** (build-free static parse of the local POM chain — no Maven, no network):

- inline `<version>`;
- a `${property}` from any local POM's `<properties>` — single (`${http.version}`), nested/chained (`${a}` → `${b}` → `1.7.3`), or composite (`${major}.${minor}.${patch}`, `1.7.${patch}`), with descendant properties overriding ancestors';
- a version-less `<dependency>` whose version is managed in a local `<dependencyManagement>` — the declaring POM's own, or any ancestor's up the chain;
- a connector declared on an ancestor's `<dependencies>` and inherited by the child.

`version` stays `null` **only** when the value is not available in any local POM: a parent that is not on the filesystem (remote / `~/.m2`), an imported BOM (`<scope>import</scope>`), a `<profiles>` block, or a `${...}` that is unknown or forms a reference cycle. These are the cases that genuinely require Maven's effective model — and they are also cases the version cannot be edited locally — so they are reported as unresolved rather than guessed. A declared-but-missing parent is already a hard stop at Step 1, so it should not reach here; if the extractor still warns about it, stop and ask for the parent POM.

### 5b. Check current-version Java compatibility in Exchange

Run the compatibility check. For each connector it calls `anypoint-cli-v4 exchange asset describe <groupId>/<assetId>/<version>` (an exact lookup — not the fuzzy `asset list`), retrying a few times so a transient network/auth blip is not mistaken for a genuine miss, and reads the `is-java-*-supported` tags.

```bash
node scripts/check_connector_java_compat.mjs .
```

It writes `tmp/connector-java-compat.json` and **exits 1 when `stop: true`**. Read it and branch:

- **`stop: false` (exit 0)** → every connector was resolved locally **and** verified on Exchange. This is the go-ahead. Confirm it to the user with a short success line before continuing, e.g.:

  > ✅ Resolved and verified all {N} connector(s) on Exchange. Current Java support: http 1.7.3 → 8, 11, 17; db 1.13.5 → 8, 11; …

  Then read `connectors[].supportedJava` for each — the Java majors the current version declares support for (e.g. `[8, 11, 17]`). An empty `supportedJava` on a non-blocked connector means the tags are present but all `false`; surface the matching `warnings[]` entry (no supported Java version found for that version). With no blockers, **proceed to Step 6.**

  **Report the current facts only — do not draw target conclusions here.** State what each current version supports today and stop there. Do **not** compare against the target Java/Mule, do **not** say a connector "will need a bump" or "only supports 8/11 so it needs upgrading for 17", and do **not** name any target version. Whether a bump is needed, and to which version, is decided **only** by Step 6 (`resolve_target_connectors.mjs`), which fetches the latest version of each connector that supports **both** the target Java and the target Mule Runtime. Anticipating that in Step 5b pre-empts the script and risks a wrong guess.
  - ✅ Allowed: "db 1.13.5 currently supports Java 8, 11."
  - ❌ Not allowed: "db, file, and sockets support only 8/11 — these will need version bumps for Java 17."
- **`stop: true` / `blocked[]` non-empty (exit 1)** → one or more connectors **could not be verified**, and the upgrade **cannot proceed**. Each blocked connector carries a `blockReason`:
  - **Not found in Exchange** (describe failed after retries) — the connector/version is not resolvable: missing, different published coordinates, a custom connector belonging to another org, or an auth failure. The raw CLI error is included so a genuine miss can be told apart from an authentication problem (`anypoint-cli-v4 conf`).
  - **No Java compatibility information** — describe succeeded but the asset carries no `is-java-*-supported` tags, so nothing can be said about Java support.
  - **Version not resolvable** — the connector's version is inherited/unresolved (see Step 5a), so no Exchange coordinate could be formed.

  Surface the blocked connectors and their reasons to the user and stop — do not continue to Step 6 or Phase 2 until every connector is verifiable.

---

## Step 6: Resolve Target-Compatible Connector Versions

Step 5 reported where each connector stands on Java *today*. This step picks the version each connector will move **to**: the latest published version that runs on the **target** Mule Runtime and Java (from Step 4). This is what the plan proposes as the new pin for every connector.

Run the resolver. It reads the connectors from Step 5a and the target from Step 4.

```bash
node scripts/resolve_target_connectors.mjs .
```

The target defaults to `tmp/target-versions.json` `options[0]` (the recommended target). To resolve against a different target — e.g. a user-confirmed `requestedTarget` from Step 4 — pass it explicitly:

```bash
TARGET_MULE=4.9.0 TARGET_JAVA=17 node scripts/resolve_target_connectors.mjs .
```

**How it selects (one Exchange call per connector).** A single `exchange asset describe <groupId>/<assetId>/<currentVersion>` returns a `.versions[]` array listing *every* sibling version, each already carrying its own `min-mule-version` and `is-java-<major>-supported` tags. So the whole version history is filtered locally from one describe — no paging of the fuzzy `asset list`, no per-version calls. Among all versions it keeps those where **both** hold:

- `is-java-<targetJava>-supported == "true"` — the version supports the target Java, **and**
- `min-mule-version <= targetMule` — the version's runtime floor fits the target Mule (a version with no `min-mule-version` tag does **not** qualify).

It then picks the **highest** qualifying version by semver ("latest that fits target"). This **always** moves each connector to the latest target-compatible version — even a connector whose current pin already runs on the target is bumped to the newest version that fits. A connector stays put only when its current version already **is** that latest target-compatible version (nothing higher to move to), not merely because it happens to be compatible.

It writes `tmp/target-connectors.json` and **exits 1 when `stop: true`**. Read it and branch:

- **`stop: false` (exit 0)** → every connector has a target-compatible version. Present the moves to the user: each `connectors[]` entry has `currentVersion` → `targetVersion`, `changed` (false only when the current version is already the latest target-compatible one — not merely compatible), `minMuleVersion`, and `supportedJava[]`. This is the connector portion of the upgrade plan. Proceed to Step 7.
- **`stop: true` / `blocked[]` non-empty (exit 1)** → one or more connectors have **no** published version that supports the target runtime. The upgrade **cannot proceed** to that target. Each blocked connector carries a `blockReason` (e.g. *No published version supports the target runtime (Mule X, Java Y)*). Surface the blocked connectors to the user and stop. Their options are to pick a different target (re-run Step 4 → Step 6) or wait for the connector to publish a compatible version — do not continue to Phase 2 with an unresolvable connector.

---

## Step 6.5: Stage the downstream data-contracts (bridge)

Steps 7–21 and the Phase-2 mutation scripts do **not** re-read Steps 1–6's individual `tmp/*.json` files. They read two consolidated contracts that this step writes from the outputs you already have. It is the seam between the version-resolution half (Steps 1–6) and the introspection/execute half (Steps 7–21). Assemble both with a `Write` (or a `jq` construction), **not a new script** — no CLI, no network here.

**Why a remap is needed.** Steps 5–6 key each connector by a nickname derived from its **artifact slug** (`mule-amazon-s3-connector` → `amazon-s3`, `mule-objectstore-connector` → `objectstore`). Steps 7/14 key on the **XSD prefix** the flow XML actually binds (`xmlns:s3=…` → `s3`, `xmlns:os=…` → `os`, `xmlns:sfdc=…` → `sfdc`). The Step-7 join between usage (`connector-usage/<prefix>.json`) and metadata/choices (`…/<nick>-new.json`) is an exact string match — so the choices/targets files this step writes **must** be keyed by the XSD prefix, not the slug. Read the bindings from `src/main/mule/**/*.xml` (`grep -ho 'xmlns:[a-zA-Z0-9_-]*=' src/main/mule/*.xml`), and for each connector in `tmp/target-connectors.json` map its `groupId:artifactId` to the prefix whose namespace URI matches that connector (agent judgment — the same mapping the old Step 4.5 used to assign nicks).

**Used vs pom-only — classification falls out of that same xmlns read:**
- **Used** (the connector has an `xmlns:<prefix>` binding somewhere under `src/main/mule/`) → key it by that **prefix**. It gets the full Step 7 (Mode-A + usage + Mode-B/C).
- **pom-only** (no binding anywhere) → key it by its **slug** nick. It gets a choices file only — **no metadata, no describe.** Its version still gets bumped in Phase 2; its (absent) flow XSD URLs no-op harmlessly.

### 6.5a. Per-connector choices — `tmp/connector-choices/<nick>-new.json`

For every connector in `tmp/target-connectors.json`, write one file keyed by its resolved `<nick>` (prefix for used, slug for pom-only):

```json
{ "groupId": "com.mulesoft.connectors", "assetId": "mule-amazon-s3-connector", "version": "<targetVersion>" }
```

- `groupId` / `assetId` ← the connector's `groupId` / `artifactId` from `tmp/target-connectors.json` (verbatim).
- `version` ← its `targetVersion` (the **target** pin — we describe NEW only, and Phase 2 pins to this).

`describe_connector.mjs <nick>-new` and `apply_connector_pin.mjs <nick>` both read this file. Write **no** metadata stub for pom-only connectors — `apply_connector_pin.mjs` treats `tmp/connector-metadata/<nick>-new.json` as optional and no-ops the XSD rewrite when it is absent.

### 6.5b. The upgrade-targets contract — `tmp/upgrade-targets.json`

`apply_runtime_bump.mjs` reads `.mule.to` / `.java.to`; the `.connectors[].nick` loops in Steps 7/14/21 iterate `.connectors[]`. Shape:

```json
{
  "mule":       { "from": "<current>", "to": "<locked target>" },
  "java":       { "from": "<current>", "to": "<locked target>" },
  "connectors": [
    { "nick": "s3", "groupId": "com.mulesoft.connectors", "artifactId": "mule-amazon-s3-connector", "from": "5.8.4" }
  ]
}
```

Fill each field from a source you already produced — **never hardcode a version**:

- **`mule.from`** ← `jq -r '.version' tmp/current-mule-version.json` (Step 2a), or the value the user supplied/corrected in Step 3a.
- **`java.from`** ← `jq -r '.version' tmp/current-java-version.json` (Step 2b), or the Step-3a corrected value.
- **`mule.to` / `java.to`** ← the **locked target from Step 4c**. Read it from `tmp/target-versions.json`: recommendation accepted → `.options[0].mule` / `.options[0].java`; user-requested target validated and confirmed → `.requestedTarget.mule` / `.requestedTarget.java`. Use exactly the pair the user confirmed — do not re-derive.
- **`connectors[]`** ← one entry per connector in `tmp/target-connectors.json`: `nick` remapped to the XSD prefix (used) or slug (pom-only), `groupId`/`artifactId` verbatim, `from` ← its `currentVersion`.

After writing, sanity-check: `jq -e '.mule.to and .java.to and (.connectors|type=="array")' tmp/upgrade-targets.json`. Every downstream step reads `mule.to`/`java.to` and iterates `.connectors[]` — if either target is null or `connectors` is missing, fix it here before proceeding to Step 7.

---

## Step 7: Check Operations/Configs/Error Types Changes

See `references/plan-connector-upgrades.md` §2–§5 (Mode-A summary, usage enumeration, Mode-B per-op, Mode-C per-config-provider).

**Prerequisite: Java 17+ (before any `describe_connector.mjs` call).** Export a Java 17 `JAVA_HOME` for the shell that runs this step (see Step 13 for the preferred install — Zulu 17 on SFDC laptops). The script hard-refuses to run under Java 8/11 because those JDKs return a degraded describe (empty `configs[].parameters`) that would silently miss required-attribute breaking changes. If Step 3b resolved only the current (pre-17) JDK, resolve a Java-17 JDK now with the same helper, and re-verify `$JAVA_HOME` before the Mode-B / Mode-C fan-out (a subshell or `cd` may have reset it):

```bash
node <skill-dir>/scripts/resolve_jdk.mjs 17 .
export JAVA_HOME=$(jq -r .javaHome tmp/resolve-jdk-17.json)
```

### 7a. Mode-A summary describe (the NEW version each connector was pinned to in Step 6)

For each **used** connector nickname `<nick>` in `tmp/upgrade-targets.json` (skip pom-only — they have no flow usage to introspect):

```bash
<skill-dir>/scripts/describe_connector.mjs <nick>-new
```

**Nickname discipline (BLOCKER).** `<nick>` MUST equal the XSD prefix the flow XML uses (`crypto`, `os`, `xml-module`, `saml`), NOT the artifact slug (`cryptography`, `objectstore`, `xml`). Step 6.5 already remapped the choices/targets files to the prefix; keep it consistent across Mode-A → Mode-B → Mode-C. `enumerate_usage.mjs` will still resolve a mismatched nick by scanning every `*-new.json` for `.namespace.prefix == <nick>`, but relying on that fallback means every downstream script has to be called with the right stem too — cheaper to keep the prefix.

Verify `tmp/connector-metadata/<nick>-new.json` exists before proceeding, and that its `.namespace` is an object with a non-empty `.prefix`. `describe_connector.mjs` refuses to persist a Mode-A file whose `.namespace` is a bare string — if the CLI describe is blocked (entitlement-gated connector) and you're hand-drafting metadata, follow the object shape `{"prefix": "...", "namespace": "...", "schemaLocation": "..."}` or the usage extractor below will exit with a jq indexing error.

Writes `tmp/connector-metadata/<nick>-new.json` — the top-level summary (operations, sources, configs, errorTypes, supportedJavaVersions). This is the input to the Mode-B (per-op) and Mode-C (per-config-provider) describes below.

**Mode-A ≠ Mode-B — do NOT grep Mode-A for attribute names.** The summary lists `.operations[].name` and `.configs[].name` only; it does NOT carry `.operations[<op>].attributes[]` or `.childElements[]`. Attribute renames, required-attribute additions, and attribute→child promotions are only visible in Mode-B (`<nick>-new-<op>.json`). Building the plan's per-op attribute diff off Mode-A will silently miss XSD-breaking changes — the build then fails at `process-classes` with `cvc-complex-type.3.2.2` errors that could have been caught at plan time. If you need an attribute, run Mode-B for that op.

**Describe is NEW-only.** Do NOT describe the OLD connector version — the OLD-side source of truth is `enumerate_usage.mjs` (flow XML scan) below, not a second describe. Pre-4.6-era connectors often fail to describe under a Java-17 JDK; the skill is designed to work without OLD describe. See `feedback_upgrade_describe_new_only`.

Full algorithm and JSON shape: `references/plan-connector-upgrades.md §2 (Mode-A summary describe)`.

### 7b. Usage enumeration and per-symbol fan-out

**Usage enumeration — parser-preferred, grep-fallback.** Two interchangeable scripts write the identical `tmp/connector-usage/<nick>.json` shape:

- `enumerate_usage_xml.mjs` — parses each flow with `fast-xml-parser`. Correct on messy input: ignores commented-out elements and binds `config-ref` to the element that actually carries it. **Preferred.**
- `enumerate_usage.mjs` — zero-dependency regex/grep. Always available; the fallback.

The skill is stateless, so install the parser ephemerally, run it, and remove it. `fast-xml-parser` attaches to the nearest package root — `skills/mule-development/node_modules` (already gitignored; `--no-save` never touches `package.json`). Run enumeration for every in-scope connector like this:

```bash
SKILL_PKG="<skill-dir>/.."          # skills/mule-development (nearest package root)
npm install --no-save --prefix "$SKILL_PKG" fast-xml-parser >/dev/null 2>&1 || true

for nick in $(jq -r '.connectors[].nick' tmp/upgrade-targets.json); do
  # Prefer the parser; rc=3 means fast-xml-parser wasn't importable → grep fallback.
  <skill-dir>/scripts/enumerate_usage_xml.mjs "$nick" .
  [ $? -eq 3 ] && <skill-dir>/scripts/enumerate_usage.mjs "$nick" .
done
```

The ephemeral `node_modules` is removed in Step 20. If `npm install` is blocked (offline/locked-down), every parser call exits rc=3 and the grep fallback carries the whole step — no manual intervention needed.

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
    [ -f "$modeA" ] || { echo "❌ Mode-A missing for $nick — re-run Step 7a"; exit 1; }

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

    # Mode-C per (config, provider) — driven from Mode-A .configs[], per §5.
    # Do NOT drive from usage.configs_used[] / config_providers_used[]: those
    # hold flow-instance names (config-ref values like db-config-primary, and
    # camelCase child names like genericConnection) that never equal Mode-A's
    # SDK names (config, generic) — the old join matched nothing and silently
    # wrote zero Mode-C files, so Phase C never saw reparenting like db's
    # <pooling-profile> and the first mvn broke on XSD validation.
    # --config-name ← .configs[].name; --name ← .configs[].connectionProviders[]
    # entry. Configs with an empty connectionProviders[] are skipped (D7
    # fallback — Phase C reads Mode-A .configs[] directly there).
    jq -r '.configs[]? as $cfg
             | $cfg.connectionProviders[]?
             | "\($cfg.name)\t\(if type == "string" then . else (.name // .elementName) end)"' "$modeA" \
      | while IFS=$'\t' read -r cfg prov; do
        [ -z "$cfg" ] && continue
        [ -z "$prov" ] && continue
        out="tmp/connector-metadata/${nick}-new-${cfg}-${prov}.json"
        [ -f "$out" ] && continue
        <skill-dir>/scripts/describe_connector.mjs "${nick}-new" --type connection-provider --name "$prov" --config-name "$cfg"
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
- **Mode-C `.connectionProviders[].elementName` (the whole set for the connector) vs the OLD flow's `<prefix:config>` connection-element local-name → provider-element rename.** This is the provider element's OWN name changing, not its child-tree — the child-tree bullet below yields zero residue when the provider's children are unchanged, so it will NOT catch this. Test = **set membership after case-normalizing** (Mode-C `elementName` is kebab-case, `usage.config_providers_used[]` is camelCase — fold both to one form before comparing, else a connector that did NOT rename false-positives): if the OLD local-name is **absent from the union of NEW `elementName`s** for that connector, the provider was renamed → plan the `<prefix:config>` child rewrite to the surviving element. A missed provider rename is a guaranteed `process-classes` XSD failure.
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

**No scripts for this step.** The agent reads DW sources directly at plan-synthesis time (Step 12) using the `Read` tool. Compare symbols against Mode-B `.output*` keys from `tmp/connector-metadata/<nick>-new-<op>.json`:

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

**No scripts for this step.** The agent reads every `src/test/munit/**/*.xml` directly at plan-synthesis time (Step 12) using the `Read` tool. For each operation the plan will rewrite, flag:

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

This step is a thin gate that verifies Java 17 is installed locally and that a Mule Runtime ≥ 4.9.x is registered with the Anypoint CLI.

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

Then re-describe each pinned connector so downstream validators use the NEW error catalog. **Java 17+ REQUIRED here too** — same reason as Step 7 (`describe_connector.mjs` will refuse under Java 8/11). Since Step 13 already gated on Java 17, `$JAVA_HOME` should still be set, but verify before the loop:

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

- Detect DataWeave unauthorized field access
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
# Remove the ephemeral fast-xml-parser install from Step 7 (if it was created).
# It lands in the nearest package root, skills/mule-development/node_modules,
# which is gitignored — but the stateless-skill contract is install → use → remove.
rm -rf "<skill-dir>/../node_modules"
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
3. One-line from-to summary: `Mule <from> → <to>, Java <from> → <to>, connectors: <N> updated` — read the from/to values from `tmp/upgrade-targets.json` (`.mule.from`/`.mule.to`, `.java.from`/`.java.to`) before Step 20 removed it, or from your locked target in Step 4c.

Do NOT include per-file diffs, "what was done" recaps, or speculative "next steps" — the user can read the diff.

Present final summary:
- Target versions achieved (Java, Mule Runtime)
- Connectors updated (count and versions)
- Build status: SUCCESS
- Tests status: ALL PASSING
- Next steps: review changes, commit, deploy

---

## Troubleshooting

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

# Step 5a — extract connector dependencies from the POM chain (writes tmp/connectors.json)
node <skill-dir>/scripts/extract_connectors.mjs .

# Step 5b — check each current version's Java support on Exchange (writes tmp/connector-java-compat.json; exit 1 => STOP)
node <skill-dir>/scripts/check_connector_java_compat.mjs .

# Step 6 — resolve latest target-compatible version per connector (writes tmp/target-connectors.json; exit 1 => STOP)
node <skill-dir>/scripts/resolve_target_connectors.mjs .

# Step 6.5 — bridge: write tmp/connector-choices/<nick>-new.json + tmp/upgrade-targets.json (Write/jq), then sanity-check
jq -e '.mule.to and .java.to and (.connectors|type=="array")' tmp/upgrade-targets.json

# Step 7a — Mode-A summary describe of a NEW connector version (Java 17+ required)
<skill-dir>/scripts/describe_connector.mjs <nick>-new

# Step 7b — enumerate connector usage from flow XML (parser-preferred, grep fallback rc=3)
<skill-dir>/scripts/enumerate_usage_xml.mjs <nick> .
<skill-dir>/scripts/enumerate_usage.mjs <nick> .

# Step 7b — Mode-B (per op/source) and Mode-C (per config-provider) describe
<skill-dir>/scripts/describe_connector.mjs <nick>-new --type operation --name <op>
<skill-dir>/scripts/describe_connector.mjs <nick>-new --type connection-provider --name <provider> --config-name <config>

# Step 11.5 — coverage gate (exit 1 => re-run missing describes)
<skill-dir>/scripts/verify_metadata_coverage.mjs

# Step 14 — deterministic version rewrites
<skill-dir>/scripts/promote_new_connector_pins.mjs
<skill-dir>/scripts/apply_runtime_bump.mjs .
<skill-dir>/scripts/apply_connector_pin.mjs <nick> .
```
