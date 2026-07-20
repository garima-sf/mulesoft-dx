#!/usr/bin/env python3
#
# Copyright (c) 2026, Salesforce, Inc.
# All rights reserved.
# For full license text, see the LICENSE.txt file
#
"""Apply deterministic connector version + XSD URL bumps.

Called by apply_connector_pin.sh. Reads tmp/connector-choices/<nick>-new.json
for the target GAV and tmp/connector-metadata/<nick>-new.json for namespace
metadata, then mutates:

    pom.xml
      <dependency> matching groupId+artifactId → bump <version> (inline or property)

    src/main/mule/*.xml
      xsi:schemaLocation attribute → rewrite XSD URL for matching namespace

Deterministic. No LLM. Prints a JSON summary of applied edits.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any
from xml.dom import minidom


def _load(path: Path) -> Any:
    with open(path) as f:
        return json.load(f)


def _read(path: Path) -> str:
    return path.read_text()


def _write(path: Path, content: str) -> None:
    path.write_text(content)


def edit_pom_dependency(pom_path: Path, gav: dict[str, str], log: list[dict[str, Any]]) -> None:
    """Bump connector <version> in pom.xml for matching groupId+artifactId."""
    if not pom_path.exists():
        log.append({"file": str(pom_path), "status": "error", "reason": "pom.xml not found"})
        return

    group_id = gav["groupId"]
    asset_id = gav["assetId"]
    new_version = gav["version"]

    try:
        doc = minidom.parse(str(pom_path))
    except Exception as e:
        log.append({"file": str(pom_path), "status": "error", "reason": f"XML parse failed: {e}"})
        return

    deps = doc.getElementsByTagName("dependency")
    found = False
    old_version = None

    for dep in deps:
        g_elems = dep.getElementsByTagName("groupId")
        a_elems = dep.getElementsByTagName("artifactId")
        if not g_elems or not a_elems:
            continue
        g_text = g_elems[0].firstChild.nodeValue.strip() if g_elems[0].firstChild else ""
        a_text = a_elems[0].firstChild.nodeValue.strip() if a_elems[0].firstChild else ""

        if g_text == group_id and a_text == asset_id:
            found = True
            v_elems = dep.getElementsByTagName("version")
            if not v_elems:
                log.append({
                    "file": str(pom_path),
                    "status": "error",
                    "reason": f"{group_id}:{asset_id} missing <version> element"
                })
                return

            v_elem = v_elems[0]
            v_text = v_elem.firstChild.nodeValue.strip() if v_elem.firstChild else ""

            # Check if it's a property reference like ${s3.connector.version}
            if v_text.startswith("${") and v_text.endswith("}"):
                prop_name = v_text[2:-1]
                # Find the property in <properties>
                props = doc.getElementsByTagName("properties")
                if not props:
                    log.append({
                        "file": str(pom_path),
                        "status": "error",
                        "reason": f"<version> references property ${{{prop_name}}} but <properties> block not found"
                    })
                    return

                prop_elems = props[0].getElementsByTagName(prop_name)
                if not prop_elems:
                    log.append({
                        "file": str(pom_path),
                        "status": "error",
                        "reason": f"property {prop_name} not found in <properties>"
                    })
                    return

                prop_elem = prop_elems[0]
                old_version = prop_elem.firstChild.nodeValue.strip() if prop_elem.firstChild else ""
                if old_version == new_version:
                    log.append({
                        "file": str(pom_path),
                        "status": "no-op",
                        "from": old_version,
                        "to": new_version
                    })
                    return

                # Update the property
                if prop_elem.firstChild:
                    prop_elem.firstChild.nodeValue = new_version
                else:
                    prop_elem.appendChild(doc.createTextNode(new_version))
            else:
                # Inline version
                old_version = v_text
                if old_version == new_version:
                    log.append({
                        "file": str(pom_path),
                        "status": "no-op",
                        "from": old_version,
                        "to": new_version
                    })
                    return

                if v_elem.firstChild:
                    v_elem.firstChild.nodeValue = new_version
                else:
                    v_elem.appendChild(doc.createTextNode(new_version))

            break

    if not found:
        log.append({
            "file": str(pom_path),
            "status": "error",
            "reason": f"dependency {group_id}:{asset_id} not found"
        })
        return

    # Write back
    with open(pom_path, "w") as f:
        doc.writexml(f, encoding="UTF-8")

    log.append({
        "file": str(pom_path),
        "status": "ok",
        "from": old_version,
        "to": new_version
    })


def edit_flow_xsd_urls(
    project_dir: Path,
    namespace_prefix: str,
    namespace_metadata: dict[str, Any],
    log: list[dict[str, Any]]
) -> None:
    """Rewrite xsi:schemaLocation URLs in all flow XMLs for matching namespace."""
    flow_dir = project_dir / "src" / "main" / "mule"
    if not flow_dir.exists():
        log.append({
            "status": "warn",
            "reason": f"flow directory {flow_dir} not found"
        })
        return

    # Extract the namespace URL we're looking for
    ns_info = namespace_metadata.get("namespace", {})
    # The metadata has .prefix but we need the URL pattern
    # From the s3 fixture we saw xmlns:s3="http://www.mulesoft.org/schema/mule/s3"
    # Let's construct it from the prefix
    target_ns_url = f"http://www.mulesoft.org/schema/mule/{namespace_prefix}"

    # Get the new XSD URL - checking if we have schemaLocation in the namespace block
    # The metadata file we saw didn't have schemaLocation, but let's handle both cases
    new_xsd_url = None

    # Try to find schemaLocation in metadata
    if "schemaLocation" in ns_info:
        new_xsd_url = ns_info["schemaLocation"]
    else:
        # Construct default pattern
        new_xsd_url = f"http://www.mulesoft.org/schema/mule/{namespace_prefix}/current/mule-{namespace_prefix}.xsd"

    flow_files = list(flow_dir.glob("*.xml"))
    if not flow_files:
        log.append({
            "status": "warn",
            "reason": f"no flow XMLs found in {flow_dir}"
        })
        return

    for flow_file in flow_files:
        try:
            content = _read(flow_file)
            original = content

            # Find xsi:schemaLocation attribute value
            # It's a whitespace-separated list of (xmlns-url xsd-url) pairs
            schema_loc_match = re.search(
                r'xsi:schemaLocation="([^"]*)"',
                content,
                re.DOTALL
            )
            if not schema_loc_match:
                log.append({
                    "file": str(flow_file),
                    "status": "skip",
                    "reason": "no xsi:schemaLocation attribute found"
                })
                continue

            schema_loc_value = schema_loc_match.group(1)
            # Split into tokens
            tokens = schema_loc_value.split()
            # Process pairs
            updated_tokens = []
            changed = False

            i = 0
            while i < len(tokens):
                if i + 1 >= len(tokens):
                    # Odd number of tokens - preserve as-is
                    updated_tokens.append(tokens[i])
                    i += 1
                    continue

                xmlns_url = tokens[i].strip()
                xsd_url = tokens[i + 1].strip()

                # Check if this xmlns URL matches our target namespace
                # Allow for version variations in the URL
                if xmlns_url == target_ns_url or \
                   re.match(rf'^{re.escape(target_ns_url)}(/|$)', xmlns_url):
                    # Rewrite the paired XSD URL
                    updated_tokens.append(xmlns_url)
                    updated_tokens.append(new_xsd_url)
                    changed = True
                else:
                    updated_tokens.append(xmlns_url)
                    updated_tokens.append(xsd_url)

                i += 2

            if not changed:
                log.append({
                    "file": str(flow_file),
                    "status": "skip",
                    "reason": f"namespace {target_ns_url} not found in schemaLocation"
                })
                continue

            # Reconstruct the schemaLocation value
            # Preserve original indentation style
            new_schema_loc_value = "\n        ".join(
                f"{updated_tokens[j]}\n        {updated_tokens[j+1]}"
                for j in range(0, len(updated_tokens), 2)
            )
            new_schema_loc_value = "\n        " + new_schema_loc_value

            new_content = content[:schema_loc_match.start(1)] + \
                         new_schema_loc_value + \
                         content[schema_loc_match.end(1):]

            if new_content != original:
                _write(flow_file, new_content)
                log.append({
                    "file": str(flow_file),
                    "status": "ok",
                    "count": 1
                })
            else:
                log.append({
                    "file": str(flow_file),
                    "status": "no-op"
                })

        except Exception as e:
            log.append({
                "file": str(flow_file),
                "status": "error",
                "reason": str(e)
            })


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--nick", required=True)
    p.add_argument("--project-dir", default=".")
    args = p.parse_args(argv[1:])

    root = Path(args.project_dir)
    choice_file = root / f"tmp/connector-choices/{args.nick}-new.json"
    metadata_file = root / f"tmp/connector-metadata/{args.nick}-new.json"

    if not choice_file.exists():
        print(f"❌ missing {choice_file}", file=sys.stderr)
        return 1

    if not metadata_file.exists():
        print(f"❌ missing {metadata_file}", file=sys.stderr)
        return 1

    gav = _load(choice_file)
    metadata = _load(metadata_file)

    pom_log: list[dict[str, Any]] = []
    xsd_log: list[dict[str, Any]] = []

    edit_pom_dependency(root / "pom.xml", gav, pom_log)
    edit_flow_xsd_urls(root, args.nick, metadata, xsd_log)

    summary = {
        "nick": args.nick,
        "pom_edits": pom_log,
        "xsd_edits": xsd_log,
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
