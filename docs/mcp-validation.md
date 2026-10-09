# Built-in MCP: macOS validation and daily installation

Validated and installed on 9 October 2026. Future Improvements **9 is complete on macOS ARM64**. The implementation and connection instructions are in [mcp.md](mcp.md). Jev remains the separate future task 11; no Jev runner or API extension was included.

## Exact installed candidate

| Property | Verified value |
|---|---|
| Source SHA | `6b750d914638c8aa1146848b96ca7f92f8b04522` |
| Browser / engine | Zen `1.23.1b` / Firefox `157.0.1` |
| Host | macOS `26.6.2`, ARM64 |
| Compiler / SDK / deployment target | Bootstrapped Clang `22.1.8` / `MacOSX26.5.sdk` / `11.0` |
| Repository tools | Node `22.23.3`, Python `3.11.15`, Rust `1.95.0` |
| Preparation | Fresh locked-dependency import, full build with 8 jobs, standalone packaging; full-build receipt has `ui_only=false`, `native_incremental=false` |
| Signing | `Developer ID Application: Nikolay Soloviov (XF4FP36XSB)`, identity `9FAAACAA8503C3009F05CA0C12585CF6DBFFCD82`; secure timestamp; complete deep/strict verification before and after launch |
| Notarization | Not performed, as explicitly requested by the user |
| Main executable SHA-256 | `ac05b65bff5ab3ea4533b3809abebb6effb6eab8b976445ca8f19995a3487e84` |
| Main package tree SHA-256 | `098ca56900908294d12bfe6e13bbc753042edd350ec5b8963777e198ba5da53a` |
| Playground package tree SHA-256 | `11309694a90d29ccfad53907d4766aa087dd46541ae5c5717868cea1626f1540` |
| Package / evidence root | `/Users/oz/.codex/worktrees/zen-mcp/Zen` |
| Installed apps | `/Applications/Zen.app`, `/Applications/Zen Playground.app` |

Both packages are sealed and standalone; no external symlinks were found. The deployed Playground inventory matched its signed variant, and the daily app inventory matched the immutable main base after normal startup. Later documentation commits advance `dev` without changing this installed source SHA.

## Packaged MCP checks

The retained Playground profile was created empty for this task. No personal profile files, cookies, session, account state or extension storage were copied into it. All final acceptance checks below used the exact candidate above; earlier exploratory builds are retained separately and do not constitute its acceptance evidence.

| Area | Actual result |
|---|---|
| Protocol | All four revisions passed: `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26`. Modern metadata/discovery/subscriptions and legacy initialization/sessions/DELETE were exercised; March batch responses passed. |
| Contract and authentication | 49 tool definitions with input/output schemas, three resources, tab resource template, resource reads/notifications, malformed calls, unknown methods/resources, UTF-8 errors, Host/Origin/auth/version/header rejection and explicit disconnect passed. |
| Settings | Actual native pane: default state, enable/disable, occupied-port error, port recovery, named grant, JSON copy, rotation invalidating the old token, token dismissal and immediate revocation passed. Clipboard was restored. |
| Independent client | MCP Inspector `2.10.1`: modern `tools/list`, `tools/call`, `resources/list` and legacy `tools/call` passed. Strict tool validation reported **0 errors, 170 warnings across 43 tools**; these warnings concern schema shapes/unions and are retained in the local diagnostic file. |
| Browser organization | Real window/tab creation, selection, movement/order, pinning, mute, discard, closure and SessionStore restoration; Spaces, containers/site associations, folders, groups and Split View operations passed. Other tabs were preserved. |
| Pages and native UI | Text/DOM snapshots, fresh native control actions, trusted pointer/keyboard/input events, select/checkbox/forms/file upload, iframe and open shadow root actions, scrolling/dialog handling, navigation/back/forward/reload and closed-target rejection passed. |
| Element lifetime | Consumed handles, navigation/document changes, another client's handle and the 30-second expiry were rejected. The expiry probe waited 30.2 seconds. |
| Images | Actual page/chrome viewport and clipped PNG screenshots were captured and visually inspected. |
| Developer tools | Real page and full system JS, async values, surviving system objects/callbacks, console/errors, network headers/request body/response body passed. DevTools connected only to requested synthetic targets. |
| Profile APIs | Synthetic bookmarks, history, a real downloaded file, cookies, local/session storage, IndexedDB, extension enable/disable, site permissions and boolean/integer/string preferences passed. |
| Media | Real synthetic video play/pause/mute and PiP open/close passed. |
| Two clients | Independent targets worked concurrently; shared mutations completed in order `0 → 1 → 2`; foreign handles were rejected. Socket EOF released collectors in **2 ms**. Revocation closed the stream, returned HTTP 401 and left zero DevTools entries. |
| 1500 lazy tabs | Created 1500 actual lazy browser tabs. Pagination returned 1583 tabs over 16 default pages, including 83 existing tabs. Synthetic tabs loaded before/after: **0/0**; fixture HTTP requests: **0/0**; DevTools entries: **0**. Only those 1500 owned tabs were removed, restoring the prior count. |
| Same-profile restart | Graceful quit and relaunch changed instance identity and rejected the old ID. All 84 original saved tabs retained their order/relations; the new session had 86 tabs including two startup pages. All 27 Spaces and active Space remained intact. HTTP-set and API-set cookies, localStorage/IndexedDB, enabled state, port and grants persisted; revoked tokens remained rejected. |
| Registry and audit | Grant registry and audit have permissions `0600`. Registry contains hashes, not plaintext tokens. Audit fields contain only time, method, opaque target IDs, result and duration; no arguments, scripts, page content or tokens. |

