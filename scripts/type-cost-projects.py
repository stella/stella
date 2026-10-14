"""Select individual compiler projects from the existing Bun typecheck scripts."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re


def discover_projects(root):
    projects = {}
    manifests = [root / "package.json"]
    for parent in ("apps", "packages"):
        manifests.extend(sorted((root / parent).glob("*/package.json")))
    for manifest in manifests:
        package = json.loads(manifest.read_text())
        for task, command in package.get("scripts", {}).items():
            if task not in ("typecheck", "typecheck:repo") and not task.startswith("typecheck:"):
                continue
            for match in re.finditer(r"\bbun check\b[^;&]*?--project=([^\s;&]+)", command):
                config = (manifest.parent / match[1]).resolve()
                project = config.relative_to(root.resolve()).as_posix()
                if not config.is_file() or config.name == "tsconfig.json" and config.parent == root:
                    raise ValueError(f"Expected an individual compiler project: {project}")
                identifier = hashlib.sha256(project.encode()).hexdigest()[:12]
                projects[project] = {"id": identifier, "project": project, "package": package["name"]}
    if not projects:
        raise ValueError("No Bun typecheck projects found")
    return projects


def select_projects(projects, targets):
    selected = targets.split() if targets.strip() else sorted(projects)
    if len(selected) != len(set(selected)):
        raise ValueError("Duplicate compiler projects")
    unknown = sorted(set(selected) - projects.keys())
    if unknown:
        raise ValueError(f"Projects must appear in existing typecheck scripts: {', '.join(unknown)}")
    if len(selected) > 256:
        raise ValueError("Project selection exceeds the matrix limit")
    return {"include": [projects[project] for project in selected]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    root = parser.parse_args().root.resolve()
    matrix = select_projects(discover_projects(root), os.environ.get("TYPE_COST_PROJECTS", ""))
    print(json.dumps(matrix, separators=(",", ":")))
