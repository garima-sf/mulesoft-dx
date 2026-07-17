# Execution Phase — Applying the approved upgrade plan

This file backs Steps 15, 16, and 20 of `SKILL.md`. Execution applies the plan `tmp/upgrade-plan.md` produced in the Plan Phase (see `references/plan-connector-upgrades.md`) mechanically. No new discoveries, no new choices — everything that could require user input was resolved during planning.

Every path in this file resolves from the skill root. Scripts referenced without a directory prefix live under `scripts/`. Deterministic pom + xsi rewrites are handled by scripts in this skill (`apply_connector_pin.sh`, `apply_runtime_bump.sh`, `promote_new_connector_pins.sh`). Pre-mvn validation and prerequisite re-checks are handled by the sibling `build-mule-integration` skill under `../build-mule-integration/scripts/`.

---

## §1 LLM flow-XML edit loop (Step 15)

Apply the edits enumerated in `tmp/upgrade-plan.md` §Operations and §Configs / connection providers.

**Per-operation edit workflow** — for each op in the plan:

1. If the op is `true-removal — operator attention required`, use `AskUserQuestion` at edit time to confirm the manual rewrite path. Never guess a rename here; that decision belongs in Plan.
2. Open `usage_sites[i].file` at its `line` using the Read tool (grab ~10 lines each side for context).
3. Use the Edit tool to rewrite the element in place per the plan's contract for this op:
   - Element rename (prefix + local-name)
   - Attribute renames from `.attributes[].attributeName`
   - Attribute → child element promotions from `.childElements[]`
   - Removed attributes: drop
   - New required attributes/children: insert with the plan's default
   - `<on-error-propagate type="...">` and `<on-error-continue type="...">` rewrites per the plan's error-type map
4. **Preserve** `doc:name`, DataWeave payloads, `config-ref` values, and other unrelated children. Never modify unrelated elements.
5. If namespace prefix changed, apply the xmlns-binding update on the flow's root `<mule>` element (rename `xmlns:<oldprefix>` → `xmlns:<newprefix>`). Do NOT touch `xsi:schemaLocation` — the deterministic pin script (see §4) handles that.
6. After all sites for the op are edited, run `xmllint --noout <file>` on each touched file to verify parseability.

**Per-config workflow** — for each (config, provider) pair in the plan:

1. Rewrite the config element's local-name to the plan's `.elementName` from Mode-C.
2. Rewrite the connection element's local-name to the plan's provider `.elementName` from Mode-C.
3. Apply the attribute renames on the connection element from the plan.
4. If namespace prefix changed, rewrite the config's element prefix — the local-names above are unchanged.

**Prompt template.** Use the single per-op prompt from `references/llm-prompts.md §1`. It is designed for this step: the LLM has already read the Mode-A summary, Mode-B per-op JSON, and Mode-C per-config-provider JSON; the prompt is self-contained per operation so it doesn't need to re-open files.

**Constraints:**

- Preserve business intent (DataWeave, doc:name, config-ref)
- Never modify unrelated elements
- Never invent an operation, attribute, or child element that doesn't exist in the plan / Mode-B / Mode-C JSON
- Never edit `xsi:schemaLocation` — the deterministic pin script owns it
- Never re-open a decision the plan already made — if a decision looks wrong, halt and route back to Plan

---

## §2 DataWeave script updates (Step 15 continued)

Apply exactly the DW rewrites enumerated in the plan's "DataWeave downstream impact" section.

- Sites where the plan proposes a rewrite (Mode-B `.output*` gives a sibling-rename mapping): apply the Edit as written.
- Sites flagged `SITE FLAGGED FOR OPERATOR`: the plan couldn't determine a shape mapping. Surface via `AskUserQuestion` at edit time — do NOT silently rewrite.

Connector-specific hot spots to sanity-check even when the plan didn't flag them:

- `db:select` column-case flips across driver versions
- Java 17 stricter number/date coercion (`as Number`, `now() as String`)
- `error.errorType.identifier` string content changes (SFDC:… → SALESFORCE:…, etc.)

---

## §3 MUnit test updates (Step 15 continued)

For every op the plan will rewrite, review each `src/test/munit/**.xml` file that references the op:

