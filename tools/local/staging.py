"""Pinned, reviewable GitHub and upstream experiments on detached worktrees."""
from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import urlsplit

from core import Context, DevError, atomic_json, read_json, require_sha, utc_now

LOCAL_IDENTITY = ["-c", "user.name=Zen Local Staging", "-c", "user.email=zen-local@invalid"]


def parse_pr_url(value: str) -> Tuple[str, str, int]:
    parsed = urlsplit(value)
    match = re.fullmatch(r"/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9_.-]+)/pull/([1-9][0-9]*)/?", parsed.path)
    if parsed.scheme != "https" or parsed.netloc != "github.com" or parsed.query or parsed.fragment or not match:
        raise DevError("Use a canonical https://github.com/OWNER/REPO/pull/NUMBER URL")
    owner, repo, number = match.groups()
    if repo in (".", ".."):
        raise DevError("Invalid GitHub repository")
    return owner, repo, int(number)


def gh_json(ctx: Context, endpoint: str, paginate: bool = False) -> Any:
    argv = ["gh", "api", endpoint]
    if paginate:
        argv.extend(["--paginate", "--slurp"])
    try:
        result = json.loads(ctx.runner.run(argv, ctx.root).stdout)
    except ValueError as error:
        raise DevError("GitHub returned invalid JSON for %s" % endpoint) from error
    return result


def gh_list(ctx: Context, endpoint: str) -> List[Any]:
    pages = gh_json(ctx, endpoint, paginate=True)
    if not isinstance(pages, list) or any(not isinstance(page, list) for page in pages):
        raise DevError("Unexpected paginated GitHub response for %s" % endpoint)
    return [item for page in pages for item in page]


def review_threads(ctx: Context, owner: str, repo: str, number: int) -> Dict[str, Any]:
    query = ("query($owner:String!,$repo:String!,$number:Int!,$cursor:String){"
             "repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision "
             "reviewThreads(first:100,after:$cursor){nodes{id isResolved isOutdated path line "
             "comments(first:100){nodes{id body url author{login} createdAt}pageInfo{hasNextPage endCursor}}}"
             "pageInfo{hasNextPage endCursor}}}}}")
    threads = []
    cursor = None
    decision = None
    while True:
        argv = ["gh", "api", "graphql", "-f", "query=" + query, "-f", "owner=" + owner,
                "-f", "repo=" + repo, "-F", "number=" + str(number)]
        if cursor:
            argv.extend(["-f", "cursor=" + cursor])
        data = json.loads(ctx.runner.run(argv, ctx.root).stdout)
        if data.get("errors"):
            raise DevError("GitHub review thread query failed")
        try:
            pull = data["data"]["repository"]["pullRequest"]
            page = pull["reviewThreads"]
        except (KeyError, TypeError) as error:
            raise DevError("GitHub returned no PR review thread data") from error
        decision = pull["reviewDecision"]
        for thread in page["nodes"]:
            comments = thread["comments"]
            while comments["pageInfo"]["hasNextPage"]:
                next_query = ("query($id:ID!,$cursor:String!){node(id:$id){... on PullRequestReviewThread{"
                              "comments(first:100,after:$cursor){nodes{id body url author{login} createdAt}"
                              "pageInfo{hasNextPage endCursor}}}}}")
                extra = json.loads(ctx.runner.run(["gh", "api", "graphql", "-f", "query=" + next_query,
                    "-f", "id=" + thread["id"], "-f", "cursor=" + comments["pageInfo"]["endCursor"]], ctx.root).stdout)
                if extra.get("errors"):
                    raise DevError("GitHub review comment pagination failed")
                next_page = extra["data"]["node"]["comments"]
                comments["nodes"].extend(next_page["nodes"])
                comments["pageInfo"] = next_page["pageInfo"]
            threads.append(thread)
        if not page["pageInfo"]["hasNextPage"]:
            return {"reviewDecision": decision, "threads": threads}
        cursor = page["pageInfo"]["endCursor"]


