# PiP trackpad gestures

This fork implements the user's PiP gesture policy on macOS: live two-finger pan without pressing, centered pinch resize, release-velocity inertia, strong diagonal corner flings and containment within the current monitor's available work area. Ordinary mouse drag and the original Cmd+drag corner behavior remain available.

The platform-neutral `ZenPiPGestureMotion.sys.mjs` owns geometry, recent velocity, exponential coast and corner animation. `ZenPiPTrackpad.sys.mjs` binds those rules to a trusted macOS chrome gesture bridge and pixel wheel input. Windows/Linux do not install the adapter; they require native phase adapters and real host validation before activation.

## Input and lifecycle

Cocoa routes phase-bearing pan and magnify before AppKit hit-testing. At the initial sample it resolves the visible window under the pointer, verifies the system-principal `Toolkit:PictureInPicture` document at the exact player URI, and asks its adapter to claim the surface. Sliders/settings, modifiers, disabled input and fullscreen decline the claim. The accepted owner receives the remaining deltas and terminal phase even after the window moves away from the cursor. Final nonzero input precedes release. A new gesture over another window retains its ordinary behavior.

The bridge delivers dedicated trusted, cancellable chrome-only WheelEvents (`MozZenPiPTrackpadStart/Pan/Pinch/End/Cancel`) directly to the player document. Only Start uses element hit-testing; subsequent samples require the exact live claim, so an outside position cannot drop their APZ hit-test. AppKit magnification applies the incremental factor `1 + magnification`. Ordinary Control+pixel wheel remains an `exp(-deltaY / 100)` resize shortcut. Pixel pans use CSS points; line/page wheels and existing controls retain their behavior.

Local application routing chooses PiP without activating it or changing the key window. A scoped NSEvent global monitor also observes scroll/magnify and mouse-down events while PiP windows exist, allowing an owned gesture to finish when its events escape to another application. It is removed when the last PiP closes. Global monitors cannot suppress events in another application; inactive-application magnify delivery and any effect on the foreground application require physical validation. No keyboard events, touch data or unrelated page content are collected.

No inactivity timer launches motion while fingers rest. The native router drains the completed owner's OS momentum tail because the portable controller supplies inertia. The ChromeOnly `WheelEvent.mozIsMomentum` getter handles the ordinary Gecko wheel path. A new touch over PiP, click, cancellation, manual resize, fullscreen transition, disabled preference or close cancels motion. Animation generations invalidate queued callbacks.

Each gesture captures the current monitor's available bounds, including negative origins and Dock/menu exclusions. Fractional target sizes accumulate across asynchronous/coalesced AppKit notifications. Pinch samples submit at most one rectangle per display frame through Gecko's chrome-only `window.moveResize`, which performs one native position-and-size update. End flushes the final pending rectangle; cancellation discards it. Intermediate resize acknowledgements cannot replace a newer intended size. This removes the previous resize-then-move path; perceived smoothness of the live remote video remains a hardware acceptance check.

The existing privileged `sendNativeTouchpadPinch` testing API has a macOS implementation using an NSEvent test object and the real Cocoa router. It supplies absolute scale ratios and native phases without private multitouch APIs or OS posting. This tests native routing and geometry but does not emulate physical hardware. Native scroll synthesis invokes the same application router, then preserves Gecko's original `scrollWheel` fallback for unclaimed controls/page input. Its constructed NSEvent has no usable native window number, so sending it through `NSApp` loses that fallback. The production `NSApp sendEvent:` hook continues to route actual events before AppKit dispatch.

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

Runtime evidence must identify the exact package, source SHA, PID and explicit managed Playground profile. Native replay must keep the gesture's original screen point fixed as the window moves, test finger Ended with a final delta and momentum separately, and verify ordinary PiP controls/fullscreen. Control-wheel replay verifies the converted pinch path. The fork's added native pinch API can exercise magnify accessors and the real owner router; older retained packages and upstream's inherited macOS implementation do not support it. Physical AppKit event delivery, pinch and subjective tuning are separate checks.

The signed macOS candidate and remaining hardware limitations are recorded in [the validation report](pip-trackpad-validation.md). Main Zen and the personal profile are not changed by Playground testing. The improvement checklist remains open until physical trackpad acceptance; converted-wheel replay does not establish native magnify delivery or subjective feel.
