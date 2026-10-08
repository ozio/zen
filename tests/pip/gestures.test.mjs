import assert from "node:assert/strict";
import test from "node:test";
import {
  fitPiPRect,
  ZenPiPGestureMotion,
} from "../../src/toolkit/modules/ZenPiPGestureMotion.sys.mjs";
import { ZenPiPTrackpad } from "../../src/toolkit/modules/ZenPiPTrackpad.sys.mjs";

const bounds = { x: 0, y: 25, width: 1400, height: 900 };
const initial = { x: 400, y: 300, width: 320, height: 180 };
const close = (a, b, tolerance = 1e-6) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function harness(options = {}, workArea = bounds, rectangle = initial) {
  let now = 0,
    next = 0,
    rect = { ...rectangle };
  const callbacks = new Map(),
    cancelled = [];
  const host = {
    now: () => now,
    readBounds: () => workArea,
    readRect: () => rect,
    writeRect: (value) => {
      rect = { ...value };
    },
    requestFrame: (callback) => {
      callbacks.set(++next, callback);
      return next;
    },
    cancelFrame: (id) => {
      cancelled.push(callbacks.get(id));
      callbacks.delete(id);
    },
  };
  const motion = new ZenPiPGestureMotion(host, options);
  return {
    motion,
    host,
    cancelled,
    get rect() {
      return rect;
    },
    get now() {
      return now;
    },
    at(time) {
      now = time;
    },
    tick(ms = 16) {
      now += ms;
      const queued = [...callbacks.values()];
      callbacks.clear();
      for (const callback of queued) callback(now);
    },
    settle() {
      for (let i = 0; i < 200 && callbacks.size; i++) this.tick();
      assert.equal(callbacks.size, 0);
    },
  };
}
function swipe(h, dx, dy, duration = 40) {
  h.motion.begin(h.now);
  for (let i = 0; i < 4; i++) {
    h.at(h.now + duration / 4);
    h.motion.pan(dx / 4, dy / 4, h.now);
  }
  h.motion.end(h.now);
}
function contained(rect, area = bounds) {
  assert.ok(rect.x >= area.x - 1e-6);
  assert.ok(rect.y >= area.y - 1e-6);
  assert.ok(rect.x + rect.width <= area.x + area.width + 1e-6);
  assert.ok(rect.y + rect.height <= area.y + area.height + 1e-6);
}

