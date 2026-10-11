import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL(
    "../../src/zen/library/sections/ZenLibrarySpacesSection.mjs",
    import.meta.url,
  ),
  "utf8",
);

function setup(open = false) {
  let reads = 0,
    watched = 0,
    widthWrites = 0;
  const listeners = new Map(),
    timers = new Map();
  let intersection;
  const strip = {
    childElementCount: 0,
    replaceChildren() {
      this.childElementCount = 0;
    },
  };
  const body = {
    scrollHeight: 200,
    clientHeight: 100,
    scrollTop: 0,
    toggleAttribute() {},
  };
  const card = {
    dataset: { uuid: "space" },
    offsetLeft: 0,
    offsetWidth: 300,
    querySelector: (selector) =>
      selector === ".zen-library-space-tabs" ? strip : body,
  };
  const list = {};
  const attributes = new Set(open ? ["open"] : []);
  const library = {
    hasAttribute: (key) => attributes.has(key),
    setAttribute: (key) => attributes.add(key),
    removeAttribute: (key) => attributes.delete(key),
    querySelector: () => ({}),
    addEventListener() {},
    removeEventListener() {},
    style: {
      getPropertyValue: () => "",
      setProperty() {
        widthWrites++;
      },
      removeProperty() {},
    },
  };
  const context = vm.createContext({
    window: {
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener() {},
      setTimeout: (callback) => {
        timers.set(timers.size + 1, callback);
        return timers.size;
      },
      clearTimeout: (id) => timers.delete(id),
      windowUtils: { getBoundsWithoutFlushing: () => ({ width: 110 }) },
      getComputedStyle: () => ({ paddingLeft: "0px", paddingRight: "0px" }),
    },
    document: {},
    customElements: { define() {} },
    MozLitElement: class {
      updated() {}
      connectedCallback() {}
      disconnectedCallback() {}
      requestUpdate() {}
      contains() {
        return false;
      }
      addEventListener() {}
      removeEventListener() {}
      querySelectorAll() {
        return [card];
      }
      querySelector() {
        return list;
      }
    },
    ZenLibraryDragAndDrop: class {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      constructor(callback) {
        intersection = callback;
      }
      observe() {
        watched++;
      }
      disconnect() {}
    },
    Services: { obs: { addObserver() {}, removeObserver() {} } },
    gZenWorkspaces: {
      activeWorkspace: "space",
      workspaceElement() {
        reads++;
        return null;
      },
    },
    setTimeout: (callback) => {
      timers.set(timers.size + 1, callback);
      return timers.size;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(
    source
      .replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "")
      .replace("export class", "class") +
      "\nwindow.section = new ZenLibrarySpacesSection();",
    context,
  );
  const section = context.window.section;
  section.library = library;
  section.hidden = false;
  return {
    section,
    attributes,
    listeners,
    timers,
    reads: () => reads,
    watched: () => watched,
    widthWrites: () => widthWrites,
    intersect: () => intersection([{ isIntersecting: true, target: card }]),
  };
}

test("workspace updates while Library is closed do not rebuild hidden tab copies", () => {
  const s = setup();
  s.section.updated(new Map());
  s.section.onShown();
  assert.equal(s.reads(), 0);
  assert.equal(s.watched(), 0);
  assert.equal(s.widthWrites(), 0);
  s.attributes.add("open");
  s.section.onLibraryOpening();
  s.section.updated(new Map());
  assert.ok(s.reads() > 0, "Opening must still build the actual Space");
  assert.ok(s.watched() > 0);
  assert.ok(s.widthWrites() > 0);
});

test("an intersection queued before closing cannot recreate cleared rows", () => {
  const s = setup(true);
  s.section.onLibraryOpening();
  s.attributes.delete("open");
  s.section.onLibraryClosing();
  const reads = s.reads();
  s.intersect();
  assert.equal(s.reads(), reads);
});

test("hidden strip events do not schedule rebuilds, but visible tab changes do", () => {
  const s = setup();
  s.section.connectedCallback();
  const changed = s.listeners.get("TabAttrModified");
  const event = {
    type: "TabAttrModified",
    detail: { changed: ["label"] },
    target: { getAttribute: () => "space" },
  };
  changed(event);
  assert.equal(s.timers.size, 0);
  s.attributes.add("open");
  changed(event);
  assert.equal(s.timers.size, 1);
});
