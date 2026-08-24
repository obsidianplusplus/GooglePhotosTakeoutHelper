"""从 CHANGELOG.md 中提取指定版本的发布说明。"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def changelog_for(version_text: str, changelog_path: Path) -> str:
    """返回指定语义化版本对应的正文，不包含二级标题。"""
    version = version_text.strip().removeprefix("v")
    if re.fullmatch(r"\d+\.\d+\.\d+", version) is None:
        raise ValueError(f"版本号格式无效：{version_text}")

    content = changelog_path.read_text(encoding="utf-8")
    header = re.search(rf"(?m)^##\s+{re.escape(version)}\s*$", content)
    if header is None:
        raise ValueError(f"变更日志中找不到版本 {version}")

    body_start = content.find("\n", header.end())
    if body_start < 0:
        return ""
    body_start += 1
    next_header = re.search(r"(?m)^##\s+", content[body_start:])
    body_end = body_start + next_header.start() if next_header else len(content)
    return content[body_start:body_end].strip()


def main() -> int:
    """解析命令行参数并打印发布说明。"""
    parser = argparse.ArgumentParser(description="提取指定版本的变更说明")
    parser.add_argument("--version", required=True, help="版本号，可带 v 前缀")
    args = parser.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    print(changelog_for(args.version, project_root / "CHANGELOG.md"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
