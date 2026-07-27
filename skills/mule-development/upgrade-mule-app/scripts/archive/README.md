# Pre-2.0.0 bash + Python originals

These files are the bash + Python versions of the `upgrade-mule-app` helper
scripts that shipped with skill version 1.x. Skill version 2.0.0 replaced them
with Node.js (ESM, zero-dep) ports at `scripts/*.mjs`, matching the convention
adopted by the sibling `build-mule-integration` skill in PR
mulesoft/mulesoft-dx#147.

**These originals are NOT invoked by the skill.** `SKILL.md` and the skill
runtime call only the `.mjs` files at `scripts/*.mjs`. The archive exists so
that:

1. **Parity reference** — during the 2.0.0 port, each Node script was diff'd
   byte-for-byte against its bash/Python predecessor on captured fixtures.
   These sources are the parity ground truth if a regression is suspected.
2. **Rollback path** — the skill can be temporarily downshifted to 1.x by
   swapping the file list; nothing else in the repo has to move.
3. **Attribution / history** — the file moves used `git mv`, so `git log
   --follow scripts/archive/foo.sh` still returns the full pre-2.0.0 history
   of the file.

## Contents

| File | Original role | Node replacement (v2.0.0) |
|---|---|---|
| `apply_connector_pin.sh` + `_apply_connector_pin.py` | Phase D.6 pom + XSD rewriter | `scripts/apply_connector_pin.mjs` |
| `apply_runtime_bump.sh` + `_apply_runtime_bump.py` | Phase D.5 Mule + Java bump | `scripts/apply_runtime_bump.mjs` |
| `check_java_compatibility.sh` | Java compat verdict | `scripts/check_java_compatibility.mjs` |
| `describe_connector.sh` | 3-mode CLI describe wrapper | `scripts/describe_connector.mjs` |
| `enumerate_usage.sh` | Flow-XML usage grepper | `scripts/enumerate_usage.mjs` |
| `get_java17_compatible_connector.sh` | Java-17 version picker | `scripts/get_java17_compatible_connector.mjs` |
| `promote_new_connector_pins.sh` | Choices→versions promotion | `scripts/promote_new_connector_pins.mjs` |
| `verify_metadata_coverage.sh` | Step 11.5 coverage gate | `scripts/verify_metadata_coverage.mjs` |

## Do NOT edit these

Bug fixes and enhancements go into the corresponding `.mjs` file, not here.
The archive is frozen at the 1.x contract; touching it would invalidate the
parity baseline and confuse rollback attempts.
