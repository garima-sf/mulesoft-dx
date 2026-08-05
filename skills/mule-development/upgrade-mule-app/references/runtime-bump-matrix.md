# Runtime bump matrix

Lookup table for the runtime bump (SKILL.md Step 14, `apply_runtime_bump.mjs`): each Mule runtime and its compatible mule-maven-plugin version.

Kept in sync with `lib/pom-edit.mjs` (`MULE_MAVEN_PLUGIN_MATRIX`) — the live source of truth the script imports. For exactly what the script mutates in `pom.xml` / `mule-artifact.json`, see `lib/pom-edit.mjs` and the script table at the top of SKILL.md; this file is only the version lookup.

## Mule runtime → mule-maven-plugin

| Mule runtime | mule-maven-plugin |
|---|---|
| 4.3.x | 3.6.1 |
| 4.4.x | 3.8.0 |
| 4.5.x | 4.1.0 |
| 4.6.x | 4.3.0 |
| 4.7.x | 4.4.0 |
| 4.8.x | 4.6.0 |
| 4.9.x | 4.9.0 |
| 4.10.x | 4.10.1 |
