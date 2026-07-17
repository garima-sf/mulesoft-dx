# Plan Phase — Connector operations / configs / error-type change analysis

This file backs Steps 7 and 12 of `SKILL.md`. It covers what the Plan Phase must discover about connector operation, config, and error-type changes before user approval — and how those discoveries are cross-checked to ensure the plan is safe to hand off to Execution.

Every path in this file resolves from the skill root (this SKILL.md's parent directory). Scripts referenced without a directory prefix live under `scripts/`. JSON state files land under `tmp/` in the app's working tree.

---

## §1 Introspection runtime prerequisite

`anypoint-cli-v4 dx mule describe-connector` requires a locally installed Mule Runtime ≥ **4.9.x** to load its bundled poms. This is **independent of the app's target runtime** — the app can still target 4.6.x for deploy; the CLI just needs a 4.9+ distribution as its introspection substrate.

```bash
# Point the CLI at a 4.9+ install (one-time, persists in ~/.mule-dx/config.json)
anypoint-cli-v4 dx mule runtime path --set ~/AnypointCodeBuilder/runtime/mule-enterprise-standalone-4.11.2
```

Runtimes older than 4.9 fail with a silent `Java exited with code 1` — the JAR bundled in the CLI plugin calls `mule-runtime-ast.ErrorTypeBuilder.builder()`, a static method that only exists in Mule 4.9+.

Java requirement: `JAVA_HOME` must point at a Java 17 install (Azul Zulu 17 recommended over Microsoft OpenJDK 17 for SFDC Nexus TLS compatibility). Probe with:

```bash
/usr/libexec/java_home -v 17    # macOS
```

If describe-connector fails silently, capture the real exception with:

```bash
_JAVA_OPTIONS='-Dmule.jvm.version.extension.enforcement=LOOSE -Xlog:exceptions*=info:file=/tmp/xlog.log' \
  anypoint-cli-v4 dx mule describe-connector --connector <groupId>:<artifactId>:<version> --output json
grep -E "NoSuchMethodError|doesn't support|ClassNotFoundException" /tmp/xlog.log | head -5
```

---

## §1.5 Step 6 — Java-17-compatible connector version pick

For each in-scope connector, resolve the latest Java-17-compatible version BEFORE Mode-A summary describe runs. This step uses `anypoint-cli-v4 exchange asset` metadata (not the CLI's `dx mule describe-connector` introspection) — Exchange tags carry a `is-java-17-supported` flag that lets us pick a pin without a runtime describe.

**Search token:** the connector's `artifactId` verbatim, filtered by `--type Extension`.

**Algorithm** (per connector; run in parallel, capped at 10 concurrent):

1. `anypoint-cli-v4 exchange asset list <artifactId> --type Extension --output json` → filter to entries whose `assetId` matches exactly, sort versions semver-descending, keep top 5.
2. Walk latest → oldest for at most 5 versions: `anypoint-cli-v4 exchange asset describe "<groupId>/<assetId>/<version>" --output json | jq '.tags[]? | select(.key=="is-java-17-supported") | .value'`.
3. First value `"true"` wins. Write `tmp/connector-choices/<nick>-new.json` with `{groupId, assetId, version, java17: "ok", walkback_steps: N}`.
4. If the walk exhausts 5 versions without a `"true"` hit — or if the tag is absent from every version — exit non-zero and produce no output file for this connector.

**HALT on miss.** If any connector fails to produce an output file after `wait`, HALT the entire upgrade:

> "Cannot upgrade: connector `<artifactId>` has no Java-17-compatible version in its latest 5 releases on Exchange. Upgrade is not possible for this project."

Do NOT proceed to Mode-A / §2 with a partial pin set — Step 5's Mode-A describe expects every in-scope connector to have a `-new.json`.

**Why walk-back bounded at 5.** Connectors with 5 consecutive non-Java-17 releases are structurally unsupported for Java 17; going deeper is unlikely to help and produces long-running Exchange call chains. v2 may parameterize the depth.

**Output file contract.** `tmp/connector-choices/<nick>-new.json` is the same shape downstream steps expect — `scripts/promote_new_connector_pins.sh` and `scripts/apply_connector_pin.sh` consume it in Step 14.

**Script:** `scripts/get_java17_compatible_connector.sh <groupId> <artifactId> <nick>` implements the walk-back. Exit codes: `0` = pick written, `2` = asset not found in Exchange, `3` = no Java-17 version in latest 5.

---

## §2 Mode-A summary describe

Per-connector summary — one call per connector in the pom.

```bash
scripts/describe_connector.sh <nick>-new
```

`-Dmule.jvm.version.extension.enforcement=LOOSE` is forwarded so the new connector still describes under Java 17 when its extension model declares `supportedJavaVersions=[1.8, 11]`.

Writes `tmp/connector-metadata/<nick>-new.json`. The summary shape:

- `operations[]` — top-level operation names (strings)
- `sources[]` — top-level source names
- `configs[]` — each `{name, connectionProviders: [...bare strings...]}`. Providers are **bare strings** in the summary; `.elementName` is populated only in the Mode-C output (see §5).
- `errorTypes[]` — connector-wide error-type union
- `supportedJavaVersions[]` — declared Java compatibility window

The summary does NOT contain per-op attribute lists or per-config-provider DSL element names — those come from §4 (Mode-B) and §5 (Mode-C).

---

## §3 Usage enumeration

Walks every flow XML in the app for connector call sites.

```bash
scripts/enumerate_usage.sh <nick> .
```

Writes `tmp/connector-usage/<nick>.json`:

- `operations_used[]` — element names classified as NEW-side operations OR unknown-to-metadata
- `sources_used[]`, `configs_used[]`, `config_providers_used[]`
- `child_elements_used[]` — element names classified as known child elements of `<prefix:config>` OR unknown-to-metadata inline child elements (e.g. `content`, `objectContent`, `records`). Surfaced explicitly so grep noise isn't misread as "the flow uses this operation".
- `usage_sites[]` — per-site `{file, line, attributes_set}`. `doc:name` is filtered out.
- `errorTypes_caught[]`, `errorTypes_raised[]`
- `namespace_prefix` — the DSL prefix the flow uses (e.g. `s3` for `<s3:create-object .../>`)
- `namespace_prefix_changed` — `{from, to}` when the NEW prefix differs from what the flow uses (e.g. SFDC `sfdc` → `salesforce`), otherwise `null`

**Prefix-fallback rule.** If the NEW-metadata prefix doesn't appear as an element opener in any flow XML, the script looks for another `xmlns:<candidate>="<same namespace URI>"` binding in the flow and re-runs the grep with that candidate prefix.

**`not_in_use` skip contract.** If `enumerate_usage.sh` prints a `not_in_use` JSON on stdout, that connector is declared in `pom.xml` but has zero flow usage. The plan for that connector reduces to "bump the pom version only — no flow edits, no per-op describe." Skip §4 and §5 for that connector, but keep it in the plan under a "pom-only" section so Execution still runs the pin.

---

## §4 Mode-B per-operation describe

The Mode-A summary returns only top-level operation names — no attribute lists, no child elements. Without per-op detail the plan would have to guess NEW-side attribute renames (e.g. `bucketName` → `bucket`) and child-vs-attribute placement (e.g. `<s3:content>` is a childElement in NEW `putObject`, not an attribute) — those guesses only surface at `mvn` time.

Run per-op describe for every op that survives the intersect with the NEW catalog:

```bash
# Intersect usage.operations_used[] with new.operations[]
CANON_OPS=$(jq -r --slurpfile new tmp/connector-metadata/<nick>-new.json \
  '.operations_used[] | select(. as $op | $new[0].operations | index($op))' \
  tmp/connector-usage/<nick>.json)

for op in $CANON_OPS; do
    scripts/describe_connector.sh <nick>-new --type operation --name "$op"
done
```

Each call writes `tmp/connector-metadata/<nick>-new-<op>.json` containing:

- `attributes[]` — every attribute the NEW operation accepts (with `attributeName`, types, `required` flag, allowed values)
- `childElements[]` — every child element the NEW operation accepts (name, prefix, required, attributes)
- `errorTypes[]` — the per-op error catalog

**Renamed ops.** For operations in `usage.operations_used[]` that are NOT in `new.operations[]`, pick a rename candidate (Levenshtein-close or same semantic role) and describe the guessed NEW target as well — so the plan enumerates the rename with real metadata backing it, not a bare guess.

---

## §5 Mode-C per-config-provider describe

The connection element inside `<prefix:config>` (e.g. `<s3:basic-connection>`, `<sfdc:basic-connection>`, `<jms:active-mq-connection>`) can't be derived from the summary describe — the summary reports only the provider's SDK identifier, not its DSL element name. Skipping this describe forces the LLM to guess element names and typically breaks the first `mvn`.

**`--config-name` and `--name` come from `<nick>-new.json`, NEVER from the user's flow XML.** The values are the connector's SDK-side identifiers:

- `--config-name` ← `.configs[].name` (single lower-case word — usually literally `"config"` or `"listenerConfig"`)
- `--name` ← `.configs[].connectionProviders[]` entry (single lower-case word — e.g. `"oracle"`, `"connection"`, `"active-mq"`, `"listener"`)

Do NOT pass:

- The user's XML config identifier (`Warehouse_DB_Config`, `Inventory_S3_Config` — those go in `config-ref` attributes at call sites)
- The OLD DSL provider element name (`basic-connection`, `oracle-connection`, `active-mq-connection` — those are what Mode-C's `.elementName` **returns**, not what you send in)
- Anything from `tmp/connector-usage/<nick>.json` `configs_used[]` / `config_providers_used[]` (those are populated from OLD flow XML)

```bash
jq -r '
    .configs[]? as $cfg |
    $cfg.connectionProviders[]? |
    "\($cfg.name)\t\(.)"
' tmp/connector-metadata/<nick>-new.json | while IFS=$'\t' read -r cfg prov; do
    scripts/describe_connector.sh <nick>-new \
        --type connection-provider \
        --name "$prov" \
        --config-name "$cfg"
done
```

Each call writes `tmp/connector-metadata/<nick>-new-<config>-<provider>.json` containing:

- `.elementName` — the config element name (e.g. `sfdc-config`)
- `.connectionProviders[]` — the connection providers on this config, each with `elementName` (e.g. `basic-connection`), `attributes[]`, and `childElements[]`

Use the `elementName` from this Mode-C file when writing the connection-element rewrite plan — do not guess from the SDK provider name, and do not read `.elementName` from the Mode-A summary (it isn't there).

---

## §6 DW + MUnit impact scan

For every op the flow uses that the plan will rewrite:

- Grep flows for DataWeave expressions (`<ee:transform>`, inline `#[...]`) that read the op's output.
- Grep MUnit files under `src/test/munit/` for mock/assert calls that reference the op or its error types.

Nothing is fixed here — this is discovery. Any DW site whose output shape can't be reconciled with the op's Mode-B `.output*` keys, and any MUnit mock/assert whose signature no longer matches the op's Mode-B `.attributes[]`, is flagged for user attention in §7's plan output.

---

## §7 Plan synthesis and approval gate (Step 12)

The plan-authoring step. No CLI calls, no scripts — the LLM reads the metadata + usage JSON on disk and writes an explicit change list to `tmp/upgrade-plan.md`. Everything Execution will do to the project must appear in this file so the user can approve or reject each edit before it touches the working tree.

The plan MUST be **mechanical**, per-symbol, against the Mode-B / Mode-C JSON on disk. Do not describe intent ("update the s3 operations"); describe **exactly which file:line changes to what**.

### Plan inputs

- `tmp/upgrade-targets.json` — from / to for mule, java, connectors
- `tmp/connector-metadata/<nick>-new.json` — Mode-A summary
- `tmp/connector-metadata/<nick>-new-<op>.json` — Mode-B per-op (with `attributes[]`, `childElements[]`, `errorTypes[]`, and `.output*` when populated)
- `tmp/connector-metadata/<nick>-new-<config>-<provider>.json` — Mode-C per-config-provider
- `tmp/connector-usage/<nick>.json` — usage sites, attributes_set at each site, errorTypes caught/raised, namespace_prefix_changed

### Plan outputs

Write `tmp/upgrade-plan.md` with these sections. Every section MUST cite the specific JSON file(s) it derives from — reviewers verify a plan by cross-checking citations.

```markdown
# Upgrade Plan — <project-name>

## Targets
- Mule runtime: <from> → <to>
- Java: <from> → <to>
- Connectors:
  - <nick>: <old-gav> → <new-gav>   [Java window verdict: ok | warn | block-handled]

## Namespace prefix changes
- <nick>: <old-prefix> → <new-prefix>   (source: usage.namespace_prefix_changed)

## Operations
For each op the flow uses:

### <op-name> (op<sub>OLD</sub> → op<sub>NEW</sub>)
- Kind: straight-match | rename | true-removal
- Sources: usage.operations_used[], per-op JSON (<nick>-new-<op>.json)
- Sites (from usage.usage_sites[]):
  - <file>:<line>   attributes_set: [a="…", b="…"]
- Per-site edit contract:
  - Element rename: <old-prefix>:<old-op> → <new-prefix>:<new-op>
  - Attribute renames:
    - `bucketName` → `bucket`
    - `content`    → PROMOTE TO CHILD ELEMENT `<s3:content>#[payload]</s3:content>`
      (source: <nick>-new-<op>.json .childElements[])
  - Removed attributes:
    - `useVersioning` — dropped
  - New required attributes/children:
    - <name> (required=true, defaultValue=<x>) — insert with default
- Error-type mapping (per-op):
  - S3:BUCKET_NOT_FOUND → S3:NO_SUCH_BUCKET   (source: <nick>-new-<op>.json .errorTypes[])

## Configs / connection providers
For each (config, provider) pair the flow uses:

### <config-nick> (<config-name>, provider <provider-name>)
- Sources: <nick>-new-<config>-<provider>.json
- Config element:  <old-prefix>:<old-config-element> → <new-prefix>:<.elementName>
- Connection element:  <old-prefix>:<old-connection-element> → <new-prefix>:<.connectionProviders[…].elementName>
- Attribute renames (on the connection element)
- Removed connection attributes / Added required connection attributes-children
- Sites (from usage.usage_sites[])

## Connector-wide error type renames
Enumerated from <nick>-new.json .errorTypes[]:
- <OLD_TYPE> → <NEW_TYPE>

## DataWeave downstream impact
For every DW consumer that reads output from an op the plan will rewrite:
- Symbol list read from the op's response
- Diff against Mode-B .output* keys:
  - Present in Mode-B: no change
  - Absent, sibling present (probable rename): proposed rewrite (with source citation)
  - Absent AND Mode-B has NO .output* keys: SITE FLAGGED FOR OPERATOR

## pom.xml / mule-artifact.json
- <app.runtime>: <from> → <to>
- <javaVersion> / maven.compiler.{source,target}: <from> → <to>
- <mule.maven.plugin.version>: bumped per references/runtime-bump-matrix.md
- mule-artifact.json:
  - minMuleVersion: <from> → <to>
  - javaSpecificationVersions: add ["<to>"] if target is 17 or 21 and the field is absent

## xsi:schemaLocation URLs
- apply_connector_pin.sh will rewrite mule-<connector>.xsd URLs deterministically

## Known risks / operator-attention items
- Java-window warnings, DW sites flagged for operator, true-removal ops with no rename target, etc.
```

Authoring rules:

- **Never invent an operation, attribute, or child element.** Every rename claim must have a corresponding entry in a Mode-B / Mode-C JSON on disk.
- **Preserve business intent in the plan.** `doc:name`, DataWeave payloads, `config-ref` values, error-handler shapes are not part of the upgrade; they must survive Execution unchanged. Note that explicitly in the plan when a site has DW / config-ref / doc:name so reviewers can spot an accidental drop.
- **Flag ambiguity.** If an OLD op has no plausible NEW rename target, mark the site as `true-removal — operator attention required`. Do NOT silently guess. If a DW site has no Mode-B `.output*` shape catalog, list every symbol read and flag the site for operator confirmation.

### Approval gate

Print `tmp/upgrade-plan.md` inline (`Read` the file, paste as fenced markdown). Then use `AskUserQuestion` to ask:

> Please review the upgrade plan above. Proceed to Execution?
> - Yes, proceed to Execution.
> - No, I want to change the plan.
> - No, cancel the upgrade.

**WAIT for explicit "Yes, proceed to Execution."** before advancing to Step 13.

- On **"No, I want to change the plan."** — collect which parts to change via `AskUserQuestion`, loop back to whichever section owns that piece of the plan, re-run only the affected steps, re-synthesize the plan, and re-present. Do NOT re-run the entire Plan Phase.
- On **"No, cancel the upgrade."** — stop the workflow. Leave `tmp/` in place for inspection.

---

## §8 Phase-C completeness checklist (run BEFORE §7 approval gate)

Before the plan is handed to the user, every connector must have all four artifacts fully cross-checked against usage:

- [ ] `tmp/connector-choices/<nick>-new.json` — drafted GAV
- [ ] `tmp/connector-metadata/<nick>-new.json` — Mode-A summary
- [ ] `tmp/connector-metadata/<nick>-new-<op>.json` — Mode-B per-op describe **for every op in usage.operations_used[] that intersects `new.operations[]`**
- [ ] `tmp/connector-metadata/<nick>-new-<config>-<provider>.json` — Mode-C describe **for every (config, provider) pair the flow uses**

Diff each Mode-B `.attributes[].attributeName` against the same site's `usage.usage_sites[].attributes_set` keys — a rename is a `usage` key absent from `.attributes[]` AND a `.attributes[]` name absent from `usage`. Diff `usage.errorTypes_caught[]` against `<nick>-new-<op>.json .errorTypes[]` and `<nick>-new.json .errorTypes[]` — a caught type that isn't in either is a mapping the plan must resolve. Diff Mode-C `.elementName` and `.connectionProviders[].elementName` against `usage.configs_used[]` and `usage.config_providers_used[]` — a mismatched local-name is a config-element rewrite the plan must enumerate.

If any diff surfaces a symbol the plan does not enumerate, that plan is incomplete — go back to §4/§5, re-describe, and re-synthesize. "Build breaks after skill claims success" is almost always metadata-present-but-ignored.
