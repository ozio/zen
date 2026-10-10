# Built-in MCP: macOS validation and daily installation

Validated and installed on 9 October 2026. Future Improvements **9 is complete on macOS ARM64**. The implementation and connection instructions are in [mcp.md](mcp.md). Jev remains the separate future task 11; no Jev runner or API extension was included.

## Current standalone candidate, 10 October 2026

Installed source: `f58d2508b35519c37bbd2a2283a53bdba5c32777`, built and retained in `/Users/oz/Projects/Zen`. Zen/Firefox and the MCP feature implementation are unchanged from the previous candidate; this fixes distribution packaging and rejects developer bundles during artifact verification.

| Property | Verified value |
|---|---|
| Main binary SHA-256 | `ccba6e9a1da84bf27d5e7899155d8207844b7231dc0793c39512dccb6102f74d` |
| Main package tree SHA-256 | `e657b8f09de84a70b07a5160c608e85c850d716e304281f00a64d447e4ee1c24` |
| Playground tree SHA-256 | `7821268a8003b28de0275ac8ffcaec3b32246d00b3d048b57035cdb438db0035` |
| Build | Fresh locked import, full eight-job build; `ui_only=false`, `native_incremental=false` |
| Signing / host | Same Developer ID identity, deep/strict signatures after launch; macOS ARM64, Clang 22.1.8, SDK 26.5 |
| Tests | 86 local-control, 45 native-bridge and 102 MCP tests passed |
| Immediate backup | `2026-10-10T07-21-00.342879_00-00-33417ff6` in the primary checkout |

Both signed packages contain the actual staged GRE `omni.ja`, valid archives and no developer repo/object plist keys. The entire original engine/source/object directory was temporarily renamed out of its compiled location during Playground startup, graceful restarts, integration checks, main installation and normal main launch. It was restored afterward. The temporary empty `zen-mcp` directory workaround was removed before main launch.

The same originally empty Playground profile retained 20 semantic test tabs, their order/pinning/Space/group/container relationships, two Spaces, a persistent HTTP cookie and localStorage counter 4242. Five signed extensions remained active. Real native UI Space/tab actions, built-in MCP snapshot/action/read-back and retained access after restart passed. Dedicated FoxPilot used only 8091, ordinary main used only 8089, and Enpass returned a fresh native greeting without an untrusted-browser result. Vault unlock/autofill and Keepa CAPTCHA were not repeated.

Guarded preview/apply and rollback preview passed. The measured interval from the successful stopped-state check to normal-launch request was 37.831 seconds; the earlier stopped-state refusal while a child process drained and window rendering are excluded. Main opened the original registered profile without privileged debug flags while the engine was still unavailable. All 1475 tabs and 11 extension versions/active states survived. One three-tab folder shifted on restoration; its position was compared with the sealed pre-install SessionStore and returned to that saved position through the native browser move operation. Final hashes match the complete original tab order and pinning/Space/group/container relations. HTTP/HTTPS still target `/Applications/Zen.app`; installed inventory and deep/strict signature match the immutable package.

Current evidence is under `.zen-local/packaging-repair/`, `.zen-local/compatibility/f58d2508b35519c37bbd2a2283a53bdba5c32777.json`, `.zen-local/main-install.json` and `.zen-local/main-post-install.json` in the primary checkout. The previous Playground app is preserved there separately; the test profile was not reset.

Run the retained Playground from this repository after closing only the current Playground:

```sh
python3.11 tools/local/dev.py run playground --sha f58d2508b35519c37bbd2a2283a53bdba5c32777
```

Rollback preview, with main normally stopped:

```sh
python3.11 tools/local/dev.py rollback --backup 2026-10-10T07-21-00.342879_00-00-33417ff6
```

The backup restores the preceding `a9a0da17` developer app. That app requires its old developer directories; inspect the recovery record before using it. Preview may require explicit profile-snapshot restoration once newer profile data exists. Follow DEVELOPMENT.md and preserve current data.

## Previous candidate, 9 October 2026

