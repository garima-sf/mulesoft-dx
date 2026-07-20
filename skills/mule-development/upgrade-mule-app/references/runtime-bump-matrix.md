# Runtime bump matrix

Target versions and their compatible tooling for Phase D.5 (`apply_runtime_bump.sh`).

Kept in sync with `scripts/_apply_runtime_bump.py` (`MULE_MAVEN_PLUGIN_MATRIX`).

## Mule runtime → mule-maven-plugin

| Mule runtime | mule-maven-plugin | Notes |
|---|---|---|
| 4.3.x | 3.6.1 | Java 8 only |
| 4.4.x | 3.8.0 | Java 8, 11 |
| 4.5.x | 4.1.0 | Java 8, 11, 17 |
| 4.6.x | 4.3.0 | Java 8, 11, 17 (recommended target) |
| 4.7.x | 4.4.0 | Java 11, 17 |

## Java version support windows

| Mule runtime | Supported Java |
|---|---|
| 4.3.x | 1.8 |
| 4.4.x | 1.8, 11 |
| 4.5.x | 1.8, 11, 17 |
| 4.6.x | 1.8, 11, 17 |
| 4.7.x | 11, 17 |

Notes:
- The POC target is Mule 4.6.x + Java 17. Bumping straight from 4.3 to 4.7 also works but is more invasive on the runtime side; 4.6 is the safest intermediate stop.
- `mule-artifact.json` gains a `javaSpecificationVersions` field starting at Mule 4.5. The runtime bump script adds `["17"]` when the target is Java 17 or 21 and the field is absent.

## Editing pom.xml properties

The runtime bump touches these `<properties>` entries:

- `<app.runtime>` — the runtime version.
- `<javaVersion>` — some archetypes emit this, most do not. The script inserts it if missing.
- `<maven.compiler.source>` and `<maven.compiler.target>` — align with `<javaVersion>`.
- `<mule.maven.plugin.version>` — looked up in the matrix above.

If your project pins the plugin via `<plugin><groupId>org.mule.tools.maven</groupId>...` inline instead of via a property, the script will insert a `<mule.maven.plugin.version>` property but the plugin block will still shadow it. Edit the plugin block by hand in that case.

## Verifying the upgrade

After Phase D.5 runs, expect:

```bash
mvn help:evaluate -Dexpression=app.runtime -q -DforceStdout
# → 4.6.x

mvn help:evaluate -Dexpression=javaVersion -q -DforceStdout
# → 17

jq '.minMuleVersion, .javaSpecificationVersions' mule-artifact.json
# → "4.6.x"
# → ["17"]
```

Then run `validate_prerequisites.sh` again to confirm `JAVA_HOME` points at Java 17 before `mvn clean package`.