def _new_experiment(ctx: Context, label: str, before: Dict[str, Any]) -> Tuple[Path, Path, Dict[str, Any]]:
    ident = label + "-" + uuid.uuid4().hex[:12]
    directory = ctx.managed(ctx.local / "experiments" / ident, create_parent=True)
    directory.mkdir(mode=0o700)
    worktree = ctx.managed(ctx.local / "worktrees" / ident, create_parent=True)
    manifest = {"schema_version": 1, "id": ident, "created_at": utc_now(), "root": str(ctx.root),
                "source_fork_sha": before["source_sha"], "source_snapshot": before,
                "worktree": str(worktree), "state": "collecting"}
    return directory, worktree, manifest


def _create_worktree(ctx: Context, worktree: Path, fork_sha: str) -> None:
    # Detached from OUR fork HEAD. PR base is provenance, never the experiment starting point.
    ctx.git("worktree", "add", "--detach", str(worktree), require_sha(fork_sha))


def _save_result(ctx: Context, path: Path, manifest: Dict[str, Any], before: Dict[str, Any]) -> Dict[str, Any]:
    atomic_json(path, manifest)
    ctx.assert_snapshot(before)
    return {"manifest": str(path), "worktree": manifest.get("worktree"),
            "state": manifest["state"], "head_sha": manifest.get("head_sha"),
            "result_sha": manifest.get("result_sha")}


