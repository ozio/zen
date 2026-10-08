# Keeping the personal fork current

The persistent fork is [`ozio/zen`](https://github.com/ozio/zen), with local `origin` pointing there and `upstream` pointing to [`zen-browser/desktop`](https://github.com/zen-browser/desktop). Work on the existing `dev` branch and preserve its history. Updates use Git merges. The initial compatibility baseline is `f6a167d80b62a50c0ef5b9eedfb3bb777e0372f4` (Zen `1.23.1b`, Firefox `157.0.1`). Record later known-good commits and packages in local receipts instead of treating this initial stamp as permanently current.

Updating the repository, updating the Firefox engine and replacing daily Zen are separate operations. Prepare a candidate, verify it in the [clean playground](DEVELOPMENT.md#compatibility-gates), and promote only within the user's authorization. Read [AGENTS.md](AGENTS.md) for profile and dirty-work protections.

## Periodic review

When asked to check for updates, fetch metadata and inspect the changes. Do not create a recurring automation or push a merge solely because a newer upstream commit exists. Create an automation only if the user requested one; its job should report actionable changes and obey these candidate/promotion gates.

From the repository root:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git remote -v
git fetch upstream dev
git log --oneline --decorate HEAD..upstream/dev
git diff --stat HEAD...upstream/dev
git log --left-right --oneline HEAD...upstream/dev
```

If `dev` or a remote differs from the established setup, investigate before changing it. A diverged fork can be normal: custom commits belong there. Do not reset it to upstream. If history is incomplete and the merge base cannot be found, fetch the missing history without discarding the current branch; a missing merge base is not permission to merge unrelated histories.

Inspect the complete relevant diff and upstream release/security notes. Pay special attention to `surfer.json`, `package-lock.json`, canonical patches, preferences, updater configuration, platform mozconfigs, extension/native messaging code and session/Spaces storage. Map affected personal customizations and premerged PRs using the provenance procedure below.

## Stage a merge candidate

```sh
python tools/local/dev.py sync-upstream --ref dev
python tools/local/dev.py sync-upstream --ref dev --stage
```

The inspection/staging receipts pin the fork base and exact fetched upstream SHA. Review them before building; the name `dev` can move, but the tested merge must not. Stage the candidate in the tool's detached temporary worktree so the daily branch and unrelated working changes remain intact. This avoids a mandatory feature branch while preserving a concrete merge history.

In that worktree, inspect the merge result, then use the same development entrypoints:

```sh
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

Use commands from the candidate worktree root so its source and local artifacts agree. The global `--root`/`--toolchains` options can share the primary checkout's managed tools while keeping all candidate runtime state separate; see [the detached candidate recipe](DEVELOPMENT.md#detached-candidates-and-shared-managed-tools). Record the fork base, upstream commit, merge commit, any additional repair commits, host/configuration and standalone package digest. A candidate built before a repair commit must be rebuilt and retested for that repair.

### Conflicts

Read the conflict in canonical source, the old fork behavior and the upstream implementation. Preserve the user's required semantics rather than choosing an entire side by default. Keep resolutions narrow and add a regression check when the concern is material. Show unresolved or behavioral conflicts clearly; never mark a candidate compatible by excluding the conflicting feature.

Do not run `git merge --abort` until confirming the attempted merge is this task's merge and its unrelated work is preserved. Do not repair an import failure by overwriting tracked patches with the generated engine. Test the final imported source.

## Accept and publish a verified update

After the candidate passes the relevant build, standalone package and [compatibility gates](DEVELOPMENT.md#compatibility-gates), and repository promotion is authorized:

```sh
python tools/local/dev.py sync-upstream --accept "$ZEN_UPSTREAM_MANIFEST"
python tools/local/dev.py sync-upstream --accept "$ZEN_UPSTREAM_MANIFEST" --apply
```

Use the exact staging manifest produced by the reviewed candidate. Inspect the dry run and verify that current HEAD still matches its recorded fork base. If conflict resolutions or additional fix commits changed the staged result, review and test that final HEAD explicitly, then pass its exact SHA:

```sh
python tools/local/dev.py sync-upstream --accept "$ZEN_UPSTREAM_MANIFEST" \
  --reviewed-result FULL_TESTED_FINAL_SHA
python tools/local/dev.py sync-upstream --accept "$ZEN_UPSTREAM_MANIFEST" \
  --reviewed-result FULL_TESTED_FINAL_SHA --apply
```

Acceptance requires a clean candidate tree and unchanged named target branch/base. The reviewed result must contain the original fork base and pinned upstream commit, plus the original staged merge when one exists. Default acceptance checks the originally recorded staged SHA; it does not silently accept later repairs. If the branch or upstream has moved, restage/review the changed range and retest what changed. Do not override stale-candidate protection or automatically apply a merge to new unrelated work.

Review final tracked changes and commit intentional repair/documentation changes on the existing `dev` branch. Push without force when authorized:

```sh
git status --short
git log -5 --oneline
git diff --check
git push origin dev
```

If another commit appeared on the remote, fetch and reconcile it explicitly. Do not force-push the tested local tip over it. A successful push is repository evidence; daily installation still uses [the guarded package/backup procedure](DEVELOPMENT.md#package-and-promote-to-daily-zen).

## Zen upstream versus Firefox engine

`sync-upstream` merges Zen's repository. The engine version comes from `surfer.json`; `engine/` is generated. Existing upstream npm scripts have different purposes:

| Operation | Canonical command / consequence |
|---|---|
| Install locked JavaScript tools | `npm ci` |
| Download the selected Firefox version | `npm run download` |
| Generate prefs, service dumps and import Zen files/patches | `npm run import` |
| Bootstrap the current engine | `npm run bootstrap` |
| Check/bump the Firefox release in source | `npm run sync` |
| Check/bump its release candidate | `npm run sync:rc` |
| Refresh l10n only | `npm run sync:l10n` |
| Raw engine updater | `npm run sync:raw` |

The local `bootstrap` wrapper is the usual path for an already selected version. It scopes the initial locale overlay to checked-in en-US files. Do not run the all-languages `scripts/download-language-packs.sh` without first replacing its global configuration and home-directory cleanup side effects with a reviewed scoped implementation.

Do not run `npm run sync`, `sync:rc` or `sync:raw` as a harmless refresh: the scripts can change version metadata and remove/recreate generated engine state. Inspect [scripts/update_ff.py](scripts/update_ff.py) first and use a candidate worktree for a deliberate engine upgrade. Match the imported patches to the new engine and run a full build.

Do not upgrade Surfer, the lockfile, Rust or Node opportunistically during a compatibility fix. A necessary toolchain upgrade is an explicit change with its own diff and evidence. Do not reuse old object output across an incompatible engine/configuration change.

Keep the official updater disabled in the local build. Reinspect the effective setting after every merge or reconfiguration. Changing a playground preference cannot establish protection for the packaged daily app.

## External PR provenance and later upstream merges

Maintain the record described in [PR_WORKFLOW.md](PR_WORKFLOW.md#provenance-and-local-fixes) for every externally sourced change retained in the fork. Its full PR head/base SHAs, applied commit/range, local repair commits and test evidence must remain traceable even if upstream later squashes or rewrites its branch.

When a PR merges upstream:

1. Pin the actual merged upstream commit and compare the merged implementation with the staged PR and local fixes. A PR number, commit message or equivalent patch ID alone is insufficient; the final code may differ.
2. Check whether upstream covers every relevant behavior and review concern. Pay particular attention to local edge-case fixes, error handling, migration behavior and platform differences.
3. Merge upstream normally. Resolve duplicate or conflicting changes semantically. Keep a local fix when it still adds required behavior; remove it only when the merged implementation really supersedes it and the relevant tests prove that.
4. Record `superseded`, `partly superseded` or `retained`, with the actual upstream SHA and reason. Do not silently delete the historical provenance or hide a surviving custom fix.
5. Rebuild and repeat the affected compatibility gates on the final merge, including Enpass native-app/session checks when their code/configuration changed.

If two changes look equivalent but differ in observable behavior, reproduce the difference in the playground before deciding. Do not discard a fix merely to make the fork diff smaller.

## Rollback and reporting

Preserve the last known-good source SHA, tested standalone package and matching main backup ID before installing an update. Prefer returning the application to that older verified version with the corresponding profile backup. Use a detached worktree to build an older source if needed; do not introduce a rollback branch or rewrite published history by default.

Report the reviewed upstream range, final fork/merge SHA, retained custom fixes, tests actually run, host/platform, package identity, installation state and rollback reference. Name any conflict or unrun platform explicitly. A merge, full compile, upstream CI run or local unit suite by itself is not evidence that the user's daily extensions, Enpass, cookies or Spaces survived.