| Property | Verified value |
|---|---|
| Source SHA | `a9a0da176b9ad3377cb281ce138d7cc5e0efe297` |
| Browser / engine | Zen `1.23.1b` / Firefox `157.0.1` |
| Host | macOS `26.6.2`, ARM64 |
| Compiler / SDK / deployment target | Bootstrapped Clang `22.1.8` / `MacOSX26.5.sdk` / `11.0` |
| Repository tools | Node `22.23.3`, Python `3.11.15`, Rust `1.95.0` |
| Preparation | Fresh locked-dependency import, full build with 8 jobs, standalone packaging; full-build receipt has `ui_only=false`, `native_incremental=false` |
| Signing | `Developer ID Application: Nikolay Soloviov (XF4FP36XSB)`, identity `9FAAACAA8503C3009F05CA0C12585CF6DBFFCD82`; secure timestamp; complete deep/strict verification before and after launch |
| Notarization | Not performed, as explicitly requested by the user |
| Main executable SHA-256 | `bbade3b69d6f09467b80d845eaf810000a3be49640be8b130a31aa5373dc205e` |
| Main package tree SHA-256 | `5b5b65e733ac68cdbe212f3300d22c303ff396baed2bd7d9d1f5767c8f44268b` |
| Playground package tree SHA-256 | `635d0ae84dfa77a8b548415f786dfbd779d662557bae082706634e019a4b2e91` |
| Package / evidence root | `/Users/oz/.codex/worktrees/zen-mcp/Zen` |
| Installed apps | `/Applications/Zen.app`, `/Applications/Zen Playground.app` |

Correction, 2026-10-10: these packages were sealed and had no external symlinks, but were **not standalone distributions**. The packager copied the materialized developer app instead of the staged `mach package` output. The daily app lacked the GRE `omni.ja` and retained developer repo/object paths in `Info.plist`; after the candidate worktree was removed, startup crashed with `MOZ_CRASH(Failed to get path to repo dir)`. Recreating empty directories temporarily restored startup without changing the app or profile. Earlier signature/inventory and MCP workflow results retain their stated scope, but the standalone acceptance was invalid. The packaging regression fix requires the staged distribution, GRE archive, no developer paths, and startup with development paths unavailable.

## Agent setup and skills on the current candidate

The current candidate adds Codex/Claude Code setup, CLI copy buttons, local skill installation and `codex://skills` dispatch. The compiled MCP default remains **off**. Enabling the checkbox persists for that profile and starts the server with Zen; clearing it stops the server and leaves it off after restart. Installing a connection or skill does not enable MCP.

The following checks used the exact current signed Playground, retaining the same profile originally created empty. Test destinations for client configuration and skills were redirected into a private validation directory; production file I/O, the bundled skill and the actual installed client parsers were used. Personal global agent configuration was not changed by verification.

| Area | Actual result on `a9a0da17` |
|---|---|
| Settings installation | Actual controls installed separate Codex and Claude Code HTTP connections and skills, copied the CLI commands, and wiped credential fields on dismissal. All eight onboarding checks passed. |
| Ownership and access | Reconfiguration revoked only the previous Codex token; Claude configuration/token stayed valid. An edited skill was refused and preserved. Configurations/skills were `0600`; profile metadata and audit contained no tokens. Automated tests additionally covered foreign/malformed configuration, duplicate TOML, rollback and concurrent setup. |
| Actual clients | Claude Code CLI reported Connected. The native CLI bundled with Codex read the generated configuration; Codex app-server discovered all 49 live tools and the installed skill. All four client checks passed without invoking a model turn. |
| Deep link | Registered macOS handler and dispatch from the actual Zen settings button passed. The documented `codex://skills` opens the skills list; arbitrary skill installation uses Zen's local installer. Codex GUI content was not inspected because Computer Use refused that application. |
| Protocol | All four MCP revisions, resources, subscriptions, header/auth/error handling, UTF-8 and disconnect passed in 11 live checks. |
| Same-profile restart | After clearing the actual checkbox and a graceful restart, the preference remained false and port 3924 had no listener. Re-enabling through settings restored the saved grants. Identity changed and the old ID was rejected. All 94 original tabs retained order/relations; 96 tabs after restart include two startup pages. Spaces, cookies, localStorage, IndexedDB and five extensions persisted. |
| Existing integration | FoxPilot's fresh synthetic snapshot/click passed after restart with separate 8089/8091 routes. The fresh Enpass extension received a real native `greetings` response with trusted browser and authentication required; unlock/autofill were not repeated. Strict post-launch signature, sealed inventories, profile isolation and update protection passed. |

Canonical regression checks passed: **214 tests, including 102 MCP tests**, zero failures or skips. Gecko ESLint and the bundled skill validator passed. Fresh locked import, a full eight-job build and standalone packaging passed before the tests above.

Browser/page/data/DevTools providers, actors and protocol code did not change in this addition. The compatibility receipt explicitly carries forward the original Inspector, 1500-tab stress and full provider coverage from `6b750d91`, retained below. Those extensive checks are earlier evidence and are not reported as rerun on `a9a0da17`.

## Current daily installation and normal launch