def stage_pr(ctx: Context, args: Any) -> Dict[str, Any]:
    owner, repo, number = parse_pr_url(args.url)
    if args.apply and not args.reviewed_head:
        raise DevError("Review the staged metadata/diff, then use --apply --reviewed-head FULLSHA")
    if not args.apply and (args.reviewed_head or args.commit):
        raise DevError("--reviewed-head/--commit require --apply")
    endpoint = "repos/%s/%s/pulls/%s" % (owner, repo, number)
    remote = "https://github.com/%s/%s.git" % (owner, repo)
    with ctx.lock():
        before = ctx.snapshot()
        pull = gh_json(ctx, endpoint)
        try:
            head = require_sha(pull["head"]["sha"])
            base = require_sha(pull["base"]["sha"])
        except (KeyError, TypeError) as error:
            raise DevError("PR metadata has no exact head/base") from error
        if args.apply and require_sha(args.reviewed_head) != head:
            raise DevError("PR head changed since review; inspect the new pinned snapshot")
        directory, worktree, manifest = _new_experiment(ctx, "pr-%s-%s" % (number, head[:10]), before)
        path = directory / "manifest.json"
        manifest.update({"kind": "pull-request", "url": "https://github.com/%s/%s/pull/%s" % (owner, repo, number),
                         "head_sha": head, "base_sha": base, "github_repository": owner + "/" + repo,
                         "apply_requested": args.apply, "reviewed_head": args.reviewed_head,
                         "main_preserved": True, "metadata": "metadata.json", "diff": "changes.diff"})
        atomic_json(path, manifest)
        try:
            commits = gh_list(ctx, endpoint + "/commits?per_page=100")
            metadata = {"pull_request": pull, "commits": commits,
                        "comments": gh_list(ctx, "repos/%s/%s/issues/%s/comments?per_page=100" % (owner, repo, number)),
                        "reviews": gh_list(ctx, endpoint + "/reviews?per_page=100"),
                        "review_comments": gh_list(ctx, endpoint + "/comments?per_page=100"),
                        "review_threads": review_threads(ctx, owner, repo, number),
                        "status": gh_json(ctx, "repos/%s/%s/commits/%s/status" % (owner, repo, head)),
                        "checks": gh_json(ctx, "repos/%s/%s/commits/%s/check-runs?per_page=100" % (owner, repo, head), True)}
            atomic_json(directory / "metadata.json", metadata)
            pinned = [require_sha(item["sha"]) for item in commits]
            if not pinned or len(set(pinned)) != len(pinned) or pinned[-1] != head:
                raise DevError("PR commits are incomplete or do not end at pinned head")
            manifest["pinned_commits"] = pinned
            ref = "refs/zen-local/pr/" + manifest["id"]
            ctx.git("fetch", "--no-tags", "--no-write-fetch-head", remote,
                    "refs/pull/%s/head:%s" % (number, ref))
            if ctx.git("rev-parse", ref).stdout.strip() != head:
                raise DevError("Fetched PR head changed during metadata collection")
            ctx.git("fetch", "--no-tags", "--no-write-fetch-head", remote, base)
            merge_base = require_sha(ctx.git("merge-base", base, head).stdout.strip())
            actual_commits = ctx.git("rev-list", "--reverse", "--topo-order", merge_base + ".." + head).stdout.splitlines()
            if set(actual_commits) != set(pinned):
                raise DevError("API PR commit list differs from fetched Git graph; no patches applied")
            manifest["merge_base_sha"] = merge_base
            diff = ctx.git("diff", "--binary", merge_base + ".." + head, "--").stdout
            (directory / "changes.diff").write_text(diff, encoding="utf-8")
            refreshed = gh_json(ctx, endpoint)
            if refreshed["head"]["sha"] != head or refreshed["base"]["sha"] != base:
                raise DevError("PR moved while collecting evidence; stage again")
            _create_worktree(ctx, worktree, before["source_sha"])
            manifest["state"] = "awaiting-review"
            if args.apply:
                requested = [require_sha(value) for value in args.commit] if args.commit else pinned
                if len(set(requested)) != len(requested) or any(value not in pinned for value in requested):
                    raise DevError("Every selected commit must be a distinct reviewed pinned PR commit")
                selected = [value for value in pinned if value in requested]
                if selected != requested:
                    raise DevError("Selected commits must keep the PR's order")
                if any(len(item.get("parents", [])) != 1 for item in commits if item["sha"] in selected):
                    raise DevError("Merge commits need explicit expert resolution; select linear commits")
                manifest["selected_commits"] = selected
                manifest["applied_commits"] = []
                for commit in selected:
                    result = ctx.git(*LOCAL_IDENTITY, "cherry-pick", "-x", commit, cwd=worktree, check=False)
                    if result.returncode:
                        manifest["state"] = "conflicted"
                        manifest["conflicted_commit"] = commit
                        manifest["error"] = result.stderr[-3000:]
                        _save_result(ctx, path, manifest, before)
                        raise DevError("PR conflicts retained in %s; main checkout was preserved" % worktree)
                    manifest["applied_commits"].append({"original_sha": commit, "local_sha": ctx.sha(worktree)})
                    atomic_json(path, manifest)
                manifest["state"] = "staged"
                manifest["result_sha"] = ctx.sha(worktree)
            return _save_result(ctx, path, manifest, before)
        except BaseException as error:
            if manifest["state"] not in ("conflicted", "staged"):
                manifest["state"] = "failed"
                manifest["error"] = str(error)[-3000:]
                atomic_json(path, manifest)
            raise


def validate_ref(value: str) -> str:
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}", value or "") or ".." in value
            or "//" in value or value.endswith(("/", ".", ".lock"))):
        raise DevError("Use a plain upstream branch name")
    return value


