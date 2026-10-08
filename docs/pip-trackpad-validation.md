# macOS PiP trackpad candidate validation

Recorded 9 October 2026. The updated candidate is running in **Zen Playground** after a normal restart. It lowers the corner-fling threshold, adds a 16-pixel inset, restores the cursor at the translated release point and implements mouse release inertia. Daily Zen has not been replaced. Physical trackpad acceptance and ordinary AppKit mouse-drag verification remain open.

## Exact candidate

| Property | Value |
|---|---|
| Browser source | `93786813fe0c41bc54c77d437f1c36f2ab54837f` |
| Tuning / pointer implementation | `aa667d33ce3c0d63d503291befb780fd9f14f1c3`; native atom ownership correction `93786813fe0c41bc54c77d437f1c36f2ab54837f` |
| Previous outside-release / pinch candidate | `0edecd132a426d59d50fd69c14cc08277ed03548` |
| Host | macOS 26.6.2, build 25G83, ARM64 |
| Build SDK / compiler | Managed MacOSX26.5.sdk / Clang 22.1.8; minimum macOS 11.0 |
| Managed tools | Node 22.23.3, Python 3.11.15, Rust 1.95.0 |
| Base package tree SHA-256 | `072f80412fc41c78db758974b4f95be0bfa9181251004332fd559fc5c41384a0` |
| Base executable SHA-256 | `a7006588d483fa502755c2b3918a6d93b88760582577077c3528f9eb3a6a224e` |
| Playground tree SHA-256 | `294c09942d9c8e1f79719d04707b9f15a78ad24308c8826410f614f2680b19a5` |
| Playground executable SHA-256 | `43dce806fda5eb0a1be03ba87902a9292b70b69a12382a3b545b13ca64be184a` |
| Installed test application | `/Applications/Zen Playground.app`, bundle `io.ozio.zen.playground`, red icon |
| Test profile | `.zen-local/profiles/playground`; originally empty, reused without reset or personal data import |
| Native transport | `127.0.0.1:2828`, restricted to the identified Playground by the launcher/bridge guard |
| Runtime PIDs | 37808 for gesture/cursor/control checks; 41361 after verified normal quit/restart |

The build receipt reports clean committed source, `ui_only: false` and a successful full `mach build -j2`. Fresh bootstrap/import and exact patch comparisons verify all four changed Cocoa/player targets and four unchanged targets from the preceding candidate. Both packaged motion modules are independent files whose bytes equal canonical source. The guarded native incremental mode used a matching successful baseline, an explicit 8 GiB reserve and a 128 MiB compilation cache. It still performed native dependency analysis and compilation. After fresh import, only byte-identical inputs regained their previous timestamps; changed Cocoa code was compiled and the new source stamp was retained.

The first build of the tuning commit failed on two atom arguments to Gecko element APIs. The correction retains each atom in a `RefPtr<nsAtom>`; the corrected native object and full build passed. The failed build log is retained separately and is not counted as a successful build.

The base and Playground packages use the authorized development certificate `982127333DD1FF0DA856B0137CED1AF27B52E1A8`. Complete `codesign --verify --deep --strict` checks passed on both sealed packages and the installed application after startup and restart. The standalone Applications copy preserves extended attributes and contains no external build symlinks. These local packages are not notarized.

Documentation-only commits can advance `dev` beyond the tested source. Launch this retained package explicitly:

```sh
python3.11 tools/local/dev.py run playground --sha 93786813fe0c41bc54c77d437f1c36f2ab54837f
```

## Packaged gestures and controls

The native router retains the claimed PiP through outside release/cancel. Pinch selects the window under the pointer without making it key; fractional sizes accumulate and submit one atomic rectangle per frame. Claimed native test samples use the production Cocoa owner router. Unclaimed native scroll synthesis preserves the original Cocoa/APZ fallback. These paths remain from the previous candidate and were rechecked on the current package. See [implementation and tuning](pip-trackpad.md).