- Update `<munit-tools:mock-when>` `processor` attributes to the NEW element name (e.g. `<munit-tools:mock-when processor="salesforce:query">`).
- Update mocked `<munit-tools:then-return>` payload shape if Mode-B `.output*` indicates a schema change.
- Update `<munit-tools:assert-that>` expressions that read op-response fields flagged in the plan's DW section.
- Update `<munit-tools:fail>` and `<on-error-propagate type="...">` in MUnit error paths per the plan's error-type map.

**`mvn test` is the authoritative gate for MUnit** — see §4.

---

## §4 Build loop with bounded recovery (Step 16)

Before the build loop, promote drafts and apply the deterministic pom / xsi rewrites in a fixed order:

```bash
# 1. Promote every tmp/connector-choices/<nick>-new.json to tmp/connector-versions/<nick>.json
scripts/promote_new_connector_pins.sh

# 2. Bump connector version + rewrite xsi:schemaLocation URLs
#    (once per in-scope connector nickname)
scripts/apply_connector_pin.sh <nick> .

# 3. Bump runtime + Java version in pom.xml and mule-artifact.json
scripts/apply_runtime_bump.sh .

# 4. Re-describe the pinned connector so downstream validators use the NEW error catalog
scripts/describe_connector.sh <nick>     # no -new suffix

# 5. Pre-mvn validation — sibling build-mule-integration skill
../build-mule-integration/scripts/validate_before_build.sh .

# 6. Prerequisite re-check (confirm JAVA_HOME points at target JDK)
../build-mule-integration/scripts/validate_prerequisites.sh
```

`apply_runtime_bump.sh` exits 2 if the running Java version doesn't match the target — its stdout summary contains a human-readable instruction; hand it to the user via `AskUserQuestion` verbatim. Do not run `mvn` until the user confirms `JAVA_HOME` points at the right JDK.

### The build

**One `mvn` per response.** On failure, do NOT ad-hoc patch — enter the recovery loop.

```bash
mvn clean package
```

**What `BUILD SUCCESS` actually validates on a mule-application:**

- (a) XSDs parse
- (b) DataWeave scripts compile
- (c) The `.jar` packages

It does NOT execute any flow, does NOT hit any external system, and does NOT run MUnit. **`mvn clean package` BUILD SUCCESS is packaging-only** — MUnit executes only under the `test` phase (i.e. `mvn test` or `mvn verify`), and only when `munit-maven-plugin` is declared in the pom.

### Recovery loop — retry budget of 3

When `mvn clean package` fails, don't guess at edits. Almost every mvn failure is an XSD/DSL mismatch whose fix is already in the metadata collected during Plan Phase — Mode-A summary, Mode-B per-op JSON, or Mode-C per-config-provider JSON. Structured recovery reuses that data instead of re-guessing.

After the **third** failed `mvn` in a row, HALT and hand the failure to the user via `AskUserQuestion` with the parsed error, the classification, and the candidate fixes. Do not keep trying.

**Parse the failure** — extract from the Maven output:

| Field | Where it appears | Example |
|---|---|---|
| `file` | `[ERROR] Could not load flow: file:.../src/main/mule/<flow>.xml` | `/…/src/main/mule/example.xml` |
| `line`, `col` | `cvc-*: … [file:line:col]` or `line N column M` | `line 23 column 4` |
| `error_code` | `cvc-complex-type.<N>.<N>` / `cvc-enumeration-valid` / `cvc-datatype-valid.1.2.1` | `cvc-complex-type.3.2.2` |
| `element` | The `<prefix:name>` in the message | `<salesforce:basic-connection>` |
| `attribute` | The attribute (if any) named in the message | `securityType` |
| `expected` | For enum/type errors, allowed values | `[BASIC_AUTH, OAUTH_JWT, ...]` |

Save the raw output to `tmp/mvn-failures/<attempt>.log`.

**Classify** the failure into one of these classes:

1. **attribute-rename** — `cvc-complex-type.3.2.2` "Attribute '<X>' is not allowed to appear in element '<prefix:op>'".
   - Fix source: `tmp/connector-metadata/<nick>-new-<op>.json` → `.attributes[].attributeName`.
   - Recovery: find a plausible NEW attribute (Levenshtein-close or same semantic role), edit the site. If the plan already picked a mapping, apply the plan's mapping.

