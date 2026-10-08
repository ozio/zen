# Reviewing and testing an external PR

When the user supplies a Zen upstream PR URL, inspect the proposal and test its changes on top of the user's own fork. The normal working branch remains `dev`. A detached temporary worktree provides a candidate without replacing the fork with the author's branch or touching daily Zen.

This workflow authorizes preparation when the user asks to try a PR. Applying it to the daily browser requires the user's request or authorization already present in the conversation, plus the [compatibility and installation gates](DEVELOPMENT.md#compatibility-gates). Do not ask again for actions already authorized. Follow [AGENTS.md](AGENTS.md) for unrelated dirty work, profile isolation and browser tools.

## 1. Pin the reviewed state

Capture local branch, dirty status, fork HEAD and remotes. Then inspect the PR through the command:

```sh
python tools/local/dev.py stage-pr "https://github.com/zen-browser/desktop/pull/NUMBER"
```

Keep the machine-local receipt directory `.zen-local/experiments/pr-N-HEAD10-ID/`, containing `manifest.json`, `metadata.json` and `changes.diff`. Metadata includes the PR, ordered commits, issue comments, reviews, review comments, fully paginated GraphQL review threads and head checks/status. Read the complete diff and discussion, including resolved threads and available CI. Do not infer an approval from the summary or only from unresolved comments. Inspect truncated/large files from Git; a partial API diff is not the full review.

If GitHub CLI is available, these read-only commands supplement the manifest:

```sh
gh pr view NUMBER --repo zen-browser/desktop \
  --json url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,commits,files,reviews,comments,statusCheckRollup
gh pr diff NUMBER --repo zen-browser/desktop
gh pr checks NUMBER --repo zen-browser/desktop
```

`gh pr view --json comments` does not replace review-thread retrieval. Use the manifest's full thread data or paginate GraphQL `reviewThreads`, then paginate each thread's comments. Inspect relevant check/job logs; record cancelled, skipped, pending, missing and failed checks explicitly. Do not execute a proposed PR's scripts merely to obtain metadata.

Record these immutable values before staging:

- Repository and PR URL/number, retrieval time and state.
- Full reviewed head SHA and base SHA, base branch and original commit range.
- Current fork base SHA and any dirty-state exclusions.
- Diff completeness, comment/thread coverage, review and CI status tied to the reviewed head.

If the author's head or base changes after review, refresh the diff/discussion/checks and review the changed context/range. `--reviewed-head` acknowledges the head SHA; also compare the applied receipt's base SHA and complete diff with the originally reviewed snapshot before building. Never apply a moving branch while reporting an older reviewed state.

## 2. Make an independent judgment

Explain the user-visible problem, triggering case, proposed behavior and affected code paths. Read enough surrounding implementation and existing tests to assess it on this fork. Treat reviewer comments as evidence to investigate; do not blindly obey them, dismiss them because CI is green or accept the author response without checking the code.

For each material concern, record the claim, concrete affected code/behavior, whether it is supported, the chosen action and the evidence needed to close it. Include concerns you discover independently. Preserve disagreement with a reason. Resolved GitHub threads may still describe a relevant defect in the pinned head or in local integration.

Inspect changes to browser privileges, extension/native messaging, profile/session migration, concurrency/error handling, Firefox patches, preferences, updater behavior, platform code and build workflows. Evaluate observable behavior rather than a plausible code shape. Choose targeted checks and regressions appropriate to the risk; avoid tests that merely restate the implementation.

Propose fixes locally as separate commits. This user request does not authorize posting a GitHub review/comment, messaging the author, merging their PR or changing their branch. Complete the concrete review and candidate within the authorized local scope.

## 3. Stage on top of the fork

After the exact head has been reviewed:

```sh
python tools/local/dev.py stage-pr "https://github.com/zen-browser/desktop/pull/NUMBER" \
  --reviewed-head FULL_REVIEWED_HEAD_SHA --apply
```

The candidate must begin at the user's own recorded fork HEAD. The PR's pinned changes are applied above that base in `.zen-local/worktrees/ID`, a detached worktree reported in the manifest. The receipt maps original commits to resulting local commit SHAs. Do not use `git checkout` of the author's head as the final test candidate: it can omit the user's local customizations. Do not fetch an automatic GitHub merge ref and assume it tests integration with the fork.

For a deliberate subset, repeat `--commit FULL_COMMIT_SHA` for each selected original commit in order. Record why omitted commits are unnecessary and review the resulting complete diff. Verify the requested SHAs belong to the pinned PR range; do not silently take a different commit that happens to have the same title. A partial application must not be reported as testing the entire PR.

The command applies linear commits and refuses selected merge commits rather than guessing a mainline. For a PR containing merges, inspect its graph and choose a reviewed linear range that preserves the intended result, or perform an explicitly reviewed integration in the detached worktree with full provenance. Do not drop behavior merely to bypass the refusal.

If applying conflicts, inspect both implementations and preserve required fork semantics. Record the resolution and its effect. Never choose `ours`/`theirs` globally or remove personal changes to make the test compile. Keep unrelated dirty work out of the candidate and identify any dependencies a meaningful test still needs.

Verify candidate ancestry and diff before building:

```sh
git rev-parse HEAD
git status --short
git log -8 --oneline
git diff --check
```

Run these in the candidate worktree. Inspect the complete diff from the recorded fork base to candidate HEAD, and confirm the original head/base provenance is preserved. If a fix adds a new commit, update the tested candidate identity; the old artifact does not cover the new commit.