| Check | Result and measured scope |
|---|---|
| Policy/adapter regressions | **Passed:** 37 tests, including the lower threshold, inset compression, native mouse position sampling without a second writer, rest/click release, input ownership, fullscreen and non-Mac guards |
| Development control regressions | **Passed:** 84 tests, including the narrow dynamic PiP preference exception and refusal of static/Rust/unknown/duplicate preference definitions |
| New default tuning | **Passed:** live packaged preferences are 650 CSS pixels/second, 12 pixels of travel, 180 ms snap and 16 pixels of inset |
| Inset and lower-threshold replay | **Passed:** all four corners stop 16 pixels inside the current available area; the separate 20×12-pixel native-sample fling reaches the expected inset corner |
| Existing motion | **Passed:** 11 replay scenarios cover gentle pan, cardinal coast, four corners, Began without MayBegin, final delta, converted pinch, subpixel accumulation, momentum filtering, retouch and cancel |
| Outside release | **Passed:** five nonzero samples and exactly one End reach the same owner after the pointer leaves the moved video; release includes the final delta and completes the fling |
| Unfocused native pinch | **Passed:** sender is another window of the same Playground process; PiP stays unfocused and the browser key window remains unchanged; 640×360 grows to 832×468 |
| Native burst/shrink/rest/cancel | **Passed:** 24 fractional pinch samples produce one synchronous-burst geometry submission; native shrink reaches 448×252; outside cancellation/rest does not start a fling |
| Portrait and containment | **Passed:** unfocused native pinch grows a 360×640 player to 609×1083 at this display's height limit; recorded motion rectangles remain inside available area `(0, 34, 1728, 1083)` |
| Ordinary input | **Passed:** actual volume-slider and line-wheel targets leave geometry unchanged; with PiP closed, three native pixel samples scroll the owned tall fixture by 360 CSS pixels through Cocoa/APZ |
| Controls | **Passed:** trusted Play/Pause and Close; fullscreen input guard and prior-size restoration; preference disable/restoration; a trusted button click interrupts coast |
| Original mouse release | **Passed for the trusted DOM path:** ordinary release retains position; Command-modified release uses the existing corner rule with the new inset |
| Ordinary native mouse inertia | **Implemented; not proven by runtime input:** Computer Use attempts did not produce Cocoa MouseStart/Move/End. One attempt delivered trusted DOM down/up events, but that does not establish ordinary AppKit dragging or post-release inertia. Physical verification remains required |

The portable tests ran at the tuning commit; their JS, test and control inputs are unchanged by the later native atom correction. Native replay uses Gecko test APIs and trusted chrome events. It does not reproduce physical trackpad input or the complete OS momentum stream. There are six feedback replay scenarios, 11 existing motion scenarios and a separate new tuning replay, with portrait/control/ordinary-input checks.

## Cursor evidence and limitations

After the first accepted nonzero pan, the native hide API reports success. End applies the last window delta, then relocates the cursor by the actual native window-origin change and balances the hide. In the measured release, the player moved by `(+48, +24)` CSS points and the cursor moved from `(1120, 580)` to `(1168, 604)`. Following inertia does not keep moving the pointer.

Native cancellation, disabling the feature, Computer Use Escape and closing the player during an active hidden-cursor gesture all cleared ownership/hide state. A read-only CoreGraphics position probe measured release coordinates independently. The supplemental `CGCursorIsVisible` diagnostic changed true → false → true in the foreground test, but Apple marks that getter deprecated/no longer supported; it is not treated as physical visual acceptance. Production does not use it.

Marionette's recommended `focusmanager.testmode=true` allows background focus and suppresses normal widget focus adjustments. The cursor probe temporarily disabled it to obtain a real foreground Playground; its prior value was restored. This test-profile adjustment did not affect main Zen. CoreGraphics hiding can depend on foreground status, so cursor visibility during a physical pan above another active app remains unverified.

Inactive-application pinch was investigated through public NSEvent routing and current gesture phases. This amendment does **not** fix missing physical magnify delivery while another app is active. Modern phase-bearing magnify is retained; legacy BeginGesture, private multitouch hooks and forced activation were not added. The user explicitly permits leaving this lower-priority behavior unresolved.

