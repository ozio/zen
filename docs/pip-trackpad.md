# PiP trackpad gestures

This fork implements the user's complete PiP gesture policy on macOS: live two-finger pan without pressing, centered pinch resize, release-velocity inertia, strong diagonal corner flings and containment within the current monitor's available work area. Ordinary mouse drag and the original Cmd+drag corner behavior remain available.

The platform-neutral `ZenPiPGestureMotion.sys.mjs` owns geometry, recent velocity, exponential coast and corner animation. `ZenPiPTrackpad.sys.mjs` binds those rules to trusted macOS pixel wheel input. Windows/Linux do not install the adapter; they require native phase adapters and real host validation before activation.

## Input and lifecycle

The normal macOS APZ pinch route produces Control+pixel wheel. Size changes use `exp(-deltaY / 100)`, preserve aspect ratio and clamp both dimensions; Control+precise scroll is intentionally accepted as the same resize shortcut. Line/page wheels, pressed mouse buttons, Shift/Option/Command wheels and sliders/settings panels retain their existing behavior.

Cocoa sends synchronous trusted chrome-only start/end/cancel events exclusively to the system-principal `Toolkit:PictureInPicture` document at the exact player URI. Start precedes its wheel delta; release follows any final nonzero finger delta. This covers touching without moving and devices that begin without MayBegin. Native pinch uses the same lifecycle. No inactivity timer can launch motion while fingers rest.

The ChromeOnly `WheelEvent.mozIsMomentum` getter exposes Gecko's existing native momentum bit. The adapter consumes the OS tail without applying it, because the portable controller already supplies inertia. A new touch, click, cancellation, manual resize, fullscreen transition, disabled preference or close cancels motion. Animation generations prevent a cancelled queued callback from moving the window.

Each gesture captures the current monitor's available bounds, including negative origins and Dock/menu exclusions. Geometry uses outer window dimensions in CSS screen coordinates. Fractional target sizes accumulate across asynchronous/coalesced AppKit resize operations; native resize notifications check the actual outer bounds without discarding newer pinch samples. A new gesture re-evaluates the current monitor. Display reconfiguration and hardware feel require real-device validation.

## Initial tuning

| Preference | Default | Meaning |
|---|---|---|
| `zen.pip.trackpad.enabled` | `true` | Activate the macOS adapter |
| `zen.pip.trackpad.fling-speed` | `1200` | Corner threshold in CSS pixels/second |
| `zen.pip.trackpad.fling-distance` | `24` | Minimum meaningful travel before a corner fling |
| `zen.pip.trackpad.snap-duration-ms` | `180` | Corner animation duration |

The corner threshold uses recent release velocity, not accumulated distance. Both axes must contribute at least 35% of the total speed. Cardinal swipes and weak diagonal nudges coast without forced corner selection. A stationary pause ages the velocity to zero. Coast decays exponentially with a 100 ms time constant, bounded to the captured work area.

Changes to numeric preferences apply to newly opened PiP windows; disabling the feature cancels the current window immediately.

## Reviewed upstream references

This is an independent implementation informed by both closed PRs. Neither original PR is merged wholesale into the fork.

| PR | Author | Reviewed head | Ideas and findings |
|---|---|---|---|
| [13828](https://github.com/zen-browser/desktop/pull/13828) | Laurie / laurienicholas | `7f7f5816b0124180776bb430e774fe465b959f12` | Direct wheel movement and centered wheel resize; no release/inertia lifecycle, incomplete aspect/height bounds |
| [15176](https://github.com/zen-browser/desktop/pull/15176) | Dolgirev Leonid / dlgrv | `20afb0d2683ad55a5f3b2d196d84cf426f73d208` | macOS corner animation and preference idea; distance/quiet-time snap instead of the requested live pan, pinch and release velocity |

PR 13828's reviewed base is `8f905e7abd9d4b0c145ea9f5ad3b02190308831f`; PR 15176's is `e89bd7796e2dcecaf0c483a795225ed9ec549bbd`. The first head includes an upstream-only merge; its original PiP feature commit is `26af9a794759966931f73d4006b7a3e50d5e94b1`. Discussions and exact pinned diffs were reviewed. Both were closed under upstream's generated-code policy; neither has successful CI evidence at the reviewed head. Those facts do not establish technical correctness. Original Gecko/Zen behavior and MPL licensing are retained.

## Verification

Run `node --test tests/pip/gestures.test.mjs` with the managed Node 22. It exercises geometry, fractional movement, velocity thresholds, pause/reversal, coast, all corners, negative monitor origins, stale animation callbacks, native momentum filtering, input guards, fullscreen and cleanup. These are policy/adapter tests, not hardware proof.

Native/IDL changes require a fresh import and full build through `tools/local/dev.py`, then a separately signed Playground package. Use the loopback `/pip` fixture served by `tools/compatibility/probe_server.py`. It generates its own animated video via a canvas stream.

Runtime evidence must identify the exact package, source SHA, PID and explicit managed Playground profile. Native replay must keep the gesture's original screen point fixed as the window moves, test finger Ended with a final delta and momentum separately, and verify ordinary PiP controls/fullscreen. Control-wheel replay verifies the converted pinch path; physical trackpad pinch and subjective tuning are separate checks. Do not use macOS `sendNativeTouchpadPinch`, whose inherited Gecko implementation aborts.

The signed macOS candidate and remaining hardware limitations are recorded in [the validation report](pip-trackpad-validation.md). Main Zen and the personal profile are not changed by Playground testing. The improvement checklist remains open until physical trackpad acceptance; converted-wheel replay does not establish native magnify delivery or subjective feel.
