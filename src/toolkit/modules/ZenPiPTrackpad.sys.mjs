/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  ZenPiPGestureMotion,
  cornerPiPRect,
} from "./ZenPiPGestureMotion.sys.mjs";

const PREF = "zen.pip.trackpad.enabled";
const PHASE_START = "MozZenPiPTrackpadStart";
const PHASE_END = "MozZenPiPTrackpadEnd";
const PHASE_CANCEL = "MozZenPiPTrackpadCancel";
const NATIVE_PAN = "MozZenPiPTrackpadPan";
const NATIVE_PINCH = "MozZenPiPTrackpadPinch";
const MOUSE_START = "MozZenPiPMouseStart";
const MOUSE_MOVE = "MozZenPiPMouseMove";
const MOUSE_END = "MozZenPiPMouseEnd";
const CAPTURE_ATTRIBUTE = "zen-pip-trackpad-capture";
const EXCLUDED_TARGETS =
  "input,select,textarea,[role=slider],#settings,#playbackRateSettings";
const EVENTS = [
  "wheel",
  PHASE_START,
  PHASE_END,
  PHASE_CANCEL,
  NATIVE_PAN,
  NATIVE_PINCH,
  MOUSE_START,
  MOUSE_MOVE,
  MOUSE_END,
  "pointerdown",
  "resize",
  "MozDOMFullscreen:Entered",
  "MozDOMFullscreen:Exited",
  "unload",
];

export class ZenPiPTrackpad {
  constructor(window, { platform, prefs, onMove = () => {} }) {
    this.window = window;
    this.platform = platform;
    this.prefs = prefs;
    this.destroyed = false;
    this.fullscreenPending = false;
    this.expectedSize = null;
    this.resizeRequests = [];
    this.geometryFrame = null;
    this.pendingRect = null;
    this.nativeGesture = null;
    this.onMove = onMove;
    this.motion = new ZenPiPGestureMotion(
      {
        now: () => window.performance.now(),
        readRect: () => ({
          x: window.screenX,
          y: window.screenY,
          width: window.outerWidth,
          height: window.outerHeight,
        }),
        readBounds: () => ({
          x: window.screen.availLeft,
          y: window.screen.availTop,
          width: window.screen.availWidth,
          height: window.screen.availHeight,
        }),
        writeRect: (rect) => {
          // Retain every fractional input sample, but submit at most one pinch
          // rectangle per display frame. A native resize and a subsequent move
          // expose two different centers to AppKit and the remote video.
          if (this.motion.phase === "pinch") {
            this.pendingRect = { ...rect };
            if (this.geometryFrame === null) {
              this.geometryFrame = window.requestAnimationFrame(() => {
                this.geometryFrame = null;
                this.flushGeometry();
              });
            }
          } else {
            this.applyGeometry(rect);
          }
          return rect;
        },
        requestFrame: (callback) =>
          window.requestAnimationFrame((time) => {
            if (this.enabled && this.sameScreenBounds) {
              callback(time);
            } else {
              this.motion.stop();
            }
          }),
        cancelFrame: (frame) => window.cancelAnimationFrame(frame),
      },
      {
        flingSpeed:
          Math.max(100, prefs.getIntPref("zen.pip.trackpad.fling-speed", 650)) /
          1000,
        flingDistance: Math.max(
          0,
          prefs.getIntPref("zen.pip.trackpad.fling-distance", 12),
        ),
        snapDuration: prefs.getIntPref(
          "zen.pip.trackpad.snap-duration-ms",
          180,
        ),
        edgePadding: Math.max(
          0,
          prefs.getIntPref("zen.pip.trackpad.edge-padding", 16),
        ),
      },
    );

    // Other platforms retain their current input behavior until they acquire
    // their own tested adapter and native lifecycle signals.
    if (platform === "macosx") {
      for (const type of EVENTS) {
        window.addEventListener(type, this, { capture: true, passive: false });
      }
      prefs.addObserver(PREF, this);
    }
  }

  get enabled() {
    return (
      !this.destroyed &&
      this.platform === "macosx" &&
      !this.fullscreenPending &&
      this.prefs.getBoolPref(PREF, true) &&
      !this.window.closed &&
      !this.window.fullScreen &&
      !this.window.document.fullscreenElement
    );
  }