test("pinch preserves portrait aspect and fits height on a negative-origin monitor", () => {
  const area = { x: -1600, y: -120, width: 1600, height: 860 };
  const rect = fitPiPRect(
    { x: -800, y: 100, width: 180, height: 320 },
    area,
    100,
  );
  close(rect.width / rect.height, 180 / 320);
  close(rect.height, 860);
  contained(rect, area);
  const small = fitPiPRect(rect, area, 0.0001);
  close(small.width / small.height, 180 / 320);
  close(small.width, 160);
  contained(small, area);
});
test("a work area smaller than the preferred minimum still contains the rectangle", () => {
  const area = { x: -20, y: -40, width: 80, height: 50 };
  contained(fitPiPRect(initial, area), area);
  assert.throws(() => fitPiPRect(initial, { ...area, width: 0 }), RangeError);
});
test("pinch grows around the center and reverse deltas restore size", () => {
  const h = harness();
  h.motion.pinch(Math.exp(0.2));
  close(h.rect.x + h.rect.width / 2, 560);
  close(h.rect.y + h.rect.height / 2, 390);
  h.motion.pinch(Math.exp(-0.2));
  close(h.rect.width, 320);
  close(h.rect.height, 180);
  h.motion.end();
  assert.equal(h.motion.phase, "idle");
});
test("fractional live pan requires no click and stays inside the captured monitor", () => {
  const h = harness();
  h.motion.begin();
  for (let i = 0; i < 10; i++) h.motion.pan(0.2, -0.1, i + 1);
  close(h.rect.x, 402);
  close(h.rect.y, 299);
  h.motion.pan(1e5, -1e5, 20);
  contained(h.rect);
  close(h.rect.x, 1080);
  close(h.rect.y, 25);
});
test("equal travel at different speeds separates gentle coast from corner fling", () => {
  const slow = harness();
  swipe(slow, 80, 80, 400);
  assert.equal(slow.motion.phase, "coast");
  slow.settle();
  assert.ok(slow.rect.x < 600);
  assert.ok(slow.rect.y < 500);
  const fast = harness();
  swipe(fast, 80, 80, 40);
  assert.equal(fast.motion.phase, "snap");
  fast.settle();
  close(fast.rect.x, 1080);
  close(fast.rect.y, 745);
});
for (const [dx, dy, x, y] of [
  [80, 80, 1080, 745],
  [-80, 80, 0, 745],
  [80, -80, 1080, 25],
  [-80, -80, 0, 25],
]) {
  test(`strong diagonal (${dx},${dy}) settles in its selected corner`, () => {
    const h = harness();
    swipe(h, dx, dy);
    h.settle();
    close(h.rect.x, x);
    close(h.rect.y, y);
    contained(h.rect);
  });
}
test("pure cardinal motion and diagonal noise do not select an unrelated corner", () => {
  for (const [dx, dy] of [
    [80, 0],
    [0, 80],
    [80, 2],
  ]) {
    const h = harness();
    swipe(h, dx, dy);
    assert.equal(h.motion.phase, "coast");
    h.settle();
    contained(h.rect);
    if (!dy) close(h.rect.y, initial.y);
    if (!dx) close(h.rect.x, initial.x);
  }
});
test("tiny fast movement does not fling; release after resting does not coast", () => {
  const tiny = harness();
  swipe(tiny, 4, 4, 2);
  assert.equal(tiny.motion.phase, "coast");
  const resting = harness();
  resting.motion.begin();
  resting.at(20);
  resting.motion.pan(80, 80, 20);
  resting.at(200);
  resting.motion.end(200);
  assert.equal(resting.motion.phase, "idle");
  const before = { ...resting.rect };
  resting.tick();
  assert.deepEqual(resting.rect, before);
});
test("gentle inertia distance scales with release velocity and frame time", () => {
  const slow = harness();
  swipe(slow, 20, 0, 80);
  const slowRelease = slow.rect.x;
  slow.settle();
  const faster = harness();
  swipe(faster, 40, 0, 80);
  const fastRelease = faster.rect.x;
  while (faster.motion.phase !== "idle") faster.tick(8);
  assert.ok(faster.rect.x - fastRelease > (slow.rect.x - slowRelease) * 1.8);
  close(slow.rect.x - slowRelease, 25, 3);
  close(faster.rect.x - fastRelease, 50, 3);
});
test("recent reversal controls fling direction, including the final Ended delta", () => {
  const h = harness();
  h.motion.begin();
  h.at(20);
  h.motion.pan(80, 80, 20);
  h.at(120);
  h.motion.pan(-80, -80, 120);
  h.at(130);
  h.motion.pan(-80, -80, 130);
  h.motion.end(130);
  assert.equal(h.motion.phase, "snap");
  h.settle();
  close(h.rect.x, 0);
  close(h.rect.y, 25);
});
test("each motion keeps its own negative-origin current monitor", () => {
  const area = { x: -1400, y: -875, width: 1400, height: 900 };
  const h = harness({}, area, { ...initial, x: -800, y: -500 });
  const other = harness();
  swipe(h, -80, -80);
  h.settle();
  close(h.rect.x, -1400);
  close(h.rect.y, -875);
  contained(h.rect, area);
  assert.deepEqual(other.rect, initial);
});
test("resting re-touch cancels coast and invalidates an already queued callback", () => {
  const h = harness();
  swipe(h, 40, 0, 80);
  h.motion.begin();
  const before = { ...h.rect };
  h.cancelled.at(-1)(1000);
  assert.deepEqual(h.rect, before);
  assert.equal(h.motion.phase, "pan");
  h.motion.end();
  assert.equal(h.motion.phase, "idle");
});
test("cancel also invalidates snap; a long animation frame remains bounded", () => {
  const h = harness();
  swipe(h, 80, 80);
  h.motion.stop();
  const before = { ...h.rect };
  h.cancelled.at(-1)(1000);
  assert.deepEqual(h.rect, before);
  swipe(h, 80, 0);
  h.tick(100000);
  contained(h.rect);
  assert.equal(h.motion.phase, "idle");
});

