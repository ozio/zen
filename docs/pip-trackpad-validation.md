# macOS PiP trackpad candidate validation

Recorded 8 October 2026. The candidate is running in **Zen Playground**, with its red icon and explicit test profile. It has not replaced daily Zen. The implementation covers the requested motion policy; physical trackpad acceptance remains pending.

## Exact candidate

| Property | Value |
|---|---|
| Browser source | `6a4b03ff26dc825730d778962e896c4d82a74903` |
| Implementation history | `712279073d741f2c08a06ff2cf5f0bf6de8b935f`, then `6a4b03ff26dc825730d778962e896c4d82a74903` |
| Host | macOS 26.6.2, build 25G83, ARM64 |
| Build SDK / compiler | Managed MacOSX26.5.sdk / Clang 22.1.8; minimum macOS 11.0 |
| Managed tools | Node 22.23.3, Python 3.11.15, Rust 1.95.0 |
| Base package tree SHA-256 | `34be25c4143801b4ba0c03b01fa64bf7fba34a7977365bf4e84abf34c66758ed` |
| Base executable SHA-256 | `72d4d57e18d13d41b77794a511f8020904211ff91811fcce3070564a765b8726` |
| Playground tree SHA-256 | `138a8163b90c7616aff7afd76f90014f1f72fc89bcbe639f2ef152350a5f461a` |
| Playground executable SHA-256 | `52a9959b031237ae7035f17c66c39bf72cf15e33864061b9a84cb8c01374396b` |
| Installed test application | `/Applications/Zen Playground.app`, bundle `io.ozio.zen.playground` |
| Test profile | `.zen-local/profiles/playground`; originally created empty, reused for persistence |
| Native transport | `127.0.0.1:2828`, restricted by the launcher/bridge identity guard |
| Runtime PIDs | 10061 for gesture replay, 15065 after normal quit/restart |

The build receipt reports `ui_only: false`, a clean committed source and a successful full `mach build`. The native/IDL patches were imported in the initial implementation. Their seven engine target files were rechecked byte-for-byte at the final candidate; both motion modules resolve to the canonical source overlays. The final full build used eight jobs and an explicit 4 GiB reserve, allowed only after the wrapper verified the successful matching native baseline. It did not skip native compilation. Only disposable project compiler-cache entries were pruned; profiles, artifacts and rollback backups were preserved.

Both the base and red Playground variant use the previously authorized development certificate `982127333DD1FF0DA856B0137CED1AF27B52E1A8`. Complete `codesign --verify --deep --strict` checks passed before deployment and after startup/restart. These local packages are not notarized. The standalone staged app runs outside the engine/object tree.

Documentation commits can advance `dev` beyond the tested browser source. Launch this retained package explicitly:

```sh
python3.11 tools/local/dev.py run playground --sha 6a4b03ff26dc825730d778962e896c4d82a74903
```

## Gesture and control results

The loopback `/pip` fixture generates its own animated canvas video. Native finger replay enters the real Cocoa `scrollWheel` handler, APZ and the parent player document. The video runs in a remote browser underneath the normal parent controls overlay, which receives the tested wheel input. The replay keeps the original screen point fixed while the window moves. Available bounds on this Mac were `(0, 31, 2560, 1409)` in CSS screen coordinates.

| Check | Result and scope |
|---|---|
| Policy and adapter regressions | **Passed:** 26 tests, including negative monitor origins, velocity reversal/rest, fractional pan/pinch, coalesced resize, stale callbacks, fullscreen, cleanup and non-Mac activation guards |
| Development control regressions | **Passed:** 73 tests, including conservative eligibility checks for a reduced incremental-build reserve |
| Live movement and release | **Passed:** gentle pan, cardinal coast and all four strong corner flings; Began without MayBegin and Ended with a final nonzero delta |
| Bounded animation | **Passed:** sampled real native window rectangles stay in the captured available area; weak/cardinal gestures do not force a corner |
| Converted pinch | **Passed:** trusted Gecko Control+pixel wheel grows and shrinks the actual window while preserving its aspect; received CSS deltas predict its final size |
| Rapid tiny pinch samples | **Passed:** 24 synchronous subpixel signals accumulate rather than being lost to integer/asynchronous native resize |
| Portrait height clamp | **Passed:** 360×640 video grows to 793×1409, stopping at available height with its ratio preserved |
| Momentum filtering | **Passed for the Gecko path:** a trusted momentum-marked WidgetWheelEvent exposes `mozIsMomentum` and is consumed without adding the OS tail twice |
| Retouch, cancellation and preference disable | **Passed:** zero-delta native start interrupts coast; Cancel and disabled preference stop/reject motion |
| Input guards | **Passed:** actual line-wheel input and pixel-wheel input over the actual volume slider leave window geometry unchanged |
| Pointer interruption | **Passed:** a real trusted pointer click on Play/Pause stops active coast |
| Existing controls | **Passed:** native Play/Pause, Close and fullscreen entry/exit; fullscreen rejects movement and restores the prior size |
| Original mouse release behavior | **Passed for the trusted DOM path:** ordinary release keeps the fixture-positioned window in place, Command-modified release uses the original corner logic. This does not replay physical AppKit dragging |

