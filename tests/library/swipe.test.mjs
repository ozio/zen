import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/library/ZenLibrary.mjs", import.meta.url),
  "utf8",
);

function setup({ right = true, compact = false } = {}) {
  class Element {
    attributes = new Map();
    properties = new Map();
    style = {
      setProperty: (key, value) => this.properties.set(key, value),
      removeProperty: (key) => this.properties.delete(key),
    };
    updateComplete = Promise.resolve();
    classList = { add() {} };
    setAttribute(key, value) {
      this.attributes.set(key, value);
    }
    removeAttribute(key) {
      this.attributes.delete(key);
    }
    hasAttribute(key) {
      return this.attributes.has(key);
    }
    requestUpdate() {}
    querySelector() {
      return null;
    }
    querySelectorAll() {
      return [];
    }
    addEventListener() {}
    removeEventListener() {}
    appendChild() {}
    before() {}
    after() {}
    remove() {}
    cloneNode() {
      return new Element();
    }
  }
  const nav = new Element();
  const nodes = new Map(
    [
      "zen-appcontent-wrapper",
      "zen-toast-container",
      "zen-main-app-wrapper",
    ].map((id) => [id, new Element()]),
  );
  const springs = [];
  const flushes = [];
  const timers = new Map();
  let nextTimer = 0;
  const sections = Object.fromEntries(
    ["History", "Spaces", "Boosts", "Downloads", "Media"].map((name) => [
      `ZenLibrary${name}Section`,
      { id: name.toLowerCase() },
    ]),
  );
  const buttons = new Element();
  buttons.nextSibling = new Element();
  const ws = {
    privateWindowOrDisabled: false,
    _swipeManager: {
      attachWorkspaceSwipeGestures() {},
      detachWorkspaceSwipeGestures() {},
    },
  };
  const window = {
    gZenWorkspaces: ws,
    gZenCompactModeManager: { preference: compact },
    promiseDocumentFlushed: () =>
      new Promise((resolve) => flushes.push(resolve)),
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback) {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    windowUtils: {
      getBoundsWithoutFlushing: (e) => ({ width: e === nav ? 230 : 1000 }),
    },
  };
  const context = vm.createContext({
    window,
    document: {
      getElementById: (id) => nodes.get(id),
      addEventListener() {},
      removeEventListener() {},
    },
    MozLitElement: Element,
    customElements: { define() {} },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    ChromeUtils: {
      importESModule: () => ({
        ZenLibraryWidget: { attachLibrary() {}, detachLibrary() {} },
      }),
      defineESModuleGetters: (target) => Object.assign(target, sections),
      defineLazyGetter: (target, key, getter) =>
        Object.defineProperty(target, key, { get: getter }),
    },
    Services: {
      prefs: {
        getStringPref: () => "spaces",
        getBoolPref: () => compact,
        setStringPref() {},
      },
    },
    gZenWorkspaces: ws,
    gNavToolbox: nav,
    gURLBar: { view: { close() {} } },
    ZenThemeModifier: { elementSeparation: 8 },
    gZenVerticalTabsManager: {
      _prefsRightSide: right,
      isWindowsStyledButtons: false,
      actualWindowButtons: buttons,
    },
    gZenUIManager: {
      motion: {
        animate(from, target, options) {
          const spring = {
            from,
            target,
            options,
            stopped: false,
            stop() {
              this.stopped = true;
            },
          };
          springs.push(spring);
          return spring;
        },
      },
    },
  });
  vm.runInContext(
    source
      .replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "")
      .replace("export class ZenLibrary", "class ZenLibrary") +
      "\nwindow.Library = ZenLibrary; ZenLibrary.instance = new ZenLibrary();",
    context,
  );
  const Library = window.Library;
  const lib = Library.getInstance();
  lib._header = new Element();
  return {
    Library,
    lib,
    springs,
    nodes,
    nav,
    async flush() {
      // Allow the stylesheet promise to reach the document-flush boundary.
      await new Promise(setImmediate);
      flushes.splice(0).forEach((resolve) => resolve());
      await new Promise(setImmediate);
    },
    complete(spring = springs.at(-1)) {
      spring.options.onUpdate(spring.target);
      spring.options.onComplete();
    },
  };
}

test("native gesture end leaves Library transitioning until its release spring finishes", async () => {
  const s = setup();
  const start = s.Library.startSwipe();
  await s.flush();
  await start;
  s.Library.swipeProgress(-0.4);
  s.Library.stopSwipe(1);
  await s.flush();
  s.Library.swipeAnimationEnd();
  assert.equal(s.springs.at(-1).target, 1);
  assert.ok(s.lib.hasAttribute("transitioning"));
  s.complete();
  assert.ok(!s.lib.hasAttribute("transitioning"));
  assert.equal(s.lib.openProgress, 1);
});