## Provenance and local fixes

The inspection/staging manifest is the machine-local `externalPR` record. Keep it under ignored `.zen-local/` and retain a nonsensitive provenance summary in intentional commit messages or a tracked change note when the change is kept permanently. A durable record should survive cleanup of temporary worktrees.

Record at least:

| Field | Purpose |
|---|---|
| `externalPR` URL and repository/number | Original proposal |
| Original full head/base SHAs | Exact reviewed upstream range |
| Fork base SHA | Personal customizations included in the candidate |
| Applied original commits/range and resulting commits | Reproducible local integration |
| Local fix commit SHAs and rationale | Review concerns or independent defects fixed locally |
| Review/comment/thread and CI snapshot | State of discussion/checks when the decision was made |
| Tested final candidate SHA, configuration, host and package digest | Identity of the actual tested output |
| Validation receipts and unrun checks | Scope of evidence |
| Promotion/retention status | Playground only, retained in fork or installed |
| Later upstream implementation SHA and reconciliation | Whether local behavior remains required |

Preserve upstream author attribution. Prefer original commit provenance such as `git cherry-pick -x` when suitable; retain PR/head/base identity even if integration requires an aggregate patch. Local fixes belong in distinct commits after the external change, with a concrete reason and validation. Do not rewrite the author's change to conceal your adjustments.

For retained commits, include useful trailers such as `External-PR: URL`, `External-PR-Head: FULL_SHA`, `External-PR-Base: FULL_SHA` and, for a repair, `External-PR-Fix: URL`. These are provenance, not proof that review or tests passed. Do not put personal profile paths, secrets or private URLs in the commit message.

## 4. Build and test a clean candidate

From the candidate worktree root:

```sh
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

Use a full build for the initial candidate and any native/engine/configuration change. The [global root/toolchains recipe](DEVELOPMENT.md#detached-candidates-and-shared-managed-tools) can share already prepared managed tools without borrowing the primary profile or state. A UI rebuild is only appropriate after a matching successful full build for a compatible UI-only fix. Inspect and run relevant existing tests, then reproduce the reported trigger in the real candidate browser. Compare before/after behavior against a known-good fork package when practical, using separate clean test state.

The first playground profile must be empty. Never copy cookies, personal account state, profile preferences, session files, Enpass/FoxPilot storage or an extension profile directory. Install extensions separately. Reuse the same test profile when verifying persistence after graceful shutdown and relaunch.

Run the [compatibility gates](DEVELOPMENT.md#compatibility-gates) against the final packaged candidate. Include actual native UI MCP and FoxPilot actions in the identified playground, a valid Enpass response through its actual local native-app protocol, non-session cookie persistence, extension persistence, tabs/Spaces membership and session restoration. Preserve synthetic fixtures and redacted receipts. A unit test or successful `surfer build` cannot cover those integrations.

When CI failed, determine whether the failure reproduces locally or is unrelated infrastructure, and preserve the distinction. When CI was skipped or absent, it provides no positive evidence. Native macOS testing proves that host only; Linux and Windows remain not run until real platform checks exist.

## 5. Report before daily promotion

Give the user a concrete result:

- What the PR changes and whether the motivating case is reproduced/fixed.
- Exact PR head/base, fork base and final tested candidate SHA.
- Each material review concern, your independent judgment and any separate local fix.
- Checks actually run, their results, platform/configuration and package identity; failures and not-run checks stay visible.
- Whether the candidate is playground-only, retained in the fork or installed as daily Zen.
- The package/manifest/receipt references needed to repeat or promote it, plus the known-good rollback reference.

Do not claim the PR is safe solely because it compiled, the author resolved threads or upstream CI is green. If an action requires user input, name the exact remaining operation and why; leave independent review/fixes/builds complete first.

When daily promotion is requested or already authorized, use [the main-install procedure](DEVELOPMENT.md#package-and-promote-to-daily-zen). Match the final candidate and compatibility receipt, back up the old app and stopped profile, test the standalone package and keep rollback executable. Do not promote a different head or omit the local fix commit that was tested.

Keeping a tested change on `dev` uses the current-branch workflow, with reviewed intentional commits and a normal push when authorized. If the current named branch is clean and still exactly matches the recorded fork base, inspect the candidate's ancestry and full diff, then retain the tested commits with a fast-forward:

```sh
git merge --ff-only FULL_TESTED_CANDIDATE_SHA
git push origin dev
```

These commands run in the primary checkout and apply only within the user's repository-promotion/push authorization. The final SHA must include the reviewed external change and all tested local fixes. If the base moved or the target tree is dirty, restage/reconcile and retest the actual final result. Do not override the check or move the branch onto a stale candidate. No feature branch or mandatory PR is required, and repository retention does not itself replace daily Zen.

## 6. Follow the PR upstream

At each periodic update, compare retained external changes with the actual merged upstream implementation as described in [UPSTREAM.md](UPSTREAM.md#external-pr-provenance-and-later-upstream-merges). An upstream merge may include different fixes, omit a local repair or interact differently with the personal fork. Remove local duplication only after semantic comparison and relevant tests; retain independently necessary fixes with their provenance.

Clean up a temporary worktree only after preserving its manifests, intentional commits, tested package and any useful failure evidence. Stop its identified playground first and inspect `git worktree list` and its dirty state. Use Git's worktree removal for the exact temporary worktree; never recursively delete the primary checkout or the main profile.
