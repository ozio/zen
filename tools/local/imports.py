"""Prepare overlapping Zen overlays before Surfer reverses external patches."""
from pathlib import Path
from typing import Any, Dict, Set
import uuid

from core import Context, DevError, atomic_json, no_symlink_ancestors, utc_now


def patch_paths(ctx: Context, patch: Path, env: Dict[str, str]) -> Set[str]:
    no_symlink_ancestors(patch)
    result = ctx.runner.run(["git", "apply", "--numstat", str(patch)], ctx.root / "engine", env=env)
    paths = set()
    for row in result.stdout.splitlines():
        fields = row.split("\t", 2)
        if len(fields) != 3:
            raise DevError("Cannot inspect patch target paths: %s" % patch)
        path = Path(fields[2])
        if (path.is_absolute() or ".." in path.parts or fields[2].startswith('"')
                or " => " in fields[2]):
            raise DevError("Inspect unsupported patch target before import: %s" % patch)
        paths.add(path.as_posix())
    return paths


def prepare_external_overlays(ctx: Context, env: Dict[str, str]) -> Dict[str, Any]:
    """Undo only already-applied canonical overlays that overlap an external patch.

    Surfer imports external patches before later toolkit overlays. On a prepared
    engine those overlays can make an external reverse fail, followed by an
    equally invalid forward application. Preserve a scoped source snapshot and
    undo overlays in reverse import order; the normal import reapplies both.
    Neither a forward nor reverse check matching means unexpected engine work,
    so refuse rather than discard it or accept an entire side.
    """
    external_root = ctx.root / "src" / "external-patches"
    external_paths = set()
    external_patches = []
    for patch in sorted(external_root.rglob("*.patch")):
        paths = patch_paths(ctx, patch, env)
        external_paths.update(paths)
        external_patches.append((patch, paths))
    selected = []
    for patch in sorted((ctx.root / "src").rglob("*.patch"), reverse=True):
        if patch.is_relative_to(external_root):
            continue
        paths = patch_paths(ctx, patch, env)
        if paths & external_paths:
            selected.append((patch, paths))
    receipt = {"schema_version":1, "created_at":utc_now(), "reversed":[], "absent":[]}
    if not selected:
        return receipt
    backup = ctx.managed(ctx.local / "import-preparation" / uuid.uuid4().hex, create_parent=True)
    backup.mkdir(mode=0o700)
    # Save the whole target files, including any unrelated content, before edits.
    for name in sorted(set().union(*(paths for _, paths in selected))):
        source = ctx.root / "engine" / name
        no_symlink_ancestors(source)
        if source.is_file():
            target = backup / "source" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
    receipt["source_snapshot"] = str(backup / "source")
    for patch, paths in selected:
        flags = ["--ignore-whitespace", "--ignore-space-change"]
        reverse = ["git", "apply", "-R", *flags, str(patch)]
        reverse_check = ctx.runner.run([*reverse[:2], "--check", *reverse[2:]], ctx.root / "engine", env=env, check=False)
        key = patch.relative_to(ctx.root).as_posix()
        if reverse_check.returncode == 0:
            ctx.runner.run(reverse, ctx.root / "engine", env=env)
            receipt["reversed"].append(key)
        else:
            forward = ctx.runner.run(["git", "apply", "--check", *flags, str(patch)], ctx.root / "engine", env=env, check=False)
            if forward.returncode:
                # A freshly downloaded tree may not have its external layer yet.
                # Do not mutate it: normal ordered import must apply that first.
                dependencies = [p for p, targets in external_patches if targets & paths]
                if dependencies and all(ctx.runner.run(
                        ["git", "apply", "--check", *flags, str(dependency)], ctx.root / "engine",
                        env=env, check=False).returncode == 0 for dependency in dependencies):
                    receipt.setdefault("awaiting_external", []).append(key)
                    atomic_json(backup / "receipt.json", receipt)
                    continue
                receipt["refused"] = key
                atomic_json(backup / "receipt.json", receipt)
                raise DevError("Overlapping canonical patch matches neither applied nor unapplied engine state: %s. "
                               "Preserve/export intentional engine work; source snapshot: %s" % (key, backup))
            receipt["absent"].append(key)
        atomic_json(backup / "receipt.json", receipt)
    return receipt
