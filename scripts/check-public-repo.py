#!/usr/bin/env python3
"""Fail closed when the CLI repository is not safe as a public standalone repo."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
EXPECTED_REPOSITORY = "git+https://github.com/screenrig/cli.git"
EXPECTED_VERSION = "0.1.0"
TEXT_SUFFIXES = {"", ".cjs", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".toml", ".ts", ".yaml", ".yml"}
IGNORED_PARTS = {".git", ".tmp", "dist", "node_modules"}


def git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def worktree_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file() and not any(part in IGNORED_PARTS for part in path.relative_to(ROOT).parts)
    )


def check_metadata(errors: list[str]) -> None:
    try:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"package metadata is unreadable: {exc}")
        return

    expected = {
        "name": "screenrig",
        "version": EXPECTED_VERSION,
        "private": False,
        "license": "Apache-2.0",
    }
    for field, value in expected.items():
        if package.get(field) != value:
            errors.append(f"package.json {field!r} must be {value!r}")
    repository = package.get("repository")
    if not isinstance(repository, dict) or repository.get("url") != EXPECTED_REPOSITORY:
        errors.append(f"package.json repository.url must be {EXPECTED_REPOSITORY}")
    if package.get("publishConfig") != {
        "access": "public",
        "provenance": True,
        "registry": "https://registry.npmjs.org/",
    }:
        errors.append("package.json publishConfig must require public npm access and provenance")
    package_files = package.get("files") or []
    if not isinstance(package_files, list) or "SECURITY.md" not in package_files:
        errors.append("package.json files must include SECURITY.md in the public npm package")
    try:
        commands = (ROOT / "src" / "commands.ts").read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"src/commands.ts is unreadable: {exc}")
    else:
        if f'export const CLI_VERSION = "{EXPECTED_VERSION}";' not in commands:
            errors.append("CLI_VERSION must match the public package version")

    root_lock = (lock.get("packages") or {}).get("") or {}
    for field in ("name", "version", "license"):
        if root_lock.get(field) != package.get(field):
            errors.append(f"package-lock.json root {field!r} drifts from package.json")


def check_public_tree(errors: list[str]) -> None:
    for required in ("LICENSE", "README.md", "SECURITY.md", ".gitleaks.toml"):
        if not (ROOT / required).is_file():
            errors.append(f"missing public root file: {required}")
    workflow_path = ROOT / ".github" / "workflows" / "ci.yml"
    if not workflow_path.is_file():
        errors.append("missing public root file: .github/workflows/ci.yml")
    else:
        workflow = workflow_path.read_text(encoding="utf-8")
        for fact in (
            "fetch-depth: 0",
            "python3 scripts/check-public-repo.py",
            "npm run lint",
            "npm audit --audit-level=high --package-lock-only",
            "name: screenrig-cli",
            "name: npm install (${{ matrix.os }}, Node 20.11.1)",
            "os: [ubuntu-24.04, macos-14, windows-2022]",
            "npm run check:npm-install",
            "gitleaks\" git",
        ):
            if fact not in workflow:
                errors.append(f"public CI is missing required gate: {fact}")
    release_path = ROOT / "scripts" / "package-release.sh"
    if not release_path.is_file():
        errors.append("missing public packaging file: scripts/package-release.sh")
    else:
        release = release_path.read_text(encoding="utf-8")
        for fact in ("scripts/vendor-runtime-dependencies.mjs", "scripts/check-release-artifact.mjs"):
            if fact not in release:
                errors.append(f"CLI release packaging is missing required gate: {fact}")

    npm_release_path = ROOT / ".github" / "workflows" / "npm-release.yml"
    if not npm_release_path.is_file():
        errors.append("missing public npm release workflow: .github/workflows/npm-release.yml")
    else:
        npm_release = npm_release_path.read_text(encoding="utf-8")
        for fact in (
            "types: [published]",
            "github.event.release.prerelease == false",
            "environment: npm",
            "id-token: write",
            "npm install --global npm@11.5.1",
            "node scripts/check-release-tag.mjs",
            "npm publish --access public",
            "screenrig@${{ needs.publish.outputs.version }}",
            "ubuntu-24.04, macos-14, windows-2022",
            "gh release upload",
        ):
            if fact not in npm_release:
                errors.append(f"npm release workflow is missing required gate: {fact}")
        if "NODE_AUTH_TOKEN" in npm_release or "NPM_TOKEN" in npm_release:
            errors.append("npm release workflow must use trusted publishing without a long-lived token")

    for required in (
        "RELEASING.md",
        "scripts/check-release-tag.mjs",
        "scripts/check-npm-install.mjs",
    ):
        if not (ROOT / required).is_file():
            errors.append(f"missing public npm release file: {required}")

    prohibited_names = {
        "SPLIT_" + "HANDOFF.md",
        "FABLE_REVIEW.md",
        "HAND" + "OFF.md",
    }
    forbidden_fragments = (
        "github.com/telemetry" + "OS/screenrig",
        "git@github.com:telemetry" + "OS/screenrig",
        "/home/" + "gersham/",
        ".codex-" + "tmp",
        ".test" + "runs/",
    )
    for path in worktree_files():
        relative = path.relative_to(ROOT)
        if relative.name in prohibited_names:
            errors.append(f"internal evidence file is not public: {relative}")
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for fragment in forbidden_fragments:
            if fragment in text:
                errors.append(f"private reference {fragment!r} in {relative}")

    # These test-only reads cross the intended public CLI repository root and
    # must be replaced by a pinned public fixture or dependency before split.
    cross_repo_read = re.compile(r'["\'](?:\.\./){2,}(?:api|packages?)/')
    for path in (ROOT / "src").rglob("*.ts"):
        text = path.read_text(encoding="utf-8")
        if cross_repo_read.search(text):
            errors.append(f"inaccessible cross-repository test/source dependency in {path.relative_to(ROOT)}")


def check_history(errors: list[str]) -> None:
    top = git("rev-parse", "--show-toplevel")
    if top.returncode != 0:
        errors.append("public repository must be a Git worktree")
        return
    if Path(top.stdout.strip()).resolve() != ROOT.resolve():
        errors.append("run this check only after packages/cli becomes the public repository root")
        return

    shallow = git("rev-parse", "--is-shallow-repository")
    if shallow.returncode != 0 or shallow.stdout.strip() != "false":
        errors.append("full-history checks require a non-shallow checkout")

    names = git("log", "--all", "--format=", "--name-only")
    if names.returncode != 0:
        errors.append(f"cannot inspect Git history paths: {names.stderr.strip()}")
        return
    prohibited = re.compile(
        r"(^|/)(?:HANDOFF\.md|SPLIT_HANDOFF\.md|FABLE_REVIEW\.md|\.test"
        r"runs|\.codex-"
        r"tmp)(?:$|/)"
    )
    leaked_paths = sorted({line for line in names.stdout.splitlines() if prohibited.search(line)})
    if leaked_paths:
        errors.append("internal evidence exists in Git history: " + ", ".join(leaked_paths[:5]))

    forbidden_history = (
        "github.com/telemetry" + "OS/screenrig",
        "git@github.com:telemetry" + "OS/screenrig",
        "/home/" + "gersham/",
        ".codex-" + "tmp",
        ".test" + "runs/",
    )
    for fragment in forbidden_history:
        patches = git("log", "--all", "-G", fragment, "--format=%H")
        if patches.returncode != 0:
            errors.append(f"cannot inspect Git history content: {patches.stderr.strip()}")
            break
        if patches.stdout.strip():
            errors.append(f"private reference {fragment!r} exists in Git history")


def main() -> int:
    errors: list[str] = []
    check_metadata(errors)
    check_public_tree(errors)
    check_history(errors)
    if errors:
        print("public CLI repository check failed:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print("public CLI repository check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
