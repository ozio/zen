# Automatic PiP and Tab site search

Validated on 9 October 2026 in the signed macOS Playground, then promoted to daily Zen after the user closed it. Future Improvements 10 and 7 have separate commits, in that order:

- [1419618b](https://github.com/ozio/zen/commit/1419618b2339db06b894a6e3ddeaf035ace4b0d0): temporary automatic video pop-out, with explicit ownership distinct from manual PiP.
- [18d75652](https://github.com/ozio/zen/commit/18d75652b931bc5e0d7cc850638fe8b15ed85307): site/engine selection with Tab in Command T and the browser address bar.

Daily Zen now uses `ef5cc342a96bcbfba9d98618971039e34f283db7`, which adds the Move Tab correction in [Future Improvements 4](future-improvements.md). Its installation and current rollback are recorded [below](#latest-daily-candidate-move-tab); the automatic PiP and site-search validation remains the earlier package described here.

## Tested automatic PiP and site-search package

| Property | Verified value |
|---|---|
| Source | `18d75652b931bc5e0d7cc850638fe8b15ed85307`, clean at full build and packaging |
| Browser / engine | Zen `1.23.1b` / Firefox `157.0.1` |
| Platform | macOS `26.6.2`, ARM64 |
| Compiler / SDK | Bootstrapped Clang `22.1.8`, `MacOSX26.5.sdk`, deployment target `11.0` |
| Toolchain | Node `22.23.3`, Python `3.11.15`, Rust `1.95.0` |
| Playground | `/Applications/Zen Playground.app`, bundle `io.ozio.zen.playground`, red icon |
| Profile | Existing isolated `.zen-local/profiles/playground`; originally created empty, retained for persistence checks |
| Base package tree SHA256 | `56aa23cf6aef1c1e778450c49cc28dfc4d4152574131e86648c4c32e965a6e2d` |
| Playground tree SHA256 | `f2a49bddf989f811477166f1b6f4dfd1225c7fb1b091844df32f03c7f03d52bb` |
| Signing | Apple Development; complete deep/strict signatures valid before and after restart; no notarization |

Canonical patches were reconstructed from the Firefox base and compared byte for byte with the imported engine and both sealed packages. The live binary, source stamp, PID, explicit profile and loopback Marionette endpoint were verified. During this Playground validation, the main `/Applications/Zen.app` retained its previous complete file inventory and valid signature; its personal profile was not accessed. The subsequent authorized daily installation is recorded below.

The final full build used eight jobs with the wrapper's allowed 4 GiB reserve for compatible UI changes over a matching full native baseline. It was a full build receipt, not a UI-only package.

## Behaviour checked

Automatic PiP opens when leaving a tab with an eligible playing, unmuted video and returns that video inline on selecting its tab. Paused video, muted video and muted tabs do not open it. Manual PiP survives leaving and returning; closing a manual player does not make the next automatic player permanent. Rapid tab changes leave no stranded player. These seven native scenarios ran against a local synthetic video with a real audio track and the actual Firefox player.

Command T accepts an engine name, prefix or configured shortcut followed by Tab, then displays one mode label and the engine's icon. Enter opens the configured site's search with the correctly encoded query. Escape leaves the mode while keeping Command T open. Backspace does the same only when the query is empty, both immediately after Tab and after deleting the query. A new Command T starts normally; ordinary text uses the separately selected default engine and a URL navigates directly. Native keyboard and real navigation checks used local search endpoints, including spaces, `&` and Japanese text. Temporary search engines and changes to the default were removed afterward.

The native Settings form also added a synthetic site by name, shortcut and a search URL using `%s`; its resulting submission was checked and the temporary engine removed. Configure sites under **Settings → Search → Search Shortcuts → Add**, and choose the default search engine separately. An engine without a favicon uses the search icon. The supplied Arc video informed prefix restoration on leaving an empty search mode.

All **53 focused tests** pass: existing PiP motion/native-routing policies, automatic/manual PiP guards and races, and site-search matching/keyboard policies. These tests execute canonical implementation modules with mocked platform boundaries; native UI and packaged-binary results are separate evidence.

## Restart and integrations

The same signed package was quit normally, its process exit verified, and it was relaunched with the same Playground profile. Checks passed before and after that restart:

- The synthetic persistent cookie and localStorage counter `41` survived at the retained origin. The read-only fixture root never sets the cookie, and no reseeding occurred.
- The original 16 content tabs and two Spaces retained their ordering, pinning, membership and active Space. The launcher adds a managed home tab and selects it on each run; these home tabs are excluded from the content-session comparison, and the known test selection is restored explicitly before comparing.
- All five independently installed extensions remained active: uBlock Origin `1.75.0`, Keepa `5.66`, Return YouTube Dislike `4.0.6`, Enpass `6.11.18.2` and FoxPilot `1.0.22`.
- Enpass desktop `6.12.7` sent valid native greetings through the extension in each process lifetime; a native lock-status response was also observed before restart. No vault data, unlock or autofill flow was repeated. Earlier user acceptance of the extensions is retained; the cancelled Keepa CAPTCHA was not revisited.
- The actual stdio native MCP exposed seven tools, switched to the other Space and back, and captured the viewport in both process lifetimes.
- Dedicated FoxPilot retained exactly `[8091]`; ordinary FoxPilot remained on its separate main-browser roster. A marked local page was correlated with the verified Playground, snapshotted, clicked and read back through dedicated FoxPilot before and after restart. Temporary verification tabs were closed.
- Browser Sync remained signed out; compiled updating and automatic update preferences remained disabled. Complete installed signatures and the main application's unchanged file inventory were verified after restart.

Feature and compatibility scenarios ran in Playground. Linux/Windows runtime behaviour, crash recovery and physical trackpad/mouse acceptance were not tested by this change. Future Improvements 2 remains open for its recorded physical acceptance.

## Daily installation

The guarded installer promoted the retained standalone source `18d75652b931bc5e0d7cc850638fe8b15ed85307` to `/Applications/Zen.app` on 9 October 2026, after a successful preview and confirmation that main Zen was stopped. Its complete file inventory, executable digest and deep/strict signature match the tested base package before and after startup. The main icon, bundle identity `app.zen-browser.zen` and normal URL handlers remain intact.

The installer left the existing registered personal profile and both registries byte for byte unchanged. Daily Zen was observed running normally on that profile, without Marionette or privileged debugging flags. A complete SessionStore comparison preserved all 1,504 original saved tabs, their relative order, Space/group membership and pinning, plus all seven Spaces, 54 groups and the folders. New tabs opened during the check were retained. FoxPilot's live tab enumeration exposes a subset of Zen's `allStoredTabs`; it was correlated with the current saved session rather than treated as a complete inventory. All 11 existing extensions kept their versions and enabled/disabled state. HTTP/HTTPS links still resolve to the main application, ordinary FoxPilot reconnects only on 8089, and the unchanged Playground remains separately connected on 8091.

These are focused main-installation checks. The feature scenarios and fresh native Enpass exchange were validated separately in Playground; a daily vault unlock/autofill flow was not repeated. No personal profile was copied into Playground, and no personal URLs, Space names or vault data were recorded in the diagnostic receipts.

The previous working main source `47e576d02d5542475eb4c3b092abd7e99dccf5f2`, its matching pre-update personal profile and both registries are sealed in backup `2026-10-08T22-47-31.315519_00-00-e774cdf1`. Integrity and signatures passed; an actual temporary recovery copy of the application, profile and registries matched the backup and was removed afterward. The guarded rollback preview also passed before main reopened. Rollback was not applied to the daily application. The original official-release backup is retained separately.

To return to the version before the automatic PiP and site-search installation, close main Zen normally and inspect the scope first:

```sh
python3.11 tools/local/dev.py rollback --backup 2026-10-08T22-47-31.315519_00-00-e774cdf1
```

Follow [the guarded rollback procedure](../DEVELOPMENT.md#rollback) before adding `--apply`. Once the profile has evolved, restoration requires reviewing the snapshot and using `--restore-profile-snapshot`; the command preserves current data in another backup first.

These earlier installation, recovery and normal-launch receipts are under `.zen-local/auto-pip-site-search/main-promotion/`. The current pointers are `.zen-local/main-install.json` and `.zen-local/main-post-install.json`; the latter distinguishes the complete saved session from FoxPilot's live tab subset.

## Latest daily candidate: Move Tab

On 9 October 2026, the user authorized installing the normal Zen application and its graceful close/restart. The guarded installer promoted the existing signed standalone package `ef5cc342a96bcbfba9d98618971039e34f283db7` to `/Applications/Zen.app`. Later commits changed only documentation, so the tested binary was reused. Its implementation is [a04ecbde](https://github.com/ozio/zen/commit/a04ecbdeb12b4cbf1516be44700c9486724e8726): background Move Tab preserves the current Space and selection; a move containing the active tab follows that tab to the destination.

The package passed 59 focused tests, ESLint, a clean full macOS ARM64 build and seven actual tab-context-menu scenarios in the signed Playground. Same-profile restarts preserved all 19 persistent test tabs across both Spaces, their URL/title hashes, order and pinning. Native Enpass responses, five extensions, FoxPilot, native UI MCP, persistent cookies, updater protection and post-launch signatures were checked separately in that isolated profile.

After daily startup, the installed application's complete inventory and deep/strict signature matched the standalone package. The executable SHA256 is `3f6d10b0b948bf8bba894b0c3aee6942769f06d63cde94c5653b597646c53472`; the package tree SHA256 is `146caf96ee61ab881c9bfab2a2265676377d2baf082725c95821b48b92eb46fb`. The normal bundle identity and HTTP/HTTPS handlers remained intact. The live main process opened the same registered personal profile with ordinary launch flags. Full SessionStore comparison preserved all 1,507 saved tabs, their relative order, URL/Space/group/pinned relations, Spaces, folders and groups. All 11 extensions kept their versions and enabled state. Ordinary FoxPilot reconnected on 8089, and Playground stayed separately connected on 8091. Vault unlock/autofill and the feature-menu scenarios were not repeated in the personal profile.

The first apply attempt stopped on the running-process guard. That process exited before the successful retry. The installer verified that the personal profile and registries were unchanged during replacement. The previous source `18d75652b931bc5e0d7cc850638fe8b15ed85307`, application, profile and registries are sealed in backup `2026-10-09T00-52-22.316397_00-00-6785106c`. Backup integrity and the guarded rollback preview passed before normal startup. The unchanged restore procedure retains its earlier actual recovery-copy validation; no new recovery copy or daily rollback was applied in this update.

After closing main normally, preview the current rollback with:

```sh
python3.11 tools/local/dev.py rollback --backup 2026-10-09T00-52-22.316397_00-00-6785106c
```

Follow [the rollback procedure](../DEVELOPMENT.md#rollback) before applying it. If the profile has evolved, inspect the snapshot scope and the required `--restore-profile-snapshot`; newer data is preserved in another backup.

Current installation/read-back evidence and phase timings are under `.zen-local/move-tab/main-promotion/`. Feature and compatibility evidence is under `.zen-local/move-tab/ef5cc342a96bcbfba9d98618971039e34f283db7/` and `.zen-local/compatibility/ef5cc342a96bcbfba9d98618971039e34f283db7.json`. Personal URLs, Space names, cookies and vault data were not exported into these reports. Linux/Windows native runtime and crash recovery were not tested.

## Retained evidence and launch

Machine-local evidence is under `.zen-local/auto-pip-site-search/18d75652b931bc5e0d7cc850638fe8b15ed85307/`, with build/package/launch logs and persistence/session observations in its parent. It includes feature runtime results, Settings UI screenshots, canonical/package identity, native MCP, FoxPilot routing/actions, Enpass status and extension metadata. Profiles, private URLs, extension storage, vault data and raw native logs are not committed.

After closing only the existing Playground normally, launch the retained package even if documentation commits have advanced HEAD:

```sh
python3.11 tools/local/dev.py run playground --sha 18d75652b931bc5e0d7cc850638fe8b15ed85307
```

Promotion and rollback remain governed by [DEVELOPMENT.md](../DEVELOPMENT.md). Existing main-app rollback packages, profile backups and the previous tested Playground package were preserved.