function adapter(platform = "macosx") {
  const h = harness();
  let bool = true;
  const listeners = new Map(),
    observers = new Set();
  const window = {
    screenX: initial.x,
    screenY: initial.y,
    outerWidth: 320,
    outerHeight: 180,
    screen: { availLeft: 0, availTop: 25, availWidth: 1400, availHeight: 900 },
    performance: { now: () => h.now },
    document: { fullscreenElement: null },
    closed: false,
    fullScreen: false,
    resizeTo(width, height) {
      this.outerWidth = width;
      this.outerHeight = height;
    },
    moveTo(x, y) {
      this.screenX = x;
      this.screenY = y;
    },
    requestAnimationFrame: h.host.requestFrame,
    cancelAnimationFrame: h.host.cancelFrame,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
  };
  const prefs = {
    getBoolPref: () => bool,
    getIntPref: (_, fallback) => fallback,
    addObserver: (_, observer) => observers.add(observer),
    removeObserver: (_, observer) => observers.delete(observer),
  };
  const instance = new ZenPiPTrackpad(window, { platform, prefs });
  const event = (type, fields = {}) => {
    const e = {
      type,
      isTrusted: true,
      deltaMode: 0,
      deltaX: 0,
      deltaY: 0,
      buttons: 0,
      target: { closest: () => false },
      preventDefault() {
        this.consumed = true;
      },
      stopPropagation() {},
      ...fields,
    };
    listeners.get(type)?.handleEvent(e);
    return e;
  };
  return {
    h,
    window,
    instance,
    event,
    listeners,
    observers,
    disable() {
      bool = false;
      instance.observe();
    },
  };
}
test("mac adapter accumulates subpixel deltas and ignores native OS momentum", () => {
  const a = adapter();
  a.event("MozZenPiPTrackpadStart");
  for (let i = 1; i <= 5; i++) {
    a.h.at(i * 10);
    a.event("wheel", { deltaX: -0.2 });
  }
  assert.equal(a.window.screenX, 401);
  a.event("MozZenPiPTrackpadEnd");
  const before = a.window.screenX;
  const tail = a.event("wheel", { deltaX: -100, mozIsMomentum: true });
  assert.equal(tail.consumed, true);
  assert.equal(a.window.screenX, before);
});
test("native Control pixel pinch preserves size ratio and never pans", () => {
  const a = adapter();
  a.event("wheel", { ctrlKey: true, deltaY: -20 });
  close(a.window.outerWidth / a.window.outerHeight, 16 / 9, 0.01);
  close(a.window.screenX + a.window.outerWidth / 2, 560, 1);
  a.event("MozZenPiPTrackpadEnd");
  assert.equal(a.instance.motion.phase, "idle");
});
test("mouse wheels, modifiers, pressed buttons, untrusted input and settings keep their behavior", () => {
  for (const fields of [
    { deltaMode: 1 },
    { deltaMode: 2 },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { buttons: 1 },
    { isTrusted: false },
    { deltaX: NaN },
    { target: { closest: () => true } },
  ]) {
    const a = adapter();
    const e = a.event("wheel", { deltaX: -20, ...fields });
    assert.equal(a.window.screenX, 400);
    assert.equal(e.consumed, undefined);
    a.instance.destroy();
  }
});
test("native release launches inertia; cancel and zero-delta new touch stop it", () => {
  const a = adapter();
  a.event("MozZenPiPTrackpadStart");
  a.h.at(40);
  a.event("wheel", { deltaX: -20 });
  a.event("MozZenPiPTrackpadEnd");
  assert.equal(a.instance.motion.phase, "coast");
  a.event("MozZenPiPTrackpadStart");
  const before = a.window.screenX;
  a.h.tick();
  assert.equal(a.window.screenX, before);
  a.event("MozZenPiPTrackpadCancel");
  assert.equal(a.instance.motion.phase, "idle");
});
test("fullscreen, preference disable, manual resize, pointerdown and unload cancel owned motion", () => {
  for (const stop of [
    (a) => a.disable(),
    (a) => a.event("pointerdown"),
    (a) => a.event("MozDOMFullscreen:Entered"),
    (a) => {
      a.window.outerWidth = 500;
      a.event("resize");
    },
    (a) => a.event("unload"),
    (a) => a.instance.suspendForFullscreen(),
  ]) {
    const a = adapter();
    a.event("MozZenPiPTrackpadStart");
    a.h.at(40);
    a.event("wheel", { deltaX: -80, deltaY: -80 });
    a.event("MozZenPiPTrackpadEnd");
    stop(a);
    const x = a.window.screenX;
    a.h.tick();
    assert.equal(a.window.screenX, x);
    assert.equal(a.instance.motion.phase, "idle");
    a.instance.destroy();
    assert.equal(a.listeners.size, 0);
    assert.equal(a.observers.size, 0);
  }
});
test("normal and pending fullscreen reject wheel; exiting permits gestures again", () => {
  const a = adapter();
  a.window.fullScreen = true;
  a.event("wheel", { deltaX: -20 });
  assert.equal(a.window.screenX, 400);
  a.window.fullScreen = false;
  a.instance.suspendForFullscreen();
  a.event("wheel", { deltaX: -20 });
  assert.equal(a.window.screenX, 400);
  a.event("MozDOMFullscreen:Exited");
  a.event("wheel", { deltaX: -20 });
  assert.equal(a.window.screenX, 420);
});
test("own repeated resize notifications preserve a pinch; non-Mac adds no hooks", () => {
  const a = adapter();
  a.event("wheel", { ctrlKey: true, deltaY: -20 });
  a.event("resize");
  a.event("resize");
  assert.equal(a.instance.motion.phase, "pinch");
  a.instance.destroy();
  a.instance.destroy();
  for (const platform of ["win", "linux"]) {
    const other = adapter(platform);
    assert.equal(other.listeners.size, 0);
    assert.equal(other.observers.size, 0);
    assert.equal(other.instance.enabled, false);
    other.instance.destroy();
  }
});

