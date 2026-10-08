# Working on the personal Zen fork

This repository maintains the user's daily Zen browser after their move from Arc. The fork is [`ozio/zen`](https://github.com/ozio/zen); its upstream is [`zen-browser/desktop`](https://github.com/zen-browser/desktop). The normal branch is `dev`. Preserve the fork's existing history and local customizations.

Read [DEVELOPMENT.md](DEVELOPMENT.md) for setup, platform recipes, playground validation and installation. Follow [MAIN_UPDATE.md](MAIN_UPDATE.md) when asked to update the daily browser. Read [UPSTREAM.md](UPSTREAM.md) before updating Zen or Firefox, [PR_WORKFLOW.md](PR_WORKFLOW.md) for incoming external PRs, and [UPSTREAM_PR.md](UPSTREAM_PR.md) when preparing our own contribution to Zen.

The completed macOS setup, exact installed candidate, local evidence and original-release rollback are recorded in [docs/macos-validation.md](docs/macos-validation.md). Use its explicit `--sha` to launch that retained package if documentation-only commits have advanced HEAD.

## Workflow and authorization

- Default to the current branch, normally `dev`, and commit and push there when authorized. Do not introduce feature branches or a mandatory PR workflow. Temporary detached worktrees are appropriate for candidate builds and external PR tests.
- Merge upstream into the fork. Do not rebase published fork history, force-push, replace the fork with a new clone or automatically discard a custom change because a related upstream PR merged.
- Capture `git status --short`, current HEAD, branch and remotes before editing. Preserve unrelated dirty work. Do not run broad `git restore`, `git reset --hard`, `git clean`, unrequested stashing or a conflict resolution that accepts an entire side without reviewing it.
- Continue work already authorized by the user. Build, review, fix and validate a concrete candidate before any needed final deployment decision. Do not repeatedly ask for consent for reversible preparation or an already authorized transition.
- A request to test an external PR authorizes staging and playground testing. It does not alone authorize changing the daily application or the personal profile. Read any wider authorization in the conversation before asking again.
- Keep the main `/Applications/Zen.app` and its personal profile intact until the candidate's compatibility gates pass. When replacement is authorized, prepare backups and a standalone package, install through the guarded command, and prove recovery or roll back.

## Fast daily updates and upstream publication

- A request to update main Zen authorizes promoting the requested validated candidate and its routine graceful restart. Prepare the exact standalone package, compatibility proof, registered profile, rollback and post-launch checks before closing main. Once the user says it is closed, verify exit and proceed without another approval round.
- Reuse an intact matching package and current evidence. Documentation-only HEAD changes do not force a browser rebuild: select its explicit packaged SHA. New code/configuration or stale integration evidence requires preparing and validating the new candidate first. Keep all installation, signature, profile-backup and rollback guards; optimize repeated preparation and idle time, not those guards.
- Use the preview/apply commands in MAIN_UPDATE.md, reopen main promptly, and complete the short normal-launch read-back. Do not invent diagnostic scripts or repeat accepted plugin onboarding while the user waits with a closed browser. Record timings by phase and finish longer reports after the browser is usable.
- For our upstream PRs, prepare a local title/body draft and concrete tests first. The user must personally edit the publication text. Do not create even a draft PR, discussion or comment until the user has supplied/edited and approved the exact title/body and explicitly authorized that publication. Use the approved text verbatim; any later wording change needs renewed agreement. Bind approval to the reviewed code head and upstream base too.
- Disclose agent-generated code honestly. The verified Cursor rejection and the unresolved eligibility of our implementation are described in UPSTREAM_PR.md. User editing of PR prose does not change code provenance. Do not publish to probe acceptance or conceal generation. Publication permission is not permission to merge upstream or to send unapproved follow-up messages.

## Source and generated files

| Path | Role |
|---|---|
| `src/zen/` | Canonical Zen feature implementation; current Spaces code is in `src/zen/spaces/` |
| `src/browser/`, `src/toolkit/` and other `src/` paths | Added Firefox files and patches to the Firefox tree |
| `prefs/` | Canonical YAML preference definitions, compiled by `tools/ffprefs/` |
| `configs/`, `surfer.json` | Branding, native target/build options and pinned Firefox version |
| `src/external-patches/` | Declared third party and Firefox patches |
| `engine/` | Downloaded/generated Firefox tree, ignored by Git |
| `node_modules/`, `.surfer/`, build object directories and `dist/` | Generated dependencies, cache and output |
| `tools/local/` | Portable development/update/PR/install control |
| `tools/playground/` | Local native browser UI MCP and validation helpers |
| `.zen-local/` | Ignored machine-local profiles, state, candidates, receipts, logs and backups |