def accept_upstream(ctx: Context, args: Any) -> Dict[str, Any]:
    path = ctx.managed(Path(args.accept).absolute())
    if not path.is_relative_to(ctx.local / "experiments"):
        raise DevError("Accept requires this checkout's experiment manifest")
    with ctx.lock():
        manifest = read_json(path)
        if (manifest.get("schema_version") != 1 or manifest.get("kind") != "upstream"
                or manifest.get("state") not in ("staged", "conflicted") or manifest.get("root") != str(ctx.root)):
            raise DevError("Not a successful staged upstream experiment")
        fork = require_sha(manifest.get("source_fork_sha"))
        upstream = require_sha(manifest.get("upstream_sha"))
        previous_result = manifest.get("result_sha")
        result = require_sha(args.reviewed_result or previous_result)
        if manifest["state"] == "conflicted" and not args.reviewed_result:
            raise DevError("Resolved conflicts require --reviewed-result FULLSHA after review")
        worktree = ctx.managed(Path(manifest.get("worktree", "")))
        if not worktree.is_relative_to(ctx.local / "worktrees") or ctx.sha(worktree) != result:
            raise DevError("Staged worktree has changed; restage and review")
        if ctx.git("status", "--porcelain=v1", "--untracked-files=all", cwd=worktree).stdout:
            raise DevError("Staged worktree has uncommitted changes")
        for parent in (fork, upstream):
            if ctx.git("merge-base", "--is-ancestor", parent, result, check=False).returncode:
                raise DevError("Staged commit does not contain both fork and pinned upstream")
        if previous_result and ctx.git("merge-base", "--is-ancestor", require_sha(previous_result), result, check=False).returncode:
            raise DevError("Reviewed fixes must retain the staged merge's history")
        before = ctx.snapshot()
        if before["source_sha"] != fork or before["branch"] != manifest["source_snapshot"]["branch"]:
            raise DevError("Main branch moved since staging; restage on its current HEAD")
        if not before["branch"] or before["status"]:
            raise DevError("Accept requires the existing named branch with all work committed; no stash/reset is performed")
        output = {"action": "accept-upstream", "source_sha": fork, "result_sha": result,
                  "branch": before["branch"], "apply": args.apply, "manifest": str(path)}
        if args.apply:
            ctx.git("merge", "--ff-only", result)
            if ctx.sha() != result:
                raise DevError("Main read-back differs after fast-forward")
            manifest["state"] = "accepted"
            manifest["result_sha"] = result
            manifest["reviewed_result"] = args.reviewed_result
            manifest["accepted_at"] = utc_now()
            atomic_json(path, manifest)
        return output


def sync_upstream(ctx: Context, args: Any) -> Dict[str, Any]:
    if args.accept:
        return accept_upstream(ctx, args)
    if args.apply:
        raise DevError("--apply is only valid with --accept MANIFEST")
    ref = validate_ref(args.ref)
    with ctx.lock():
        before = ctx.snapshot()
        # Source is fixed explicitly; changing a repository remote cannot redirect this operation.
        remote = "https://github.com/zen-browser/desktop.git"
        directory, worktree, manifest = _new_experiment(ctx, "upstream-" + ref.replace("/", "-"), before)
        path = directory / "manifest.json"
        tracking = "refs/zen-local/upstream/" + manifest["id"]
        manifest.update({"kind": "upstream", "upstream_url": remote, "upstream_ref": ref,
                         "main_preserved": True, "state": "preview"})
        atomic_json(path, manifest)
        try:
            ctx.git("fetch", "--no-tags", "--no-write-fetch-head", remote, "refs/heads/%s:%s" % (ref, tracking))
            upstream = require_sha(ctx.git("rev-parse", tracking).stdout.strip())
            manifest["upstream_sha"] = upstream
            manifest["summary"] = ctx.git("log", "--oneline", "--max-count=100", before["source_sha"] + ".." + upstream).stdout
            manifest["diff_stat"] = ctx.git("diff", "--stat", before["source_sha"], upstream, "--").stdout
            if args.stage:
                _create_worktree(ctx, worktree, before["source_sha"])
                merged = ctx.git(*LOCAL_IDENTITY, "merge", "--no-ff", "--no-edit", upstream, cwd=worktree, check=False)
                if merged.returncode:
                    manifest["state"] = "conflicted"
                    manifest["error"] = merged.stderr[-3000:]
                    _save_result(ctx, path, manifest, before)
                    raise DevError("Upstream merge conflicts retained in %s; main checkout was preserved" % worktree)
                manifest["state"] = "staged"
                manifest["result_sha"] = ctx.sha(worktree)
            else:
                manifest["worktree"] = None
            return _save_result(ctx, path, manifest, before)
        except BaseException as error:
            if manifest["state"] != "conflicted":
                manifest["state"] = "failed"
                manifest["error"] = str(error)[-3000:]
                atomic_json(path, manifest)
            raise