2. **missing-required-child** — `cvc-complex-type.2.4.a/b` "Invalid content was found starting with element '…'. One of '{…}' is expected".
   - Fix source: `tmp/connector-metadata/<nick>-new-<op>.json` → `.childElements[]`.
   - Recovery: an OLD attribute (e.g. `content="#[payload]"`) is now a child element (`<prefix:content>#[payload]</prefix:content>`). Rewrite accordingly.

3. **element-rename** — `cvc-elt.1.a` "Cannot find the declaration of element '<prefix:op>'".
   - Fix source: `tmp/connector-metadata/<nick>-new.json` → `.operations[]` / `.sources[]`.
   - Recovery: if the plan already picked a rename target for this op, apply it. Otherwise the plan missed the rename — go back to Plan (Mode-B + plan synthesis), do NOT guess.

4. **connection-provider element name** — same code shape as (3) but inside a `<prefix:config>` block.
   - Fix source: `tmp/connector-metadata/<nick>-new-<config>-<provider>.json` → `.elementName` (config) and `.connectionProviders[] | select(.name == "<provider>") | .elementName` (connection).
   - Recovery: rewrite to Mode-C's `.elementName`. Bounded — Mode-C makes it deterministic. Never guess from the SDK identifier.

5. **enum-value** — `cvc-enumeration-valid` "Value '<X>' is not facet-valid with respect to enumeration '[…]'".
   - Fix source: the parsed message carries allowed values. Cross-reference with the per-op JSON's `.attributes[].allowedValues`.
   - Recovery: pick the NEW enum value that maps to the OLD one (usually a rename — `BASIC` → `BASIC_AUTH`), or `AskUserQuestion` if the mapping is genuinely ambiguous.

6. **xsi:schemaLocation URL** — `SAXException` "schema_reference.4" or `cvc-elt.1.a` on `<mule ...>` root, with a URL like `.../current/mule-<name>.xsd` that 404s.
   - Fix source: `tmp/connector-versions/<nick>.json` (pinned GAV) and the actual namespace URI from `tmp/connector-metadata/<nick>.json` → `.namespace.uri`.
   - Recovery: re-run `scripts/apply_connector_pin.sh <nick> .`. Do NOT hand-edit `xsi:schemaLocation`.

7. **pom / plugin / runtime** — anything from the reactor before the app is loaded (`mule-maven-plugin` not found, `${app.runtime}` unresolved, `javaSpecificationVersions` mismatch, missing artifact in the local repo).
   - Fix source: `references/runtime-bump-matrix.md`; `pom.xml` + `mule-artifact.json`; `tmp/connector-versions/*.json`.
   - Recovery: re-run `scripts/apply_runtime_bump.sh .` if a runtime/plugin property is wrong; re-run `scripts/apply_connector_pin.sh <nick> .` if a dependency version is wrong. Only hand-edit `pom.xml` when both scripts report `not-found`.

8. **unknown / other** — doesn't fit the classes above.
   - Fix source: cross-reference `tmp/connector-metadata/*.json` + `tmp/connector-versions/*.json` with your own knowledge of Mule 4 XSD/DSL semantics.
   - Recovery: revisit whichever earlier phase's output the failure implicates. Log reasoning in `tmp/mvn-failures/<attempt>.log`. Only fall through to `AskUserQuestion` once the 3-retry budget is exhausted OR the same knowledge-based edit has already failed once.

**Apply one targeted edit** — one `Edit` (or the ONE script re-run named in the recovery step). Do not batch multiple edits in a single retry.

**Re-run `mvn clean package` in a NEW response.** On success → proceed to §4 MUnit gate below. On failure → increment retry counter and re-parse.

**After 3 failed retries** — HALT. `AskUserQuestion` with:

- The last three `tmp/mvn-failures/<attempt>.log` excerpts (first 30 lines each)
- The classification picked for each
- The edit applied on each attempt
- 2–4 candidate next actions

Do not attempt a fourth retry without user direction.

---

## §4.5 MUnit Loop (Step 17)

Runs AFTER §4 (Step 16) reports `BUILD SUCCESS`. `mvn clean package` validates packaging only — `mvn test` is authoritative runtime validation.

```bash
grep -c 'munit-maven-plugin' pom.xml
```