Edit canonical source. An exploratory edit under `engine/` must be exported into the intended tracked patch and reviewed before import or rebuild; an engine-only fix will disappear. Inspect the exact export diff so it does not include unrelated generated changes. Changes to C++, Rust, IDL, build configuration or the Firefox version require a full build. Use a UI rebuild only after a successful matching full build and only for compatible UI changes.

Existing overlay files are symlinked on macOS/Linux, but Windows normally copies them. Changes to patches or preference YAML, added/deleted source files, and Windows overlay edits need a fresh import before compilation. On an already prepared engine, use `bootstrap --skip-system-bootstrap` for the complete locked-dependency/import/en-US preparation. Export any intentional engine-only work first. Surfer's build warning checks only patch count, so it cannot prove changed patch contents were imported.

Use `rg` or `rg --files` for discovery. Read the relevant test and implementation paths rather than applying instructions from an old upstream document to nonexistent feature paths.

## Supported control entrypoint

Run commands from the repository root with the pinned Python interpreter. `python` in the examples means that interpreter; `python3.11` is suitable when the shell has not selected it.

```sh
python tools/local/dev.py --help
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

| Task | Command |
|---|---|
| Inspect toolchain and local state | `python tools/local/dev.py doctor --json` |
| Install locked dependencies, import and bootstrap the selected engine | `python tools/local/dev.py bootstrap` |
| Full build / UI rebuild | `python tools/local/dev.py build --jobs 8` / `python tools/local/dev.py build --ui` |
| Produce a standalone candidate package | `python tools/local/dev.py package` |
| Launch the explicit isolated profile | `python tools/local/dev.py run playground` |
| Preview / perform playground reset | `python tools/local/dev.py reset-playground` / `python tools/local/dev.py reset-playground --apply` |
| Inspect / stage a pinned external PR | `python tools/local/dev.py stage-pr URL`, then the reviewed command in [PR_WORKFLOW.md](PR_WORKFLOW.md) |
| Stage / accept an upstream update | `python tools/local/dev.py sync-upstream --stage`, then the reviewed command in [UPSTREAM.md](UPSTREAM.md) |
| Preview / apply main installation | `python tools/local/dev.py install-main`, then use the exact profile and proof arguments in [DEVELOPMENT.md](DEVELOPMENT.md) |
| Preview / apply rollback | `python tools/local/dev.py rollback`, then `rollback --backup ID --apply`; use `--restore-profile-snapshot` when the inspected receipt requires restoring changed profile data |

Inspect subcommand `--help` before using flags not listed here. Do not use the upstream `npm start` as the playground launcher: it does not express this fork's explicit profile and instance identity contract.

Global `--root PATH` and `--toolchains PATH` precede the subcommand. A detached candidate can share the primary checkout's managed `.zen-local/toolchains` while keeping its own profiles, state, cache and artifacts. Use the candidate root explicitly and never borrow the primary playground state.

## Toolchains and resources

The local development target uses Node 22, Python 3.11 and Rust 1.95.0 through repository pins. Prepare the [managed tool layout](DEVELOPMENT.md#managed-toolchain-layout); selecting PATH Node alone is insufficient for the wrapper. Toolchain symlinks are allowed as shared inputs; profile/artifact symlinks are not. Do not change global Node, Python or Rust defaults, replace system executables or rewrite shell startup files. Respect the engine's bootstrapped compiler, SDK and compatibility requirements; report a pin conflict rather than silently using a different compiler.

macOS ARM64 is the first native target. Linux and Windows recipes are preparation for real runs on those systems. A macOS build or a cross-compiled artifact does not prove Linux/Windows behavior. Record OS, architecture, SDK/compiler, commit and configuration for each claim.

Use a bounded compilation cache and explicit job count. Inspect free disk space before a full build and packaging: engine source, objects, candidates and rollback backups coexist. Remove only disposable generated data that belongs to this task. Preserve the current profile, active builds, tested package and rollback materials.

## Playground isolation

- The only standard test profile is `.zen-local/profiles/playground`. Start it empty. Install extensions separately from official sources or the extension author's supplied artifact; record source, version and digest when available.
- Never seed it from the personal profile. This prohibition includes cookies, history, session files, login databases, account state, Firefox Sync data, extension storage, extension profile directories and profile registry files. Do not sign in to the user's browser account to make a compatibility test pass.
- Reuse that same test profile for persistence tests. Resetting it between shutdown and restart invalidates cookie, extension and session persistence evidence.
- `.zen-local/state.json` is the launcher/bridge identity contract. Verify the live binary, profile, PID, source SHA and loopback Marionette port before native operations. A file on disk or an open port alone is insufficient identity proof.
- Use an explicit profile and no-remoting launch. A duplicate-process check must distinguish main Zen from the playground; never use a blanket `pkill zen`, quit all browsers or target a window based only on its title.
- On macOS the default launch derives a separately signed red-icon variant (`io.ozio.zen.playground`, no URL/document/activity handlers) and stages it at `/Applications/Zen Playground.app`, with matching base/variant/deployment receipts. An unowned or modified app at that path is refused. `--in-artifact` skips this copy; native integrations such as Enpass may require the Applications location. Choose an authorized signing identity before packaging and check actual integration behavior.
- Preserve macOS application extended attributes with the wrapper's `ditto` copy. The packager removes consumed `.purgecaches` markers before signing. Verify the installed app's complete signature after launch as well as before it; matching file hashes alone do not prove a usable signature.
- Marionette must listen locally and privileged chrome control must be restricted to the identified playground. Keep that automation capability out of the daily launch. Refuse a stale/mismatched state record instead of attaching to another browser.
- Reset only the verified, stopped playground through `reset-playground`. Keep its receipts, synthetic fixtures and reset scope inspectable.

An already installed native application such as Enpass may serve the fresh extension through its normal local connection. That is not permission to copy a vault, credentials or extension storage into the test profile. Determine the actual integration path: Enpass can use a direct local browser-to-app protocol rather than a WebExtensions native-messaging manifest.

## Browser and native UI tools

For an ordinary request to open, inspect or interact with a website, use the user's running Zen through the FoxPilot MCP by default. Honor an explicitly chosen browser or tool. When FoxPilot tools are unavailable, use the Codex internal browser first, then Chrome if necessary, and briefly name the fallback. Missing FoxPilot does not justify switching to native desktop automation.

Get a fresh snapshot before every interaction and resolve element IDs from that snapshot. After navigation or an error, read the actual state before retrying: the action may already have succeeded. Prefer viewport screenshots; full-page stitching has duplicated sections in FoxPilot. Preserve unrelated tabs, sessions and Spaces, and close temporary verification tabs when finished.

For Zen chrome, Spaces, sidebar, settings and extension prompts, use the dedicated [playground bridge](tools/playground/) when testing this fork. Its stdio entrypoint is `python tools/playground/server.py serve --repo /absolute/path/to/zen`; [DEVELOPMENT.md](DEVELOPMENT.md#native-ui-mcp-and-foxpilot) lists tools and live checks. Handles expire after 30 seconds and one action, so inspect again before acting. Privileged Marionette must never attach to the personal instance. Native Computer Use in Zen is appropriate when the user specifically requests a native UI task; inspect the actual app state and preserve unrelated work.

Ordinary FoxPilot uses only main Zen on port 8089. The dedicated `foxpilot-playground` connection uses only Playground on 8091; keep the extensions' complete port lists `[8089]` and `[8091]`, never both. After resetting or reinstalling FoxPilot, configure Playground's port through its supported options UI before webpage automation and verify both broker rosters. See [the routing audit](docs/foxpilot-routing-audit.md).

For FoxPilot compatibility validation, install and connect it in the playground, prove which instance is receiving commands, then navigate a synthetic test page, inspect it, perform an action and verify the result. Availability of the MCP in the daily browser does not prove connectivity to the playground.

## Acceptance and honest evidence

Use the [compatibility procedure](DEVELOPMENT.md#compatibility-gates) for every promotable candidate. It covers source/build identity, fresh-profile provenance, native UI MCP, FoxPilot, installed extensions, Enpass native-app exchange, persistent cookies, tabs, Spaces and session restore, update protection, and standalone package launch.

Enpass passes only with a response through the fresh extension from the real native application using its actual integration protocol. An installed extension, a manifest, a host process or a connected socket is insufficient. State separately whether transport, desktop pairing/unlock and an autofill workflow were actually tested.

Keep machine-local evidence under `.zen-local/`. Do not commit profiles, private browsing URLs, cookies, passwords, account identifiers, vault data, build credentials or logs containing them. Redact diagnostic output at collection time. Share summaries with synthetic data and hashes instead.

A successful build, a mock/unit test, green upstream CI or a screenshot proves only its stated scope. A release claim needs actual packaged-binary, profile and user integration evidence. Record required checks as passed, failed or not run, and name the exact artifact/commit/platform. Never turn a pending check into a passed check because the implementation appears correct.

When reporting work, lead with the result, explain what changed and why, include the relevant checks and remaining limitations, and link the concrete files or receipts. Keep rollback instructions usable before replacing the main app.