The main gesture replay contains 11 scenarios. Additional control, shrink, disable, line-wheel, slider and portrait checks have separate receipts. The momentum replay uses Gecko's test flag, not a real OS momentum tail. An experimental PID-directed CGEvent post did not establish delivery and is not a passed test. macOS's inherited `sendNativeTouchpadPinch` is unimplemented and aborts; it was not called.

**Not run:** physical trackpad pinch / Cocoa `magnifyWithEvent`, physical dragging, subjective inertia tuning, multiple physical monitors or display reconfiguration, Linux and Windows runtime. Control-wheel replay proves the downstream converted input path. It does not prove native magnify delivery. The implementation remains Mac-only until other native adapters and real host checks exist.

## Playground compatibility and daily preservation

| Check | Result |
|---|---|
| Profile provenance | **Passed:** same managed test profile as the original fresh setup; Sync signed out; no personal data imported |
| Native UI MCP | **Passed before and after restart:** real stdio server exposes seven tools; guarded chrome inspection, actual Space switch/return and viewport capture succeed on the identified candidate |
| FoxPilot | **Passed before and after restart:** loopback navigation, fresh snapshot, form-button action and actual result readback. Ordinary broker sees only main driver `8322c72f-d31d-40b3-9bf3-b544a62f5e4d`; Playground broker sees only `298899a6-eb42-4ff3-85be-c46dc155e309` |
| Extensions | **Passed:** all five separately sourced signed extension packages stay active with the same versions after restart |
| Enpass | **Passed for real native transport:** fresh extension receives `greetings` and `app_locked_status_result` from desktop 6.12.7; no untrusted-browser response. Pairing, unlock and autofill were accepted previously and were not repeated here |
| Cookie/storage | **Passed:** explicit persistent synthetic HTTP cookie and counter `41` survive normal quit/restart at the same loopback origin; restored root never reseeds the cookie |
| Tabs and Spaces | **Passed:** hashes match for the restored tab order, membership, pinned/essential/container state, prior selection and two Spaces. Test navigation's selection is restored before comparison. The wrapper's expected additional home tab is counted separately |
| Normal shutdown | **Passed:** guarded quit targets only Playground and its PID is confirmed exited before relaunch |
| Update protection | **Passed:** `AppConstants.MOZ_UPDATER` is false on the live packaged candidate before and after restart |
| Daily Zen | **Unchanged:** same running PID 61722 and complete application tree SHA-256 `9209b88de7f82e429e6cdfb396558b58d2f994064d0e34a1d4908620ba348f49`; personal profile was not accessed |

Extension versions: uBlock Origin 1.75.0, Keepa 5.66, Return YouTube Dislike 4.0.6, Enpass 6.11.18.2 and FoxPilot 1.0.22. Functional extension acceptance from the initial setup remains as recorded there; this candidate refreshes active/persistent installation, FoxPilot operation and real Enpass transport. The user's completed Keepa/extension checks were not reopened.

The existing `[8089]` main and `[8091]` Playground routing configuration was reused without reset/reinstall. The original [routing audit](foxpilot-routing-audit.md) remains applicable; current broker rosters and Playground page actions were checked again. Privileged automation never attached to the daily process.

Machine-local evidence is under `.zen-local/pip-gestures/`, with final candidate receipts under its `6a4b03ff26dc825730d778962e896c4d82a74903/` subdirectory. Build/package/deployment manifests remain under `.zen-local/builds/`, `artifacts/`, `playground-artifacts/` and `deployments/`. Native module diagnostics report no own-source console errors. Session URLs/labels are hashed inside the browser at collection; native Enpass logs are reduced to whitelisted command names/booleans. Private profile data and raw logs are not committed.

Temporary replay/cookie/diagnostic tabs were closed. The synthetic PiP fixture is deliberately left open for the user's physical trackpad check. To reproduce that check later, serve `tools/compatibility/probe_server.py --port 8776`, open `http://127.0.0.1:8776/pip` in the identified Playground, select its tab, click Play and open PiP. Check a light nudge, a strong diagonal fling, stationary fingers, a new touch during coast, pinch in both directions and fullscreen. Record the actual hardware result before marking Future Improvements item 2 complete or installing this candidate as daily Zen.