[MAIN_UPDATE.md](../MAIN_UPDATE.md) was followed with the exact standalone package and qualified compatibility proof. The first attempt refused an old crash-reporting process from a previous launch. That specific reporter was quit normally; no app or profile guard was bypassed. The successful preview/apply/rollback-preview/normal-launch phase took **40.543 seconds**: preview 5.976 s, apply 29.898 s, rollback preview 4.573 s, launch request 0.056 s. This interval excludes the refused attempt, window rendering and session flush.

The sealed backup contains the preceding `6b750d91` app, the registered personal profile and registries. Rollback preview passed before normal startup. The installed main inventory and deep/strict signature match the exact package after launch. Its live process opened the same personal profile with ordinary flags and no privileged remote debugging.

The session read-back preserved **1533 of 1533** saved tabs, their relative order, pinning, Space/group relations, and window/Space/folder/group metadata. All **11** extensions retained versions and enabled state. HTTP/HTTPS default handlers and the independent FoxPilot routes stayed intact; the Playground package did not change during promotion.

The existing enabled MCP preference and previously issued Codex grant survived the update. Seven live main checks passed: exact source/PID/instance and 49 tools, paginated tabs, independent main/Playground grants, owned page navigation/snapshot/trusted click/page JS, system JS, explicit-target console/network/resource subscriptions, cleanup preserving prior tab IDs/order, and private hash-only registry/audit. A separate owned settings tab verified all five agent/skill buttons, empty one-time CLI fields, the compiled default `false` and preserved enabled preference. Only owned verification tabs were closed and the prior selection restored. Main verification did not install anything into personal global agent configuration.

## Original packaged MCP acceptance (`6b750d91`)

The original standalone candidate `6b750d914638c8aa1146848b96ca7f92f8b04522` passed the checks in this section. The retained Playground profile was created empty for the task. No personal profile files, cookies, session, account state or extension storage were copied into it. These results remain bound to that original SHA; current-candidate checks are listed above.

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

## Original integration checks (`6b750d91`)

- The native Playground stdio bridge verified exact app/profile/PID/source identity, inspected chrome and captured a viewport before and after restart. Settings and browser controls were exercised in the actual UI.
- FoxPilot `1.0.22` was configured through its supported options UI with the complete Playground port list `[8091]`; Automation Mode was enabled through its normal permission UI. The daily connection remained exclusively on `[8089]`. Before and after restart, FoxPilot took a fresh snapshot, clicked the owned fixture's Increment button, and the built-in MCP independently observed counter `1`. Only the owned tab was closed.
- Five fresh, signed marketplace extensions were active before and after restart: uBlock Origin `1.75.0`, Keepa `5.66`, Return YouTube Dislike `4.0.6`, Enpass `6.11.18.2`, FoxPilot `1.0.22`. XPI SHA-256 values and provenance are in the private inventory. uBlock enable/disable was exercised. Keepa and Return YouTube Dislike web-service flows were not repeated; the previously cancelled Keepa CAPTCHA was left alone.
- The fresh Enpass extension received an actual parsed `greetings` response from the real native application before and after restart. `browser_not_trusted=false`; `authentication_required=true`. Transport and trusted-browser exchange passed. Vault unlock/autofill were not repeated and are not claimed by this validation.
- The visible **Tabs and browsing → Startup → Open previous windows and tabs** checkbox was toggled off and on; independently observed `browser.startup.page` values were `3 → 1 → 3`. No session files were edited to make restoration pass.
- Compiled `MOZ_UPDATER=false` and `app.update.auto=false` were verified. The Playground remained separate from the personal profile and browser account.

## Original daily installation and normal launch (`6b750d91`)

This section records the initial MCP installation, before the current agent-setup addition.

[MAIN_UPDATE.md](../MAIN_UPDATE.md) was followed. The exact package and compatibility receipt were prepared while main remained open. Its registered personal profile and per-install default were identified from the live process and registry; the different global default in `profiles.ini` was not changed.

Only the identified daily app was quit gracefully. `install-main` preview/apply created a sealed backup of the previous `ef5cc342a96bcbfba9d98618971039e34f283db7` app, personal profile and registries, verified their complete inventories/signature, and installed the candidate. Guarded rollback preview passed before normal `open -a /Applications/Zen.app`. The measured interval from verified main exit to the normal-launch request was **38.208 seconds**: preview 5.361 s, apply 29.377 s, rollback preview 3.403 s, normal-launch request 0.066 s. Window rendering and session-file flush time are outside that interval.

After launch the live process opened the same personal profile with ordinary flags, without Marionette or privileged remote debugging. The full package inventory and deep/strict signature passed. The first session read-back preserved **1527 of 1527** saved tabs, their relative order, pinning, Space/group/Essential relations and window/Space/folder/group metadata. All **11** extensions retained versions and enabled state. The later read-back contained 1528 tabs and still preserved every original tab and relation; the additional tab was retained. HTTP/HTTPS default handlers remained the daily Zen, and FoxPilot main/Playground routes remained separate.