  get sameScreenBounds() {
    const bounds = this.motion.bounds;
    const screen = this.window.screen;
    return (
      !bounds ||
      (screen.availLeft === bounds.x &&
        screen.availTop === bounds.y &&
        screen.availWidth === bounds.width &&
        screen.availHeight === bounds.height)
    );
  }

  observe() {
    if (!this.enabled) {
      this.cancelGesture();
    }
  }

  suspendForFullscreen() {
    this.fullscreenPending = true;
    this.cancelGesture();
  }

  resumeAfterFullscreen() {
    this.fullscreenPending = false;
    this.cancelGesture();
  }

  applyGeometry(rect) {
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const x = Math.round(rect.x);
    const y = Math.round(rect.y);
    if (
      this.window.outerWidth !== width ||
      this.window.outerHeight !== height
    ) {
      this.expectedSize = { width, height };
      this.resizeRequests.push(this.expectedSize);
      if (this.resizeRequests.length > 64) {
        this.resizeRequests.shift();
      }
      // Chrome-only Gecko API: one SetPositionAndSize / AppKit setFrame.
      this.window.moveResize(x, y, width, height);
    } else {
      this.window.moveTo(x, y);
    }
    this.onMove();
  }

  flushGeometry() {
    if (this.geometryFrame !== null) {
      this.window.cancelAnimationFrame(this.geometryFrame);
      this.geometryFrame = null;
    }
    const rect = this.pendingRect;
    this.pendingRect = null;
    if (rect && this.enabled && this.sameScreenBounds) {
      this.applyGeometry(rect);
    }
  }

  releaseCapture() {
    this.nativeGesture = null;
    this.window.document.documentElement.removeAttribute(CAPTURE_ATTRIBUTE);
  }

  cancelGesture() {
    this.releaseCapture();
    if (this.geometryFrame !== null) {
      this.window.cancelAnimationFrame(this.geometryFrame);
      this.geometryFrame = null;
    }
    this.pendingRect = null;
    this.motion.stop();
  }

  moveToCorner(dx, dy) {
    if (!this.enabled) {
      return false;
    }
    this.cancelGesture();
    this.motion.begin();
    this.motion.write(
      cornerPiPRect(
        this.motion.rect,
        this.motion.bounds,
        this.motion.options.edgePadding,
        dx,
        dy,
      ),
    );
    this.motion.stop();
    return true;
  }

  observeMousePosition(time) {
    this.motion.observePosition(
      {
        x: this.window.screenX,
        y: this.window.screenY,
        width: this.window.outerWidth,
        height: this.window.outerHeight,
      },
      time,
    );
  }

  acceptsInput(event, target = event.target) {
    return (
      event.deltaMode === 0 &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.buttons &&
      Number.isFinite(event.deltaX) &&
      Number.isFinite(event.deltaY) &&
      !target?.closest?.(EXCLUDED_TARGETS)
    );
  }