Canonical tests passed: **201 total, including 89 MCP tests**, with zero failures. Gecko ESLint passed for the MCP modules and settings script. These checks supplement the real packaged operations above.

## Existing integration checks

- The native Playground stdio bridge verified exact app/profile/PID/source identity, inspected chrome and captured a viewport before and after restart. Settings and browser controls were exercised in the actual UI.
- FoxPilot `1.0.22` was configured through its supported options UI with the complete Playground port list `[8091]`; Automation Mode was enabled through its normal permission UI. The daily connection remained exclusively on `[8089]`. Before and after restart, FoxPilot took a fresh snapshot, clicked the owned fixture's Increment button, and the built-in MCP independently observed counter `1`. Only the owned tab was closed.
- Five fresh, signed marketplace extensions were active before and after restart: uBlock Origin `1.75.0`, Keepa `5.66`, Return YouTube Dislike `4.0.6`, Enpass `6.11.18.2`, FoxPilot `1.0.22`. XPI SHA-256 values and provenance are in the private inventory. uBlock enable/disable was exercised. Keepa and Return YouTube Dislike web-service flows were not repeated; the previously cancelled Keepa CAPTCHA was left alone.
- The fresh Enpass extension received an actual parsed `greetings` response from the real native application before and after restart. `browser_not_trusted=false`; `authentication_required=true`. Transport and trusted-browser exchange passed. Vault unlock/autofill were not repeated and are not claimed by this validation.
- The visible **Tabs and browsing → Startup → Open previous windows and tabs** checkbox was toggled off and on; independently observed `browser.startup.page` values were `3 → 1 → 3`. No session files were edited to make restoration pass.
- Compiled `MOZ_UPDATER=false` and `app.update.auto=false` were verified. The Playground remained separate from the personal profile and browser account.

## Daily installation and normal launch

[MAIN_UPDATE.md](../MAIN_UPDATE.md) was followed. The exact package and compatibility receipt were prepared while main remained open. Its registered personal profile and per-install default were identified from the live process and registry; the different global default in `profiles.ini` was not changed.

Only the identified daily app was quit gracefully. `install-main` preview/apply created a sealed backup of the previous `ef5cc342a96bcbfba9d98618971039e34f283db7` app, personal profile and registries, verified their complete inventories/signature, and installed the candidate. Guarded rollback preview passed before normal `open -a /Applications/Zen.app`. The measured interval from verified main exit to the normal-launch request was **38.208 seconds**: preview 5.361 s, apply 29.377 s, rollback preview 3.403 s, normal-launch request 0.066 s. Window rendering and session-file flush time are outside that interval.