The actual daily settings UI enabled MCP at `http://127.0.0.1:3923/mcp` and created the named **Codex** grant. The JSON configuration was copied to a private `0600` local file and the clipboard restored; the one-time token fields were cleared and only the owned settings tab closed. No global Codex configuration was edited.

The installed main server then passed seven live checks: exact build/PID/instance and 49 tools, 16-page tab listing, mutual rejection of main/Playground bearer grants, owned page navigation/snapshot/trusted click/page JS, full system JS, explicit-target console/network and resource subscriptions, owned-target cleanup with all prior tab IDs/order preserved, and hash-only credentials/payload-free audit. The prior selected tab was restored. During these probes ChatGPT's crash stopped the fixture server; it was restarted before a new owned-target test. A failed navigation was inspected and its owned tab closed, without replaying the action.

The final delivery check later found the main process stopped; its cause was not inferred, and no matching crash report was found. A normal launch restored the enabled server and the same previously issued bearer grant without recreating access. The instance/PID changed, and all seven main MCP checks, personal-session preservation, extension state, FoxPilot routing and post-launch signature passed again. Initial and restarted receipts are retained separately.

## Historical candidate paths and evidence

The former `zen-mcp` worktree was removed. Its package, rollback and evidence paths below are historical records, not current recovery commands. Use the primary-checkout candidate and backup documented above. The previously recorded launch was:

```sh
python3.11 tools/local/dev.py \
  --root /Users/oz/.codex/worktrees/zen-mcp/Zen \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains \
  run playground --sha a9a0da176b9ad3377cb281ce138d7cc5e0efe297
```

Historically recorded previous-version backup: **`2026-10-09T08-43-03.909823_00-00-44c991e3`**, restoring `6b750d91`, under the candidate root's `.zen-local/backups/`. Inspect rollback with main gracefully stopped:

```sh
python3.11 tools/local/dev.py \
  --root /Users/oz/.codex/worktrees/zen-mcp/Zen \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains \
  rollback --backup 2026-10-09T08-43-03.909823_00-00-44c991e3
```

Apply only the reviewed preview with `--apply`. Since the live profile has evolved, the guard may require `--restore-profile-snapshot`; follow [the rollback procedure](../DEVELOPMENT.md#rollback) and review the effect on newly created profile data before restoring that snapshot. The wrapper preserves current app/profile/registries in another backup. The old worktree backups are no longer available at these paths. The primary-checkout original-release backup is separate.

Historical machine-local evidence was recorded under the now removed `/Users/oz/.codex/worktrees/zen-mcp/Zen/.zen-local/`:

- `builds/a9a0da176b9ad3377cb281ce138d7cc5e0efe297/build.json`, matching `artifacts/` and `playground-artifacts/` manifests and fresh import/build/package logs;
- `compatibility/a9a0da176b9ad3377cb281ce138d7cc5e0efe297.json`, binding current phase-file hashes to both sealed packages and naming the carried-forward original scope;
- `mcp-onboarding/`: native setup, both clients, deep-link dispatch, disabled restart persistence, package/profile, and `validation/` protocol/FoxPilot/Enpass receipts;
- `mcp-onboarding-main/`: guarded installation, rollback preview, timings, application/signature, redacted session comparison, `mcp-runtime.json` and `settings.json`; connection files and profile backups remain private;
- original `6b750d91` build/manifests/compatibility and `mcp-validation/` settings, Inspector, full API/concurrency/stress/persistence/integration receipts; original `mcp-main/` installation/runtime receipts;
- primary checkout: `.zen-local/mcp-onboarding-regression-final.tap`, `.zen-local/mcp-onboarding-eslint-final.txt` and preparation logs; original regression/ESLint evidence remains retained separately.

## Practical limits

Linux and Windows were not built or exercised natively. Apple notarization was intentionally omitted. Arbitrary system JS has the approved full privileges; its timeout cannot stop synchronous code. Mutations currently share an instance queue. System contexts persist for a client/window, up to 32 windows, and expire after 30 idle seconds without requests/streams; hold a subscription for long-running work.

A trusted click opening a synchronous prompt can reach the 15-second wait limit while the dialog is already open. The actual dialog was inspected and accepted without clicking again. Window restoration uses SessionStore and applies to session-synced windows. Page DevTools evaluation on `about:preferences` returned `evaluation_failed`; handle-based settings actions succeeded, ordinary HTTP page evaluation passed, and privileged browser operations use the system JS context. Captured network bodies remain subject to Gecko availability/size limits. SPA DOM revisions and Jev's proposed runner/queues are future work, not claims of this release.