- `0` → no MUnit plugin declared. `BUILD SUCCESS` means "packaging succeeded" only. Log this in the completion note (`no runtime validation performed — fixture does not declare munit-maven-plugin`) and skip the loop. Do NOT invent an MUnit suite; that is outside the skill's scope.
- `>= 1` → MUnit is wired. Enter the loop below.

### The loop

**One `mvn test` per response.** On failure, use the same recovery classifier from §4 — but the applicable classes are narrower because MUnit failures are always inside test XML, not flow XML:

1. **attribute-rename** on `<munit-tools:mock-when processor="<prefix:op>">` — an unknown mock attribute. Fix source: `tmp/connector-metadata/<nick>-new-<op>.json` `.attributes[].attributeName`.
2. **element-rename** on `<munit-tools:mock-when processor="<prefix:oldOp>">` — the `processor` attribute names an op that no longer exists. Fix source: `tmp/connector-metadata/<nick>-new.json` `.operations[]`; apply the plan's rename mapping.
3. **connection-provider element name** — same shape as element-rename, but inside a `<munit-tools:mock-when processor="<prefix:config>">` referring to a connection-provider element. Fix source: `tmp/connector-metadata/<nick>-new-<config>-<provider>.json` `.elementName`.
4. **enum-value** on mocked payload — `<munit-tools:then-return>` returns a constant that's no longer a valid enum value. Fix source: per-op `.attributes[].allowedValues`.
5. **assertion-shape** — `<munit-tools:assert-that>` reads a field the NEW op no longer emits. Fix source: cross-reference Mode-B `.output*` keys, rewrite the JSONPath / DW read.

Save each failing run's output to `tmp/mvn-failures/munit-<attempt>.log`.

### Retry budget: 5–6 attempts

MUnit failures are more diffuse than XSD/DSL failures (test authoring style varies, and one op change often touches multiple mocks), so this loop uses a looser budget than §4's 3-retry cap.

After the **6th** failed `mvn test`, HALT via `AskUserQuestion` with:

- The last three `tmp/mvn-failures/munit-<attempt>.log` excerpts (first 30 lines each)
- The classification picked for each
- The edit applied on each attempt
- 2–4 candidate next actions

Do NOT attempt a 7th retry without user direction. `mvn test` passing is the runtime validation gate — treat repeated failures as a signal that the plan missed a Mode-B / Mode-C detail, not as noise to retry through.

---

## §5 Java 17 compatibility

Assume the latest connector versions are Java-17 compatible when metadata is empty — most modern connectors don't declare `supportedJavaVersions` explicitly. If `check_java_compatibility.sh` returns `warn`, record in the plan under "Known risks" and proceed for the POC. If it returns `block`, HALT plan synthesis and prompt the user with `AskUserQuestion` before proceeding.

**Probe local Java 17** — `JAVA_HOME` must point at a real Java 17 install before `mvn clean package`:

```bash
/usr/libexec/java_home -v 17    # macOS
```

**JDK vendor preference:** Azul Zulu 17 is preferred over Microsoft OpenJDK 17 (ms-17) for SFDC Nexus TLS compatibility. `ms-17` fails to reach the internal Nexus over TLS in some Salesforce network environments; Zulu succeeds.

Skip any no-op connector (`enumerate_usage.sh` returned `not_in_use`). Those don't need a re-describe cycle — Execution's connector pin still runs to bump the pom version, but no flow-XML edits and no per-op describe are required.

---

## §6 Cleanup (Step 20)

Delete `tmp/` **only** after `mvn clean package` has reported `BUILD SUCCESS` and the MUnit gate has recorded its verdict. The state files are useful for diagnosing failures — do not clean them up mid-flight.

```bash
rm -r tmp/
```

**Discipline** (per the "Build → cleanup → completion separation" rule at the top of `SKILL.md`):

- **Its own response**, as the only tool call.
- Do NOT bundle cleanup with a `mvn` invocation.
- Do NOT bundle cleanup with the completion signal (Step 21).

The completion signal (Step 21) is a separate response and reports:

1. `BUILD SUCCESS` on the upgraded project (with `target/<project>-*.jar`)
2. The MUnit gate verdict (either `mvn test` result if `munit-maven-plugin` is declared, or the "no runtime validation performed" note if it isn't)
3. One line naming the from-to change (e.g. "S3 connector 5.8.4 → 6.6.0, Mule 4.3.0 → 4.6.9, Java 8 → 17")