  handleEvent(event) {
    if (!event.isTrusted) {
      return;
    }
    if (event.type === "unload") {
      this.destroy();
      return;
    }
    if (
      event.type === "MozDOMFullscreen:Entered" ||
      event.type === "MozDOMFullscreen:Exited"
    ) {
      this.resumeAfterFullscreen();
      return;
    }
    if (event.type === "pointerdown") {
      this.cancelGesture();
      this.expectedSize = null;
      this.resizeRequests = [];
      return;
    }
    if (event.type === "resize") {
      const matches = (size) =>
        size &&
        Math.abs(this.window.outerWidth - size.width) <= 2 &&
        Math.abs(this.window.outerHeight - size.height) <= 2;
      const index = this.resizeRequests.findIndex(matches);
      const owned = index !== -1 || matches(this.expectedSize);
      if (owned) {
        if (index !== -1) {
          this.resizeRequests.splice(0, index + 1);
        }
      } else {
        this.resizeRequests = [];
        this.expectedSize = null;
        this.cancelGesture();
      }
      // Native aspect/minimum-size constraints are authoritative once reported.
      // Clamp their actual outer rectangle without replacing the newer target
      // of a continuous pinch with an intermediate resize acknowledgement.
      const bounds = this.motion.bounds;
      if (owned && bounds && this.enabled && this.sameScreenBounds) {
        const x = Math.max(
          bounds.x,
          Math.min(
            this.window.screenX,
            bounds.x + bounds.width - this.window.outerWidth,
          ),
        );
        const y = Math.max(
          bounds.y,
          Math.min(
            this.window.screenY,
            bounds.y + bounds.height - this.window.outerHeight,
          ),
        );
        if (x !== this.window.screenX || y !== this.window.screenY) {
          this.window.moveTo(Math.round(x), Math.round(y));
          this.motion.rect.x = x;
          this.motion.rect.y = y;
        }
      }
      if (!this.sameScreenBounds) {
        this.cancelGesture();
      }
      return;
    }
    if (!this.enabled) {
      return;
    }
    const time = this.window.performance.now();
    switch (event.type) {
      case MOUSE_START: {
        const target = this.window.document.elementFromPoint(
          event.clientX,
          event.clientY,
        );
        if (!event.cancelable || !target || !this.acceptsInput(event, target)) {
          return;
        }
        this.cancelGesture();
        this.nativeGesture = "mouse";
        this.window.document.documentElement.setAttribute(
          CAPTURE_ATTRIBUTE,
          "mouse",
        );
        this.motion.begin(time);
        event.preventDefault();
        break;
      }
      case MOUSE_MOVE:
      case MOUSE_END:
        if (this.nativeGesture !== "mouse") {
          return;
        }
        if (!this.sameScreenBounds || !this.acceptsInput(event)) {
          this.cancelGesture();
          return;
        }
        this.observeMousePosition(time);
        if (event.type === MOUSE_END) {
          this.releaseCapture();
          this.motion.end(time);
        }
        event.preventDefault();
        break;
      case PHASE_START:
        // Cocoa dispatches a cancellable WheelEvent directly to this chrome
        // document. Claim only an enabled PiP surface, never a slider/panel.
        // Once claimed, later samples retain this target outside its bounds.
        if (event.cancelable) {
          const target = this.window.document.elementFromPoint(
            event.clientX,
            event.clientY,
          );
          if (!target || !this.acceptsInput(event, target)) {
            return;
          }
          this.flushGeometry();
          this.nativeGesture = event.ctrlKey ? "pinch" : "pan";
          this.window.document.documentElement.setAttribute(
            CAPTURE_ATTRIBUTE,
            this.nativeGesture,
          );
          event.preventDefault();
        }
        this.motion.begin(time);
        break;
      case PHASE_END:
        this.flushGeometry();
        this.releaseCapture();
        this.motion.end(time);
        if (event.cancelable) {
          event.preventDefault();
        }
        break;
      case PHASE_CANCEL:
        this.cancelGesture();
        if (event.cancelable) {
          event.preventDefault();
        }
        break;
      case NATIVE_PAN:
      case NATIVE_PINCH:
        if (
          !this.nativeGesture ||
          this.nativeGesture === "mouse" ||
          !this.acceptsInput(event) ||
          (event.type === NATIVE_PINCH) !== (this.nativeGesture === "pinch")
        ) {
          return;
        }
        if (event.type === NATIVE_PINCH) {
          // AppKit magnification is an incremental scale, not scroll pixels.
          this.motion.pinch(1 + event.deltaY);
        } else {
          this.motion.pan(-event.deltaX, -event.deltaY, time);
        }
        event.preventDefault();
        event.stopPropagation();
        break;
      case "wheel":
        if (!this.acceptsInput(event)) {
          return;
        }
        // The OS tail belongs to the completed finger gesture. Own animation
        // supplies inertia exactly once, and a new native start interrupts it.
        if (!event.mozIsMomentum) {
          if (event.ctrlKey) {
            this.motion.pinch(
              Math.exp(Math.max(-2, Math.min(2, -event.deltaY / 100))),
            );
          } else {
            this.motion.pan(-event.deltaX, -event.deltaY, time);
          }
        }
        event.preventDefault();
        event.stopPropagation();
        break;
    }
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.resizeRequests = [];
    this.cancelGesture();
    if (this.platform === "macosx") {
      for (const type of EVENTS) {
        this.window.removeEventListener(type, this, { capture: true });
      }
      this.prefs.removeObserver(PREF, this);
    }
  }
}
