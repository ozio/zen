import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/spaces/ZenSpacesSwipe.mjs", import.meta.url),
  "utf8",
);
const managerSource = readFileSync(
  new URL("../../src/zen/spaces/ZenSpaceManager.mjs", import.meta.url),
  "utf8",
);

function element() {
  const attributes = new Set();
  const properties = new Map();
  const writes = [];
  return {
    attributes,
    writes,
    style: {
      setProperty(name, value) {
        properties.set(name, value);
        writes.push([name, value]);
      },
      removeProperty(name) {
        properties.delete(name);
      },
    },
    setAttribute(name) {
      attributes.add(name);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    toggleAttribute(name, value) {
      if (value) {
        attributes.add(name);
      } else {
        attributes.delete(name);
      }
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function setup({ count = 6, active = 2, rtl = false, natural = false } = {}) {
  const workspaces = Array.from({ length: count }, (_, i) => ({
    uuid: `space-${i}`,
    containerTabId: i,
  }));
  const spaces = new Map(workspaces.map((w) => [w.uuid, element()]));
  const nav = element();
  const nodes = new Map([
    ["navigator-toolbox", nav],
    ["zen-browser-background", element()],
    ["zen-toolbar-background", element()],
  ]);
  const frames = new Map();
  const calls = [];
  const switches = [];
  let nextFrame = 0;
  let boundsReads = 0;
  const library = {
    isLibraryOpen: false,
    libraryOnRight: true,
    readySwipeOpenLibrary: () => false,
    swipeReset() {},
    startSwipe() {},
    stopSwipe() {},
    swipeAnimationEnd() {},
    swipeProgress: (value) => calls.push(["library", value]),
  };
  const add = {
    ready: false,
    progress: [],
    starts: 0,
    ends: 0,
    cleanups: 0,
  };
  class AddSwipe {
    static SUCCESS_THRESHOLD = 0.8;
    static SUCCESS_VELOCITY_CONTRIBUTION = 0;
    readySwipeAddSpace() {
      return add.ready;
    }
    swipeReset() {}
    startSwipe() {
      add.starts++;
    }
    swipeProgress(value) {
      add.progress.push(value);
    }
    endSwipe() {
      add.ends++;
    }
    onSwipeAnimationEnd() {
      add.cleanups++;
    }
  }
  const ws = {
    workspaceEnabled: true,
    privateWindowOrDisabled: false,
    naturalScroll: natural,
    getWorkspaces: () => workspaces,
    getActiveWorkspaceFromCache: () => workspaces[active],
    workspaceElement: (uuid) => spaces.get(uuid),
    _organizeWorkspaceStripLocations: (...args) => calls.push(args),
    _resetWorkspaceSwipe: () => calls.push([workspaces[active], true, 0]),
    updateTabsContainers() {},
    changeWorkspaceShortcut: async (...args) => switches.push(args),
  };
  const document = {
    documentElement: { matches: () => rtl },
    getElementById: (id) => nodes.get(id),
    querySelectorAll: (selector) => {
      if (selector === "zen-workspace") {
        return [...spaces.values()];
      }
      return selector === "#navigator-toolbox" ? [nav] : [];
    },
    listeners: new Map(),
    addEventListener(type, listener, options) {
      this.listeners.set(type, { listener, once: options?.once });
    },
    removeEventListener(type) {
      this.listeners.delete(type);
    },
  };
  const window = {
    requestAnimationFrame(callback) {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    windowUtils: {
      getBoundsWithoutFlushing() {
        boundsReads++;
        return { width: 230 };
      },
    },
  };
  const context = vm.createContext({
    window,
    document,
    SimpleGestureEvent: { DIRECTION_LEFT: 1, DIRECTION_RIGHT: 2 },
    ChromeUtils: {
      defineLazyGetter: (target, name, getter) =>
        Object.defineProperty(target, name, { get: getter }),
      defineESModuleGetters: (target) => {
        target.ZenLibrary = library;
      },
    },
    ZenSpaceAddSwipe: AddSwipe,
    Services: {
      prefs: { getIntPref: () => 100, getBoolPref: () => false },
    },
    gNavToolbox: nav,
    gZenWorkspaces: ws,
    gZenFolders: { cancelPopupTimer() {} },
    gZenUIManager: { tabsWrapper: element() },
  });
  vm.runInContext(
    source.replace(/^import .*;$/gm, "").replace("export class", "class") +
      "\nwindow.swipe = new ZenSpacesSwipe();",
    context,
  );
  const swipe = window.swipe;
  return {
    swipe,
    ws,
    calls,
    switches,
    workspaces,
    spaces,
    nav,
    nodes,
    library,
    add,
    frames,
    document,
    context,
    boundsReads: () => boundsReads,
    event(type, delta = 0, direction = 0, target = { closest: () => false }) {
      const event = {
        type,
        delta,
        direction,
        DIRECTION_LEFT: 1,
        DIRECTION_RIGHT: 2,
        target,
        preventDefault() {},
        stopPropagation() {},
      };
      swipe.handleEvent(event);
      return event;
    },
    paint() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback());
    },
  };
}

test("a burst of input updates draws only the latest accumulated position", () => {
  const s = setup();
  s.event("MozSwipeGestureStart");
  let last = 0;
  let expected;
  for (const delta of [0.05, 0.08, 0.15, 0.2]) {
    const input = delta * 100;
    expected = (last + input) * (1 - Math.abs(last + input) / (230 * 4.5));
    last = input + (expected - input) * 0.5;
    const event = s.event("MozSwipeGestureUpdate", delta);
    assert.equal(event.swipeSuccessThreshold, 0.25);
  }
  assert.equal(s.calls.length, 0);
  assert.equal(s.frames.size, 1);
  s.paint();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0][2], expected);
  assert.equal(s.boundsReads(), 1, "Gesture geometry is read once");
});

test("cancelling before paint restores position and prevents a delayed redraw", () => {
  const s = setup();
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0.3);
  s.event("MozSwipeGestureEnd");
  assert.equal(s.swipe.isGestureActive, false);
  assert.equal(s.frames.size, 0);
  assert.equal(s.calls.at(-1)[2], 0);
  const count = s.calls.length;
  s.paint();
  s.event("MozSwipeGestureUpdate", 0.5);
  assert.equal(s.calls.length, count);
  assert.equal(s.switches.length, 0);
  assert.ok([...s.spaces.values()].every((e) => !e.attributes.size));
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
});