After launch the live process opened the same personal profile with ordinary flags, without Marionette or privileged remote debugging. The full package inventory and deep/strict signature passed. The first session read-back preserved **1527 of 1527** saved tabs, their relative order, pinning, Space/group/Essential relations and window/Space/folder/group metadata. All **11** extensions retained versions and enabled state. The later read-back contained 1528 tabs and still preserved every original tab and relation; the additional tab was retained. HTTP/HTTPS default handlers remained the daily Zen, and FoxPilot main/Playground routes remained separate.

The actual daily settings UI enabled MCP at `http://127.0.0.1:3923/mcp` and created the named **Codex** grant. The JSON configuration was copied to a private `0600` local file and the clipboard restored; the one-time token fields were cleared and only the owned settings tab closed. No global Codex configuration was edited.

The installed main server then passed seven live checks: exact build/PID/instance and 49 tools, 16-page tab listing, mutual rejection of main/Playground bearer grants, owned page navigation/snapshot/trusted click/page JS, full system JS, explicit-target console/network and resource subscriptions, owned-target cleanup with all prior tab IDs/order preserved, and hash-only credentials/payload-free audit. The prior selected tab was restored. During these probes ChatGPT's crash stopped the fixture server; it was restarted before a new owned-target test. A failed navigation was inspected and its owned tab closed, without replaying the action.

## Retained package, rollback and evidence

Run the retained candidate from its own root with the primary managed toolchains, after gracefully stopping only the current Playground:

```sh
python3.11 tools/local/dev.py \
  --root /Users/oz/.codex/worktrees/zen-mcp/Zen \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains \
  run playground --sha 6b750d914638c8aa1146848b96ca7f92f8b04522
```

Immediate previous-version backup: **`2026-10-09T06-07-01.119644_00-00-2d9e66a9`**, under the candidate root's `.zen-local/backups/`. Inspect rollback with main gracefully stopped:

```sh
python3.11 tools/local/dev.py \
  --root /Users/oz/.codex/worktrees/zen-mcp/Zen \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains \
  rollback --backup 2026-10-09T06-07-01.119644_00-00-2d9e66a9
```

Apply only the reviewed preview with `--apply`. Since the live profile has evolved, the guard may require `--restore-profile-snapshot`; follow [the rollback procedure](../DEVELOPMENT.md#rollback) and review the effect on newly created profile data before restoring that snapshot. The wrapper preserves current app/profile/registries in another backup. The earlier original-release backup remains retained in the primary checkout.

Evidence is machine-local and ignored by Git. Under `/Users/oz/.codex/worktrees/zen-mcp/Zen/.zen-local/`:

- `builds/6b750d914638c8aa1146848b96ca7f92f8b04522/build.json`, `artifacts/6b750d914638c8aa1146848b96ca7f92f8b04522/manifest.json`, corresponding `playground-artifacts/` manifest and import/build/package logs;
- `compatibility/6b750d914638c8aa1146848b96ca7f92f8b04522.json`, binding the actual phase files and their hashes to both sealed packages;
- `mcp-validation/`: settings, protocol, Inspector, page/native operations, concurrency/EOF cleanup, stress, restart persistence, extension provenance, FoxPilot, Enpass, restore UI and post-restart signature receipts;
- `mcp-main/`: installation preview/apply, pre-launch rollback preview, timings, signature/application, redacted personal-session comparison, settings onboarding and `mcp-runtime.json`; the connection file and profile backups remain private;
- primary checkout: `.zen-local/mcp-final-regression.tap` and `.zen-local/mcp-final-eslint.txt`.

## Practical limits

Linux and Windows were not built or exercised natively. Apple notarization was intentionally omitted. Arbitrary system JS has the approved full privileges; its timeout cannot stop synchronous code. Mutations currently share an instance queue. System contexts persist for a client/window, up to 32 windows, and expire after 30 idle seconds without requests/streams; hold a subscription for long-running work.

A trusted click opening a synchronous prompt can reach the 15-second wait limit while the dialog is already open. The actual dialog was inspected and accepted without clicking again. Window restoration uses SessionStore and applies to session-synced windows. Page DevTools evaluation on `about:preferences` returned `evaluation_failed`; handle-based settings actions succeeded, ordinary HTTP page evaluation passed, and privileged browser operations use the system JS context. Captured network bodies remain subject to Gecko availability/size limits. SPA DOM revisions and Jev's proposed runner/queues are future work, not claims of this release.