test("releasing before document flush cannot re-enable scrolling before settling", async () => {
  const s = setup();
  const start = s.Library.startSwipe();
  await s.flush();
  await start;
  s.Library.swipeProgress(-0.3);
  s.Library.stopSwipe(1);
  s.Library.swipeAnimationEnd();
  assert.ok(s.lib.hasAttribute("transitioning"));
  await s.flush();
  s.complete();
  assert.ok(!s.lib.hasAttribute("transitioning"));
});

test("a new swipe stops the previous spring before waiting for layout", async () => {
  const s = setup();
  const opening = s.Library.animateProgress(1);
  await s.flush();
  await opening;
  const old = s.springs.at(-1);
  old.options.onUpdate(0.4);
  const start = s.Library.startSwipe();
  assert.equal(old.stopped, true);
  await s.flush();
  await start;
  assert.equal(s.lib.openProgress, 0.4);
});

test("a pending open cannot restart an animation after a newer gesture", async () => {
  const s = setup();
  s.Library.animateProgress(1);
  const start = s.Library.startSwipe();
  await s.flush();
  await start;
  assert.equal(s.springs.length, 0);
  assert.ok(s.lib.hasAttribute("transitioning"));
});

test("returning to the current endpoint cancels an older spring and rejects stale callbacks", async () => {
  const s = setup();
  const opening = s.Library.animateProgress(1);
  await s.flush();
  await opening;
  const old = s.springs.at(-1);
  await s.Library.animateProgress(0);
  assert.ok(old.stopped);
  old.options.onUpdate(0.8);
  old.options.onComplete();
  assert.equal(s.lib.openProgress, 0);
  assert.ok(!s.lib.hasAttribute("open"));
  assert.ok(!s.lib.hasAttribute("transitioning"));
});

test("interrupting a spring starts dragging from its current position", async () => {
  const s = setup();
  const opening = s.Library.animateProgress(1);
  await s.flush();
  await opening;
  s.springs.at(-1).options.onUpdate(0.4);
  await s.Library.startSwipe();
  s.Library.swipeProgress(0);
  assert.equal(s.lib.openProgress, 0.4);
});

test("dense section cleanup happens after closing has hidden the panel", async () => {
  const s = setup();
  const closing = [];
  s.lib._content = {
    children: [
      {
        dataset: { section: "spaces" },
        onLibraryClosing: () => closing.push(s.lib.hidden),
      },
    ],
  };
  const start = s.Library.startSwipe();
  await s.flush();
  await start;
  s.Library.swipeProgress(-0.4);
  await s.Library.animateProgress(0);
  assert.deepEqual(closing, []);
  s.complete();
  assert.deepEqual(closing, [true]);
});

test("a cold swipe released during preparation cannot restart after its release spring", async () => {
  const s = setup();
  const start = s.Library.startSwipe();
  s.Library.swipeProgress(-0.4);
  s.Library.stopSwipe(1);
  s.Library.swipeAnimationEnd();
  await s.flush();
  await start;
  assert.equal(s.springs.length, 1);
  s.complete();
  s.Library.swipeProgress(-0.2);
  assert.equal(s.lib.openProgress, 1);
  assert.ok(!s.lib.hasAttribute("transitioning"));
});

test("cancelling a partially open gesture restores wrapper styles and interaction", async () => {
  const s = setup();
  const start = s.Library.startSwipe();
  await s.flush();
  await start;
  s.Library.swipeProgress(-0.2);
  s.Library.swipeAnimationEnd();
  await s.flush();
  if (s.springs.length) s.complete();
  assert.equal(s.lib.openProgress, 0);
  assert.ok(!s.lib.hasAttribute("open"));
  assert.ok(!s.lib.hasAttribute("transitioning"));
  assert.equal(s.lib.style.pointerEvents, "");
  assert.ok(!s.nodes.get("zen-appcontent-wrapper").properties.has("transform"));
});

for (const right of [false, true]) {
  for (const compact of [false, true]) {
    test(`release preserves final transforms (right=${right}, compact=${compact})`, async () => {
      const s = setup({ right, compact });
      const start = s.Library.startSwipe();
      await s.flush();
      await start;
      s.Library.swipeProgress(right ? -0.5 : 0.5);
      s.Library.stopSwipe(right ? 1 : -1);
      await s.flush();
      s.complete();
      const offset = (right ? -1 : 1) * (1000 - 230 + (compact ? 222 : 0));
      assert.equal(
        s.nodes.get("zen-appcontent-wrapper").properties.get("transform"),
        `translateX(${offset}px)`,
      );
      assert.equal(
        s.nodes.get("zen-toast-container").properties.get("transform"),
        `translateX(${-offset}px)`,
      );
      assert.equal(s.lib.openProgress, 1);
      assert.ok(!s.lib.hasAttribute("transitioning"));
    });
  }
}
