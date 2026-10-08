"""Experience library loader for injecting app-specific knowledge into system prompts."""

import os
from pathlib import Path

# Default experiences directory (sibling to config/)
EXPERIENCES_DIR = Path(__file__).parent.parent / "experiences"


def load_experiences(
    task: str, app_name: str = "", experiences_dir: str | Path | None = None
) -> str:
    """
    Load relevant experiences based on task description and current app name.

    Loading logic:
    1. Always load _global.md (universal experiences)
    2. Match and load app-specific experience file by app_name
    3. Fuzzy match experience files by keywords in the task text

    Args:
        task: Task description text.
        app_name: Current app name (e.g., "美团", "微信").
        experiences_dir: Optional custom experiences directory path.

    Returns:
        Combined experience text to append to system prompt.
        Empty string if no experiences found.
    """
    exp_dir = Path(experiences_dir) if experiences_dir else EXPERIENCES_DIR

    if not exp_dir.exists():
        return ""

    loaded_files: list[str] = []
    loaded_names: set[str] = set()
    sections: list[str] = []

    # 1. Always load _global.md
    global_file = exp_dir / "_global.md"
    if global_file.exists():
        content = global_file.read_text(encoding="utf-8").strip()
        if content:
            sections.append(content)
            loaded_names.add("_global.md")

    # 2. Match by app_name (exact match and partial match)
    if app_name:
        # Collect all .md files (excluding _global.md and README.md)
        md_files = [
            f
            for f in exp_dir.glob("*.md")
            if f.name not in ("_global.md", "README.md")
        ]

        for md_file in md_files:
            stem = md_file.stem  # filename without extension
            # Exact match or partial match (app_name contains filename or vice versa)
            if stem == app_name or stem in app_name or app_name in stem:
                if md_file.name not in loaded_names:
                    content = md_file.read_text(encoding="utf-8").strip()
                    if content:
                        sections.append(content)
                        loaded_names.add(md_file.name)

    # 3. Fuzzy match by task keywords
    if task:
        md_files = [
            f
            for f in exp_dir.glob("*.md")
            if f.name not in ("_global.md", "README.md")
            and f.name not in loaded_names
        ]

        for md_file in md_files:
            stem = md_file.stem
            # Check if the filename (app name) appears in the task description
            if stem in task:
                content = md_file.read_text(encoding="utf-8").strip()
                if content:
                    sections.append(content)
                    loaded_names.add(md_file.name)

    if not sections:
        return ""

    return "\n\n".join(sections)
