# Runtime bump matrix

Target versions and their compatible tooling for Phase D.5 (`apply_runtime_bump.sh`).

Kept in sync with `scripts/_apply_runtime_bump.py` (`MULE_MAVEN_PLUGIN_MATRIX`).

## Mule runtime → mule-maven-plugin

| Mule runtime | mule-maven-plugin | Notes |
|---|---|---|
| 4.3.x | 3.6.1 | Java 8 only |
| 4.4.x | 3.8.0 | Java 8, 11 |
| 4.5.x | 4.1.0 | Java 8, 11, 17 |
| 4.6.x | 4.3.0 | Java 8, 11, 17 |
| 4.7.x | 4.4.0 | Java 11, 17 |
| 4.8.x | 4.6.0 | Java 11, 17 |
| 4.9.x | 4.9.0 | Java 11, 17 |
| 4.10.x | 4.10.1 | Java 17 (recommended target) |

## Java version support windows

| Mule runtime | Supported Java |
|---|---|
| 4.3.x | 1.8 |
| 4.4.x | 1.8, 11 |
| 4.5.x | 1.8, 11, 17 |
| 4.6.x | 1.8, 11, 17 |
| 4.7.x | 11, 17 |
| 4.8.x | 11, 17 |
| 4.9.x | 11, 17 |
| 4.10.x | 17 |

Notes:
- Recommended target is Mule 4.10.x + Java 17 (LTS runtime with full Java-17 module-system support). Older intermediate stops (4.6/4.7/4.8/4.9) remain valid if you need to stage the bump.
- `mule-artifact.json` gains a `javaSpecificationVersions` field starting at Mule 4.5. The runtime bump script adds `["17"]` when the target is Java 17 or 21 and the field is absent.
- On Java 17, `mule-maven-plugin` still needs a `.mvn/jvm.config` next to `pom.xml` with these `--add-opens` directives so it can reflect into `java.base`:
  ```
  --add-opens=java.base/java.lang=ALL-UNNAMED
  --add-opens=java.base/java.net=ALL-UNNAMED
  --add-opens=java.base/java.nio=ALL-UNNAMED
  --add-opens=java.base/java.util=ALL-UNNAMED
  --add-opens=java.base/sun.nio.ch=ALL-UNNAMED
  --add-opens=java.base/sun.net.www.protocol.jar=ALL-UNNAMED
  ```
  Without the last line the packager throws `IllegalAccessError: sun.net.www.protocol.jar.JarURLConnection` on startup.

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