test("a popup interrupts a painted gesture and restores the original space", () => {
  const s = setup();
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0.3);
  s.paint();
  assert.notEqual(s.calls.at(-1)[2], 0);
  s.event("popupshown");
  assert.equal(s.calls.at(-1)[2], 0);
  assert.equal(s.swipe.isGestureActive, false);
});

for (const rtl of [false, true]) {
  for (const natural of [false, true]) {
    test(`completion draws the final drag before switching (RTL=${rtl}, natural=${natural})`, () => {
      const s = setup({ rtl, natural });
      s.event("MozSwipeGestureStart");
      s.event("MozSwipeGestureUpdate", 0.4);
      s.event("MozSwipeGesture", 0, 2);
      assert.equal(s.calls.length, 1);
      assert.notEqual(s.calls[0][2], 0);
      assert.equal(s.switches.length, 1);
      assert.equal(s.switches[0][0], (rtl ? -1 : 1) * (natural ? -1 : 1));
      assert.equal(s.switches[0][1], true);
      s.event("MozSwipeGestureEnd");
      assert.equal(
        s.calls.length,
        1,
        "The release must not snap back before switching",
      );
      assert.equal(s.frames.size, 0);
    });
  }
}

test("rapid restart cannot apply the previous gesture's pending frame", () => {
  const s = setup();
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0.4);
  s.event("MozSwipeGestureStart");
  assert.equal(s.frames.size, 0);
  s.calls.length = 0;
  s.event("MozSwipeGestureUpdate", -0.2);
  s.paint();
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0][2] < 0);
});

