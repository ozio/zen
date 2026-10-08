# macOS PiP trackpad candidate validation

Recorded 8 October 2026. The updated candidate is running in **Zen Playground** after a normal restart. It addresses the user's outside-release, unfocused-pinch and jerky-resize feedback. Daily Zen has not been replaced. Physical trackpad acceptance remains open.

## Exact candidate

| Property | Value |
|---|---|
| Browser source | `0edecd132a426d59d50fd69c14cc08277ed03548` |
| Feedback implementation | `20b1c12487a49bad3ab060d3202b9ef876083928`; build-baseline correction `93e3d2c3e46975731c467281f50f31676dd73d99`; native replay fallback correction `0edecd132a426d59d50fd69c14cc08277ed03548` |
| Host | macOS 26.6.2, build 25G83, ARM64 |
| Build SDK / compiler | Managed MacOSX26.5.sdk / Clang 22.1.8; minimum macOS 11.0 |
| Managed tools | Node 22.23.3, Python 3.11.15, Rust 1.95.0 |
| Base package tree SHA-256 | `9073eb0d1ba8a8d78495022e26e1504c3c6879694906fff689a9cadb235b62ab` |
| Base executable SHA-256 | `a78c69a863da0eef15a47dcbed4d1f6fb7f7d6f92e2eba7daa971abb4d3f8ec8` |
| Playground tree SHA-256 | `8466334740a4da6709633d87d4bf0de408e179ca1acd68cbf1f06a7de7a4a001` |
| Playground executable SHA-256 | `3c5476a6ef30e1d93ec133bc2fa176d8fc1fda2fb76a4bab3c248579f872fb2a` |
| Installed test application | `/Applications/Zen Playground.app`, bundle `io.ozio.zen.playground`, red icon |
| Test profile | `.zen-local/profiles/playground`; originally empty, reused without reset or personal data import |
| Native transport | `127.0.0.1:2828`, restricted to the identified Playground by the launcher/bridge guard |
| Runtime PIDs | 81409 for gesture/control checks; 84544 after verified normal quit/restart |

The build receipt reports a clean committed source, `ui_only: false` and a successful full `mach build -j2`. Fresh bootstrap/import and byte comparisons verify all eight affected Cocoa/IDL/UI build targets. Both packaged motion modules are independent files whose bytes equal the canonical source. They do not depend on overlay symlinks. The guarded native incremental mode used the matching successful baseline, an explicit 8 GiB reserve and a 128 MiB compilation cache. It still performed native dependency analysis and compilation. Disposable project output/cache was pruned with local receipts; profiles, tested artifacts and rollback materials were retained.

The base and Playground packages use the previously authorized development certificate `982127333DD1FF0DA856B0137CED1AF27B52E1A8`. Complete `codesign --verify --deep --strict` checks passed on the sealed packages and installed application after startup and restart. The standalone Applications copy uses the wrapper's extended-attribute-preserving copy. These local packages are not notarized.

Documentation-only commits can advance `dev` beyond the tested source. Launch this retained package explicitly:

```sh
python3.11 tools/local/dev.py run playground --sha 0edecd132a426d59d50fd69c14cc08277ed03548
```

## Feedback fixes and packaged runtime

The native Cocoa router claims the initial PiP surface before AppKit hit-testing and retains that owner through release/cancel, even if the moved window leaves the pointer. Pinch uses the window under the pointer without making it key. Fractional desired sizes accumulate; the adapter submits one atomic `moveResize` rectangle per animation frame instead of separate resize and move calls. Intermediate native resize acknowledgements cannot overwrite a newer desired size. See [the implementation notes](pip-trackpad.md).

The loopback `/pip` fixture generates animated canvas video. Replay calls Gecko's native scroll/pinch test APIs and the same Cocoa ownership router used by production. Claimed samples reach the trusted, chrome-only player bridge. Declined synthetic scroll events retain the original Cocoa `scrollWheel`/APZ fallback. The synthetic NSEvent has no usable window number: a first candidate lost fallback when sent through `NSApp`; the actual volume-slider negative check exposed this, and the corrected test entry point was fully rebuilt. Production still uses the `NSApp sendEvent:` hook for actual events.

| Check | Result and measured scope |
|---|---|
| Policy/adapter regressions | **Passed:** 31 tests, including outside terminal events, trusted ownership, unfocused pinch, fractional accumulation, atomic geometry, stale acknowledgements, cleanup and non-Mac guards |
| Development control regressions | **Passed:** 80 tests, including reduced-reserve eligibility and source-stamp normalization without ignoring compiler/configuration changes |
| Outside release | **Passed:** fixed pointer leaves the moved PiP; five nonzero pan samples and exactly one End reach the same owner, including the final delta; the window then reaches the expected corner |
| Unfocused native pinch | **Passed:** sender is the main browser window; PiP remains unfocused and the key browser window is unchanged; 640×360 grows to 832×468 around the same center |
| Native subpixel burst | **Passed:** 24 native pinch samples retain their fractional contribution, reach 671×378 and produce one geometry submission for the synchronous burst |
| Native shrink | **Passed:** 640×360 shrinks to 448×252 |
| Outside cancel/rest | **Passed:** cancel stops without coast; 200 ms of rest before outside release does not cause a fling |
| Existing motion policy | **Passed:** 11 replay scenarios cover gentle pan, cardinal coast, four strong corner flings, Began without MayBegin, final nonzero delta, converted pinch, subpixel accumulation, momentum filtering, retouch and cancel |
| Bounded animation | **Passed:** recorded native rectangles remain within this monitor's `(0, 31, 2560, 1409)` available area |
| Native portrait pinch | **Passed:** an unfocused 360×640 player grows to 793×1409, retains aspect and stops at available height; sampled rectangles stay contained |
| Native input guards | **Passed:** real line-wheel samples and pixel samples over the actual volume slider fall through as ordinary wheel input and leave PiP geometry unchanged |
| Normal webpage scrolling | **Passed:** with PiP closed, three trusted pixel wheel events traverse the declined router's Cocoa/APZ fallback and scroll the owned loopback page by 360 CSS pixels |
| Buttons/fullscreen/disable | **Passed:** actual trusted Play/Pause and Close; fullscreen entry, guarded input and prior-size restoration on exit; preference disable/restoration |
| Pointer interruption | **Passed:** a trusted click on Play/Pause stops coast |
| Original mouse release | **Passed for the trusted DOM path:** ordinary release preserves position; Command-modified release keeps the original corner logic. Physical AppKit dragging was not replayed |

