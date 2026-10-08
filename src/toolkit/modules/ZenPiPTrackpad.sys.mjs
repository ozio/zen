/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ZenPiPGestureMotion } from "./ZenPiPGestureMotion.sys.mjs";

const PREF = "zen.pip.trackpad.enabled";
const PHASE_START = "MozZenPiPTrackpadStart";
const PHASE_END = "MozZenPiPTrackpadEnd";
const PHASE_CANCEL = "MozZenPiPTrackpadCancel";
const EVENTS = [
  "wheel",
  PHASE_START,
  PHASE_END,
  PHASE_CANCEL,
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
          const width = Math.round(rect.width);
          const height = Math.round(rect.height);
          if (window.outerWidth !== width || window.outerHeight !== height) {
            this.expectedSize = { width, height };
            window.resizeTo(width, height);
          }
          // resizeTo can be constrained by the native aspect/minimum-size lock.
          // Position using the actual outer size, including on a Retina screen.
          const bounds = this.motion.bounds;
          const x = Math.max(
            bounds.x,
            Math.min(rect.x, bounds.x + bounds.width - window.outerWidth),
          );
          const y = Math.max(
            bounds.y,
            Math.min(rect.y, bounds.y + bounds.height - window.outerHeight),
          );
          window.moveTo(Math.round(x), Math.round(y));
          onMove();
          return {
            x,
            y,
            width: window.outerWidth,
            height: window.outerHeight,
          };
        },
        requestFrame: (callback) =>
          window.requestAnimationFrame((time) => {
            if (this.enabled) {
              callback(time);
            } else {
              this.motion.stop();
            }
          }),
        cancelFrame: (frame) => window.cancelAnimationFrame(frame),
      },
      {
        flingSpeed:
          Math.max(
            100,
            prefs.getIntPref("zen.pip.trackpad.fling-speed", 1200),
          ) / 1000,
        flingDistance: Math.max(
          0,
          prefs.getIntPref("zen.pip.trackpad.fling-distance", 24),
        ),
        snapDuration: prefs.getIntPref(
          "zen.pip.trackpad.snap-duration-ms",
          180,
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

  observe() {
    if (!this.enabled) {
      this.motion.stop();
    }
  }

  suspendForFullscreen() {
    this.fullscreenPending = true;
    this.motion.stop();
  }

  resumeAfterFullscreen() {
    this.fullscreenPending = false;
    this.motion.stop();
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
      this.motion.stop();
      return;
    }
    if (event.type === "resize") {
      if (
        this.expectedSize &&
        Math.abs(this.window.outerWidth - this.expectedSize.width) <= 2 &&
        Math.abs(this.window.outerHeight - this.expectedSize.height) <= 2
      ) {
        // Multiple native resize notifications can describe the same result.
      } else {
        this.motion.stop();
      }
      return;
    }
    if (!this.enabled) {
      return;
    }
    const time = this.window.performance.now();
    switch (event.type) {
      case PHASE_START:
        this.motion.begin(time);
        break;
      case PHASE_END:
        this.motion.end(time);
        break;
      case PHASE_CANCEL:
        this.motion.stop();
        break;
      case "wheel":
        if (
          event.deltaMode !== 0 ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey ||
          event.buttons ||
          !Number.isFinite(event.deltaX) ||
          !Number.isFinite(event.deltaY) ||
          event.target?.closest?.(
            "input,select,textarea,[role=slider],#settings,#playbackRateSettings",
          )
        ) {
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
    this.motion.stop();
    if (this.platform === "macosx") {
      for (const type of EVENTS) {
        this.window.removeEventListener(type, this, { capture: true });
      }
      this.prefs.removeObserver(PREF, this);
    }
  }
}
