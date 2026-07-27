#!/usr/bin/env python3
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
"""Apply deterministic runtime + Java bumps to pom.xml and mule-artifact.json.

Called by apply_runtime_bump.sh. Reads tmp/upgrade-targets.json for the
target Mule + Java version and mutates:

    pom.xml
      <app.runtime>              → target mule
      <javaVersion>              → target java  (add if absent)
      <maven.compiler.source>    → target java
      <maven.compiler.target>    → target java
      <mule.maven.plugin.version> → runtime-bump-matrix lookup

    mule-artifact.json
      minMuleVersion             → target mule
      javaSpecificationVersions  → add ["17"] (or target) if absent

Deterministic. No LLM. Prints a JSON summary of applied edits + a
JAVA_HOME check outcome. Exit non-zero if JAVA_HOME points to the wrong
Java version — the caller (skill) hands the fix instruction to the user.

The runtime-bump matrix is a small in-source table. Update it when a
new Mule minor drops — the plan cites this as the single point of drift.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


# Mule runtime → mule-maven-plugin version.
# Keep in sync with skills/upgrade-mule-connector/references/runtime-bump-matrix.md.
# When adding a row, pin the plugin version to the latest published on
# https://mvnrepository.com/artifact/org.mule.tools.maven/mule-maven-plugin
# at the time of update — the plugin's minor version tracks the runtime.
MULE_MAVEN_PLUGIN_MATRIX: dict[str, str] = {
    "4.3.0": "3.6.1",
    "4.3.": "3.6.1",
    "4.4.0": "3.8.0",
    "4.4.": "3.8.0",
    "4.5.0": "4.1.0",
    "4.5.": "4.1.0",
    "4.6.0": "4.3.0",
    "4.6.": "4.3.0",
    "4.7.0": "4.4.0",
    "4.7.": "4.4.0",
    "4.8.0": "4.6.0",
    "4.8.": "4.6.0",
    "4.9.0": "4.9.0",
    "4.9.": "4.9.0",
    "4.10.0": "4.10.1",
    "4.10.": "4.10.1",
}


def _mmp_for(runtime: str) -> str | None:
    # Longest-prefix match: 4.6.1 → 4.6. → 4.6.0's row.
    for k in sorted(MULE_MAVEN_PLUGIN_MATRIX, key=len, reverse=True):
        if runtime.startswith(k):
            return MULE_MAVEN_PLUGIN_MATRIX[k]
    return None


def _load(path: Path) -> Any:
    with open(path) as f:
        return json.load(f)


def _read(path: Path) -> str:
    return path.read_text()


def _write(path: Path, content: str) -> None:
    path.write_text(content)


def _replace_element(text: str, tag: str, new_value: str) -> tuple[str, bool]:
    """Replace <tag>...</tag> body. Return (new_text, changed)."""
    pat = re.compile(rf'(<{re.escape(tag)}>)([^<]*)(</{re.escape(tag)}>)')
    replaced = False

    def _sub(m: re.Match) -> str:
        nonlocal replaced
        if m.group(2) == new_value:
            return m.group(0)
        replaced = True
        return f'{m.group(1)}{new_value}{m.group(3)}'

    return pat.sub(_sub, text), replaced


def _insert_property(text: str, tag: str, value: str) -> tuple[str, bool]:
    """Insert <tag>value</tag> into <properties> block if absent. Best-effort."""
    prop_re = re.compile(r'(<properties>)(.*?)(</properties>)', re.DOTALL)
    m = prop_re.search(text)
    if not m:
        return text, False
    body = m.group(2)
    if re.search(rf'<{re.escape(tag)}>', body):
        return text, False
    # Preserve indentation from the last non-empty line of the block.
    indent_m = re.search(r'\n([ \t]+)<', body)
    indent = indent_m.group(1) if indent_m else "    "
    new_body = body.rstrip() + f'\n{indent}<{tag}>{value}</{tag}>\n{indent[:-4] if len(indent) >= 4 else ""}'
    new_text = text[:m.start(2)] + new_body + text[m.end(2):]
    return new_text, True


def edit_pom(pom_path: Path, target_mule: str, target_java: str, log: list[dict[str, Any]]) -> None:
    if not pom_path.exists():
        log.append({"file": str(pom_path), "status": "error", "reason": "pom.xml not found"})
        return

    text = _read(pom_path)
    original = text
    changes: list[str] = []

    for tag, val in (("app.runtime", target_mule),
                     ("javaVersion", target_java),
                     ("maven.compiler.source", target_java),
                     ("maven.compiler.target", target_java)):
        new_text, changed = _replace_element(text, tag, val)
        if changed:
            text = new_text
            changes.append(f"{tag}={val}")

    # javaVersion is not universally present — insert if missing.
    if "<javaVersion>" not in text:
        new_text, inserted = _insert_property(text, "javaVersion", target_java)
        if inserted:
            text = new_text
            changes.append(f"javaVersion={target_java} (inserted)")

    mmp = _mmp_for(target_mule)
    if mmp:
        new_text, changed = _replace_element(text, "mule.maven.plugin.version", mmp)
        if changed:
            text = new_text
            changes.append(f"mule.maven.plugin.version={mmp}")
        else:
            new_text, inserted = _insert_property(text, "mule.maven.plugin.version", mmp)
            if inserted:
                text = new_text
                changes.append(f"mule.maven.plugin.version={mmp} (inserted)")
    else:
        log.append({"file": str(pom_path), "status": "warn",
                    "reason": f"no mule-maven-plugin matrix entry for {target_mule} — leaving unchanged"})

    if text != original:
        _write(pom_path, text)
        log.append({"file": str(pom_path), "status": "applied", "changes": changes})
    else:
        log.append({"file": str(pom_path), "status": "no-op", "changes": []})


def edit_mule_artifact(artifact_path: Path, target_mule: str, target_java: str, log: list[dict[str, Any]]) -> None:
    if not artifact_path.exists():
        log.append({"file": str(artifact_path), "status": "error", "reason": "mule-artifact.json not found"})
        return

    with open(artifact_path) as f:
        artifact = json.load(f)

    changes: list[str] = []
    if artifact.get("minMuleVersion") != target_mule:
        artifact["minMuleVersion"] = target_mule
        changes.append(f"minMuleVersion={target_mule}")

    if target_java in ("17", "21"):
        existing = artifact.get("javaSpecificationVersions")
        if not existing:
            artifact["javaSpecificationVersions"] = [target_java]
            changes.append(f"javaSpecificationVersions=[{target_java}]")
        elif target_java not in existing:
            artifact["javaSpecificationVersions"] = list({*existing, target_java})
            changes.append(f"javaSpecificationVersions+={target_java}")

    if changes:
        with open(artifact_path, "w") as f:
            json.dump(artifact, f, indent=2)
            f.write("\n")
        log.append({"file": str(artifact_path), "status": "applied", "changes": changes})
    else:
        log.append({"file": str(artifact_path), "status": "no-op", "changes": []})


def check_java_home(env_path: Path, target_java: str) -> dict[str, Any]:
    if not env_path.exists():
        return {"status": "unknown", "reason": f"{env_path} not found — run validate_prerequisites.sh"}

    env = _load(env_path)
    current = str(env.get("java_version") or "")
    if not current:
        return {"status": "unknown", "reason": "java_version missing from mule-dev-env.json"}

    if current.startswith(target_java + ".") or current == target_java:
        return {"status": "ok", "current": current, "target": target_java}

    return {
        "status": "mismatch",
        "current": current,
        "target": target_java,
        "instruction": (
            f"JAVA_HOME points to Java {current} but the upgrade targets Java {target_java}. "
            f"Point JAVA_HOME at a Java {target_java} install (e.g. `export JAVA_HOME=$(/usr/libexec/java_home -v {target_java})` on macOS) "
            "and rerun."
        ),
    }


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--targets", required=True)
    p.add_argument("--project-dir", default=".")
    p.add_argument("--env-file", default="tmp/mule-dev-env.json")
    args = p.parse_args(argv[1:])

    targets = _load(Path(args.targets))
    target_mule = targets.get("mule", {}).get("to")
    target_java = targets.get("java", {}).get("to")
    if not target_mule or not target_java:
        print("❌ tmp/upgrade-targets.json is missing mule.to or java.to", file=sys.stderr)
        return 1

    root = Path(args.project_dir)
    log: list[dict[str, Any]] = []

    edit_pom(root / "pom.xml", target_mule, target_java, log)
    edit_mule_artifact(root / "mule-artifact.json", target_mule, target_java, log)

    java_check = check_java_home(Path(args.env_file), target_java)

    summary = {
        "targets": {"mule": target_mule, "java": target_java,
                    "mule_maven_plugin": _mmp_for(target_mule)},
        "applied": log,
        "java_home_check": java_check,
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")

    # Non-zero exit if JAVA_HOME mismatch — caller surfaces the instruction.
    return 2 if java_check.get("status") == "mismatch" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