There are six feedback scenarios plus 11 existing motion scenarios, with separate portrait, control, input-guard and webpage receipts. Pinch synthesis uses an NSEvent test object with native accessors and the real router; it does not post OS hardware events. Momentum replay uses Gecko's trusted `mozIsMomentum` test flag; it does not reproduce an OS momentum tail.

**Not run:** physical trackpad release/pinch, subjective video smoothness and inertia tuning, magnify while another application is active, multiple physical monitors/display reconfiguration, physical AppKit mouse dragging, Linux or Windows runtime. The global monitor cannot suppress input in another application; actual background delivery and effects on the foreground app need a physical check. Automated unfocused pinch proves the case where the main Playground browser window is active. A single native rectangle per frame removes the previous two-call path but does not alone prove smooth remote-video rendering.

## Playground compatibility and daily preservation

| Check | Result |
|---|---|
| Profile provenance | **Passed:** same originally fresh managed profile; Sync signed out; no personal profile data imported |
| Native UI MCP | **Passed on both launches:** real persistent stdio server exposes seven tools; guarded chrome inspection, actual Space switch/return and viewport capture succeed on the exact source/PID |
| FoxPilot | **Passed on both launches:** owned loopback navigation, fresh snapshot, form-button action and actual result readback; ordinary broker has only main driver `8322c72f-d31d-40b3-9bf3-b544a62f5e4d`, Playground only `298899a6-eb42-4ff3-85be-c46dc155e309` |
| Extensions | **Passed:** all five independently sourced signed XPIs retain their active status and versions after restart |
| Enpass | **Passed for real native transport on both launches:** the test extension receives `greetings` and `app_locked_status_result` from the actual desktop application without an untrusted-browser response. Pairing/unlock/autofill were accepted previously and not repeated |
| Cookie/storage | **Passed:** existing persistent synthetic HTTP cookie `zen_probe=synthetic-v1` and counter `41` survive normal quit/restart at the same loopback origin; the root URL never reseeds |
| Tabs and Spaces | **Passed:** hashes match for order, membership, pinned/essential/container state, prior selection and two Spaces. The wrapper's expected new home tab is counted separately; owned temporary and diagnostic tabs were closed |
| Normal shutdown | **Passed:** only verified Playground PID81409 was quit; exit was confirmed before relaunch as PID84544 |
| Update protection | **Passed:** live packaged `AppConstants.MOZ_UPDATER` is false before and after restart |
| Runtime diagnostics | **Passed:** no own-source PiP module console errors; error/warning oracle verified with positive and negative controls |
| Daily Zen | **Unchanged:** PID61722; executable SHA-256 `4cd01b153aa0caec9c28f7b5ac26df83d3d1442142382e7973cceee333bfb9d5`; complete application tree `9209b88de7f82e429e6cdfb396558b58d2f994064d0e34a1d4908620ba348f49`; signature remains valid. Personal profile was not accessed |

Extension versions: uBlock Origin 1.75.0, Keepa 5.66, Return YouTube Dislike 4.0.6, Enpass 6.11.18.2 and FoxPilot 1.0.22. This pass refreshes persistence, FoxPilot operation and Enpass transport. The user's already accepted extension/autofill checks and abandoned Keepa CAPTCHA were not reopened. Existing complete port lists `[8089]` for main and `[8091]` for Playground were reused; see [the routing audit](foxpilot-routing-audit.md).

Current machine-local receipts are in `.zen-local/pip-gestures/0edecd132a426d59d50fd69c14cc08277ed03548/`, with build/package/deployment manifests under `.zen-local/builds/`, `artifacts/`, `playground-artifacts/` and `deployments/`. Before/after identity, native MCP, signed application, extension, sanitized Enpass, FoxPilot and session records bind the checks to the exact package and processes. Session labels/URLs are hashed at collection; Enpass diagnostics retain only whitelisted command names/booleans. Profiles, private browsing data and raw native logs are not committed.

## Hardware acceptance and prior candidate

The previous candidate `6a4b03ff26dc825730d778962e896c4d82a74903` passed converted-wheel geometry and control checks but the user found outside-release, focus and smoothness defects on their trackpad. Its signed package and receipts remain retained as historical evidence/rollback. Those earlier automatic results are not treated as acceptance of this update.

The animated landscape PiP fixture is left open in the updated Playground for a physical check. Test release when the cursor ends outside the moved video, pinch without clicking PiP first, pinch in both directions while watching the video, rest before release and a new touch during coast. Also test pinch with another app active if that background behavior is required. Record the result before checking Future Improvements item 2 or replacing daily Zen. To recreate the fixture later, serve `tools/compatibility/probe_server.py --port 8776`, open `http://127.0.0.1:8776/pip` in the identified Playground, click Play and open PiP.