Primary API references: [cursor hiding](https://developer.apple.com/documentation/coregraphics/cgdisplayhidecursor%28_%3A%29), [cursor relocation](https://developer.apple.com/documentation/coregraphics/cgwarpmousecursorposition%28_%3A%29), [deprecated visibility diagnostic](https://developer.apple.com/documentation/coregraphics/cgcursorisvisible%28%29), [global NSEvent monitor](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents%28matching%3Ahandler%3A%29), [modern event phases](https://developer.apple.com/documentation/appkit/nsevent/phase-swift.property), [legacy BeginGesture](https://developer.apple.com/documentation/appkit/nsresponder/begingesture%28with%3A%29).

## Compatibility and daily preservation

| Check | Result |
|---|---|
| Profile provenance | **Passed:** same originally fresh managed profile; Sync signed out; no personal profile data imported |
| Native UI MCP | **Passed on both launches:** seven tools, guarded inspection, actual Space switch/return and viewport capture on the exact source/PID |
| FoxPilot | **Passed on both launches:** synthetic page action/readback; ordinary broker has only main driver `8322c72f-d31d-40b3-9bf3-b544a62f5e4d`, Playground only `298899a6-eb42-4ff3-85be-c46dc155e309`; Playground's complete port list remains `[8091]` |
| Extensions | **Passed:** all five independently sourced signed XPIs retain active status/version after restart: uBlock 1.75.0, Keepa 5.66, Return YouTube Dislike 4.0.6, Enpass 6.11.18.2, FoxPilot 1.0.22 |
| Enpass | **Passed for native transport on both launches:** fresh background-lifetime logs show actual desktop `greetings` and `app_locked_status_result`, without an untrusted-browser response. Previously accepted pairing/unlock/autofill were not repeated; Keepa CAPTCHA was not revisited |
| Cookie/storage | **Passed:** the existing synthetic persistent cookie and counter `41` survive normal quit/restart at the same origin on port 8776. Root navigation never reseeds them |
| Tabs and Spaces | **Passed with launcher qualification:** order, membership, pinned/essential/container state and two Spaces match prior hashes. The launcher selects a new home tab on each run; the known prior fixture selection was explicitly restored before comparison. The two expected added home tabs were counted, and owned temporary tabs closed |
| Normal shutdown | **Passed:** only verified Playground PID37808 was quit; exit was confirmed before relaunch as PID41361 |
| Updater/diagnostics | **Passed on both launches:** packaged `MOZ_UPDATER=false`; no own-source PiP module console errors; error/warning oracle has positive and negative controls |
| Daily Zen | **Passed:** main PID61722 still runs the same application; executable/tree digests and complete signature match the before snapshot; the personal profile was not accessed |

The main executable remains `4cd01b153aa0caec9c28f7b5ac26df83d3d1442142382e7973cceee333bfb9d5`; its application tree remains `9209b88de7f82e429e6cdfb396558b58d2f994064d0e34a1d4908620ba348f49`.

Machine-local evidence is under `.zen-local/pip-tuning/`: build/import/export/test logs, per-launch source/package identity, gesture/control/cursor observations, MCP captures, sanitized Enpass status, FoxPilot readbacks, cookie/extension/restart logs, session hashes and daily/signature preservation. No profiles, private URLs, vault records or raw native-app logs are committed.

## Manual acceptance and retained packages

The user found the preceding candidate generally usable but requested easier flings, an edge gap, cursor relocation and mouse inertia. Earlier automatic checks and that partial acceptance do not establish acceptance of this amendment. The preceding `0edecd13` package and receipts remain retained.

The updated animated landscape PiP is left open for a physical check: make a modest diagonal throw, pan then release outside the original video, confirm the cursor hides and returns at the translated release point, and fling using an ordinary mouse drag. Check a paused release, pinch smoothness and controls too. Inactive-app pinch is optional. Multiple physical monitors, actual background cursor behavior, Linux and Windows runtime have not been tested.

Keep Future Improvements item 2 open until the remaining physical checks pass. Daily Zen remains on its previous package. To recreate the fixture later, serve `tools/compatibility/probe_server.py --port 8776`, open `http://127.0.0.1:8776/pip` in the verified Playground, click Play and open PiP.