test("rapid pinch samples accumulate while AppKit resize is still pending", () => {
  const a = adapter();
  const pending = [];
  a.window.resizeTo = (width, height) => pending.push({ width, height });
  for (let i = 0; i < 4; i++) {
    a.event("wheel", { ctrlKey: true, deltaY: -12 });
  }
  close(a.instance.motion.rect.width, 320 * Math.exp(0.48));
  assert.equal(pending.length, 4);
  // Native intermediate and coalesced results cannot reset the desired size.
  for (const size of [pending[0], pending.at(-1)]) {
    a.window.outerWidth = size.width;
    a.window.outerHeight = size.height;
    a.event("resize");
    assert.equal(a.instance.motion.phase, "pinch");
    close(a.instance.motion.rect.width, 320 * Math.exp(0.48));
  }
  contained(a.instance.motion.rect);
  a.instance.destroy();
});

test("subpixel pinch changes accumulate even before reaching a whole pixel", () => {
  const a = adapter();
  for (let i = 0; i < 20; i++) {
    a.event("wheel", { ctrlKey: true, deltaY: -0.01 });
  }
  close(a.instance.motion.rect.width, 320 * Math.exp(0.002));
  assert.equal(a.window.outerWidth, 321);
  a.instance.destroy();
});

test("a changed work area cancels animation; manual relocation/resize stays put", () => {
  const a = adapter();
  a.event("MozZenPiPTrackpadStart");
  a.h.at(40);
  a.event("wheel", { deltaX: -40 });
  a.event("MozZenPiPTrackpadEnd");
  a.window.screen.availLeft = -1400;
  const before = a.window.screenX;
  a.h.tick();
  assert.equal(a.window.screenX, before);
  assert.equal(a.instance.motion.phase, "idle");
  a.event("pointerdown");
  a.window.screenX = -800;
  a.window.outerWidth = 500;
  a.event("resize");
  assert.equal(a.window.screenX, -800);
  a.instance.destroy();
});