for (const [count, active, visible] of [
  [6, 2, [1, 2, 3]],
  [6, 0, [0, 1, 5]],
  [6, 5, [0, 4, 5]],
  [2, 0, [0, 1]],
  [1, 0, [0]],
]) {
  test(`only the current space and neighbours are exposed (${count} spaces, index ${active})`, () => {
    const s = setup({ count, active });
    s.event("MozSwipeGestureStart");
    const shown = s.workspaces.flatMap((w, i) =>
      s.spaces.get(w.uuid).attributes.has("swipe-visible") ? [i] : [],
    );
    assert.deepEqual(shown, visible);
    s.event("MozSwipeGestureEnd");
    assert.ok(
      [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
    );
  });
}

test("library thresholds take effect immediately while its rendering is coalesced", () => {
  const s = setup();
  s.library.readySwipeOpenLibrary = () => true;
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", -0.1);
  s.event("MozSwipeGestureUpdate", -0.2);
  assert.equal(s.calls.length, 0);
  s.paint();
  assert.equal(s.calls.filter((c) => c[0] === "library").length, 1);
  s.event("MozSwipeGestureEnd");
});

test("Library drag resets the stationary workspace strips only once per gesture", () => {
  const s = setup();
  s.library.readySwipeOpenLibrary = () => true;
  s.event("MozSwipeGestureStart");
  for (const delta of [-0.1, -0.2, -0.3]) {
    s.event("MozSwipeGestureUpdate", delta);
    s.paint();
  }
  assert.equal(s.calls.filter((c) => c[0] === "library").length, 3);
  assert.equal(s.calls.filter((c) => c[0] !== "library").length, 1);
  s.event("MozSwipeGestureEnd");
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", -0.1);
  s.paint();
  assert.equal(s.calls.filter((c) => c[0] !== "library").length, 2);
  s.event("MozSwipeGestureEnd");
});

test("add-space uses the last raw progress and keeps its native success threshold", () => {
  const s = setup();
  s.add.ready = true;
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0.5);
  const event = s.event("MozSwipeGestureUpdate", 0.85);
  assert.equal(event.swipeSuccessThreshold, 0.8);
  assert.equal(event.swipeSuccessVelocityContribution, 0);
  assert.equal(s.add.starts, 1);
  s.paint();
  assert.deepEqual(s.add.progress, [0.85]);
  s.event("MozSwipeGesture", 0, 2);
  s.event("MozSwipeGestureEnd");
  assert.equal(s.add.ends, 1);
  assert.equal(s.add.cleanups, 1);
});

test("late completion without a gesture cannot change space", () => {
  const s = setup();
  s.event("MozSwipeGesture", 0, 2);
  assert.equal(s.switches.length, 0);
  assert.equal(s.calls.length, 0);
});

test("the background is prepared once per neighbour and refreshed when reversing", () => {
  const s = setup();
  vm.runInContext(
    "{\n" + managerSource.replace(/^import .*;$/gm, "") + "\n}",
    s.context,
  );
  const manager = s.context.window.gZenWorkspaces;
  manager.getWorkspaces = () => s.workspaces;
  manager.workspaceElement = (uuid) => s.spaces.get(uuid);
  manager.getActiveWorkspaceFromCache = () => s.workspaces[2];
  const noise = [];
  s.context.gZenThemePicker = {
    getGradientForWorkspace: (workspace) => ({
      gradient: workspace.uuid,
      toolbarGradient: workspace.uuid + "-toolbar",
      grain: 0,
    }),
    updateNoise: (value) => noise.push(value),
  };
  const current = s.workspaces[2];
  const background = s.nodes.get("zen-browser-background");
  for (const offset of [10, 20, 30]) {
    manager._organizeWorkspaceStripLocations(current, true, offset);
  }
  assert.equal(
    background.writes.filter(
      ([name]) => name === "--zen-main-browser-background-old",
    ).length,
    1,
  );
  manager._organizeWorkspaceStripLocations(current, true, -10);
  const gradients = background.writes
    .filter(([name]) => name === "--zen-main-browser-background-old")
    .map(([, value]) => value);
  assert.deepEqual(gradients, ["space-1", "space-3"]);
  manager._organizeWorkspaceStripLocations(current, true, 0);
  manager._organizeWorkspaceStripLocations(current, true, -10);
  assert.equal(
    background.writes.filter(
      ([name]) => name === "--zen-main-browser-background-old",
    ).length,
    3,
  );
  assert.ok(s.nav.attributes.has("animating-background"));
  manager._resetWorkspaceSwipe();
  assert.ok(!s.nav.attributes.has("animating-background"));
  assert.equal(
    noise.at(-1),
    0,
    "Cancelling restores the current space's grain",
  );
  assert.equal(s.spaces.get(current.uuid).style.transform, "translateX(0%)");
});

test("Library closing leaves stationary workspace input and tab styles untouched", () => {
  const s = setup();
  s.library.isLibraryOpen = true;
  let rebuilds = 0;
  s.ws.updateTabsContainers = () => rebuilds++;
  s.event("MozSwipeGestureStart");
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  assert.ok(
    [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
  );
  s.event("MozSwipeGestureUpdate", 0.03);
  s.paint();
  s.event("MozSwipeGesture", 0, 2);
  s.event("MozSwipeGestureEnd");
  assert.equal(rebuilds, 0);
  assert.equal(s.nodes.get("zen-browser-background").writes.length, 0);
  assert.equal(s.swipe.isGestureActive, false);
});

test("an edge Library opening does not prepare or clean up workspace visuals", () => {
  const s = setup({ active: 5 });
  s.library.readySwipeOpenLibrary = () => true;
  let rebuilds = 0;
  s.ws.updateTabsContainers = () => rebuilds++;
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", -0.03);
  s.paint();
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  assert.ok(
    [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
  );
  s.event("MozSwipeGestureEnd");
  assert.equal(rebuilds, 0);
  assert.equal(s.nodes.get("zen-toolbar-background").writes.length, 0);
});

test("an edge gesture toward a Space still prepares neighbours and restores them", () => {
  const s = setup({ active: 5 });
  s.library.readySwipeOpenLibrary = () => true;
  let rebuilds = 0;
  s.ws.updateTabsContainers = () => rebuilds++;
  s.event("MozSwipeGestureStart");
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  s.event("MozSwipeGestureUpdate", 0.03);
  assert.ok(s.nav.attributes.has("swipe-gesture"));
  assert.deepEqual(
    s.workspaces.flatMap((w, i) =>
      s.spaces.get(w.uuid).attributes.has("swipe-visible") ? [i] : [],
    ),
    [0, 4, 5],
  );
  s.event("MozSwipeGestureEnd");
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  assert.ok(
    [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
  );
  assert.equal(rebuilds, 1);
});

test("a new Library gesture cleans up the interrupted Space gesture once", () => {
  const s = setup();
  let rebuilds = 0;
  s.ws.updateTabsContainers = () => rebuilds++;
  s.event("MozSwipeGestureStart");
  assert.ok(s.nav.attributes.has("swipe-gesture"));
  s.library.isLibraryOpen = true;
  s.event("MozSwipeGestureStart");
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  assert.ok(
    [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
  );
  s.event("MozSwipeGestureEnd");
  assert.equal(rebuilds, 1);
});

test("a zero-delta edge update does not prepare stationary workspace visuals", () => {
  const s = setup({ active: 5 });
  s.library.readySwipeOpenLibrary = () => true;
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0);
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  assert.ok(
    [...s.spaces.values()].every((e) => !e.attributes.has("swipe-visible")),
  );
  s.event("MozSwipeGestureUpdate", -0.03);
  s.paint();
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
  s.event("MozSwipeGestureEnd");
});

test("a hover tooltip cannot cancel an active Library gesture", () => {
  const s = setup();
  s.library.isLibraryOpen = true;
  let cleanups = 0;
  s.library.swipeAnimationEnd = () => cleanups++;
  s.event("MozSwipeGestureStart");
  s.event("MozSwipeGestureUpdate", 0.03);
  s.event("popupshown", 0, 0, { localName: "tooltip" });
  assert.equal(s.swipe.isGestureActive, true);
  assert.equal(cleanups, 0);
  s.paint();
  assert.ok(s.calls.some((call) => call[0] === "library"));
  s.event("MozSwipeGestureEnd");
  assert.equal(cleanups, 1);
  assert.ok(!s.document.listeners.has("popupshown"));
});

test("a menu after a tooltip still interrupts the gesture and removes its listener", () => {
  const s = setup();
  s.event("MozSwipeGestureStart");
  const listener = s.document.listeners.get("popupshown");
  assert.equal(listener.once, undefined);
  s.event("popupshown", 0, 0, { localName: "tooltip" });
  assert.ok(s.document.listeners.has("popupshown"));
  s.event("popupshown", 0, 0, { localName: "menupopup" });
  assert.equal(s.swipe.isGestureActive, false);
  assert.ok(!s.document.listeners.has("popupshown"));
  assert.ok(!s.nav.attributes.has("swipe-gesture"));
});
