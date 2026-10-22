// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as policy from "../../src/zen/space-routing/ZenSpaceRoutingPolicy.sys.mjs";

const modules = {};
let classify = async () => ({ reason: "disabled", spaceId: null });
let windows = [];
let latest;
globalThis.ChromeUtils = {
  defineESModuleGetters(target, entries) {
    for (const name of Object.keys(entries)) {
      Object.defineProperty(target, name, { get: () => modules[name] });
    }
  },
};
globalThis.PathUtils = {
  profileDir: "/synthetic",
  join: (...parts) => parts.join("/"),
};
globalThis.Services = { wm: { getMostRecentWindow: () => latest } };
modules.PrivateBrowsingUtils = { isWindowPrivate: win => !!win.private };
modules.BrowserWindowTracker = {
  getOrderedWindows: () => windows.filter(win => !win.private),
};
modules.gZenSpaceRoutingAI = { classify: (...args) => classify(...args) };
globalThis.routingPolicy = policy;
const asModule = text =>
  `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const jsonFileModule = asModule(`export class JSONFile {
  constructor({dataPostProcessor}) { this.data = dataPostProcessor({}); }
  async load() {}
  saveSoon() {}
}`);
const policyModule = asModule(
  "export const { fallbackSpace, matchURLMask } = globalThis.routingPolicy;"
);
const source = (
  await readFile(
    new URL(
      "../../src/zen/space-routing/ZenSpaceRoutingManager.sys.mjs",
      import.meta.url
    ),
    "utf8"
  )
)
  .replace("resource://gre/modules/JSONFile.sys.mjs", jsonFileModule)
  .replace("resource://gre/modules/Timer.sys.mjs", "node:timers")
  .replace(
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingPolicy.sys.mjs",
    policyModule
  );
const { nsZenSpaceRoutingManager: Manager } = await import(
  asModule(source + "\nexport { nsZenSpaceRoutingManager };")
);

function setup() {
  const manager = new Manager();
  const win = new EventTarget();
  win.closed = false;
  win.toolbar = { visible: true };
  win.gZenStartup = { isReady: true };
  const spaces = [
    { uuid: "first", name: "Common", containerTabId: 0 },
    { uuid: "work", name: "Work", containerTabId: 4 },
  ];
  win.gZenWorkspaces = {
    workspaceEnabled: true,
    activeWorkspace: "first",
    getWorkspaces: () => spaces,
    getWorkspaceFromId: id => spaces.find(space => space.uuid === id),
    lastSelectedWorkspaceTabs: {},
    moveTabToWorkspace() {},
    async changeWorkspace() {},
  };
  classify = async () => ({ reason: "disabled", spaceId: null });
  windows = [win];
  latest = win;
  return { manager, win, spaces };
}
function rule(manager, reference, openIn) {
  const route = manager.createNewRoute();
  Object.assign(route, { reference, openIn });
  manager.updateRoute(route);
  return route;
}

test("first match including explicit most-recent is final and never invokes Jev", async () => {
  const { manager, win } = setup();
  await manager.ready;
  win.gZenWorkspaces.activeWorkspace = "work";
  rule(manager, "github.com", "most-recent-space");
  rule(manager, "github.com", "first");
  classify = () => assert.fail("rules must bypass AI");
  assert.equal(
    (await manager.resolveExternalURI("https://github.com/Onigo/x", win))
      .spaceId,
    "work"
  );
});

test("rule ordering is stable, bounded and changes the winner", async () => {
  const { manager } = setup();
  await manager.ready;
  const a = rule(manager, "github", "first"),
    b = rule(manager, "github", "work");
  assert.equal(manager.routeUri("https://github.com", {}), "first");
  assert.equal(manager.moveRoute(b.id, -1), true);
  assert.equal(manager.routeUri("https://github.com", {}), "work");
  assert.equal(manager.moveRoute(b.id, -1), false);
  assert.equal(manager.moveRoute(a.id, 2), false);
  assert.equal(manager.moveRoute("missing", 1), false);
});

test("AI failures and deleted explicit destinations use the configured fallback", async () => {
  const { manager, win } = setup();
  await manager.ready;
  manager.setDefaultExternalRoute("work");
  for (const reason of [
    "disabled",
    "timeout",
    "invalid-key",
    "uncertain",
    "busy",
  ]) {
    classify = async () => ({ reason, spaceId: null });
    const result = await manager.resolveExternalURI("https://example.com", win);
    assert.equal(result.spaceId, "work");
    assert.equal(result.reason, reason);
  }
  rule(manager, "example.com", "deleted");
  assert.equal(
    (await manager.resolveExternalURI("https://example.com", win)).spaceId,
    "work"
  );
});

test("private windows and disabled Spaces never invoke Jev", async () => {
  const { manager, win } = setup();
  await manager.ready;
  classify = () => assert.fail("private request");
  win.private = true;
  assert.equal(
    (await manager.resolveExternalURI("https://example.com", win)).reason,
    "excluded-window"
  );
  win.private = false;
  win.gZenWorkspaces.workspaceEnabled = false;
  assert.equal(
    (await manager.resolveExternalURI("https://example.com", win)).spaceId,
    null
  );
});

test("a removed or renamed space invalidates an in-flight decision", async () => {
  for (const mutation of [
    spaces => spaces.pop(),
    spaces => {
      spaces[1].name = "Renamed";
    },
    spaces => spaces.reverse(),
  ]) {
    const { manager, win, spaces } = setup();
    await manager.ready;
    let release;
    classify = () =>
      new Promise(resolve => {
        release = resolve;
      });
    const result = manager.resolveExternalURI("https://example.com", win);
    await Promise.resolve();
    mutation(spaces);
    release({ reason: "jev", spaceId: "work" });
    const actual = await result;
    assert.equal(actual.reason, "settings-changed");
    assert.equal(actual.spaceId, spaces[0].uuid);
  }
});

test("rule edits invalidate an in-flight classification", async () => {
  const { manager, win } = setup();
  await manager.ready;
  let release;
  classify = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const result = manager.resolveExternalURI("https://example.com", win);
  await Promise.resolve();
  rule(manager, "github", "work");
  release({ reason: "jev", spaceId: "work" });
  assert.equal((await result).reason, "settings-changed");
});

test("the same resolved destination supplies the initial tab container and is not recomputed", async () => {
  const { manager, win } = setup();
  await manager.ready;
  classify = async () => ({ reason: "jev", spaceId: "work" });
  let count = 0;
  const uri = { spec: "https://example.com/?original=preserved#fragment" };
  await manager.openExternalURI(uri, win, (target, routed) => {
    count++;
    assert.equal(target, win);
    assert.equal(routed, true);
    const decision = manager.onBeforeAddTab(
      uri.spec,
      { fromExternal: true },
      win
    );
    assert.equal(decision.targetRoute, "work");
    assert.equal(decision.userContextId, 4);
  });
  assert.equal(count, 1);
  assert.equal(
    manager.onBeforeAddTab(uri.spec, { fromExternal: true }, win).targetRoute,
    "first"
  );
});

test("opening failures are never retried after an unknown native outcome", async () => {
  const { manager, win } = setup();
  await manager.ready;
  let count = 0;
  await manager.openExternalURI({ spec: "https://example.com" }, win, () => {
    count++;
    throw Error("after open");
  });
  assert.equal(count, 1);
});

test("independent external opens of an identical URL do not overwrite one another", async () => {
  const { manager, win } = setup();
  await manager.ready;
  const releases = [];
  classify = () => new Promise(resolve => releases.push(resolve));
  const decisions = [];
  const open = () =>
    manager.openExternalURI({ spec: "https://example.com" }, win, target => {
      decisions.push(
        manager.onBeforeAddTab(
          "https://example.com",
          { fromExternal: true },
          target
        ).targetRoute
      );
    });
  const a = open(),
    b = open();
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  releases[1]({ reason: "jev", spaceId: "work" });
  releases[0]({ reason: "uncertain", spaceId: null });
  await Promise.all([a, b]);
  assert.deepEqual(decisions, ["work", "first"]);
});

test("waits for cold startup and cancels when the source window closes", async () => {
  const { manager, win } = setup();
  await manager.ready;
  win.gZenStartup.isReady = false;
  let calls = 0;
  const pending = manager.openExternalURI(
    { spec: "https://example.com" },
    Promise.resolve(win),
    () => calls++
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  win.gZenStartup.isReady = true;
  await pending;
  assert.equal(calls, 1);
  let release;
  classify = () =>
    new Promise(resolve => {
      release = resolve;
    });
  const cancelled = manager.openExternalURI(
    { spec: "https://example.com" },
    win,
    () => calls++
  );
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  win.closed = true;
  release({ reason: "jev", spaceId: "work" });
  await cancelled;
  assert.equal(calls, 1);
});

test("replacing the early blank document does not bypass cold startup readiness", async () => {
  const { manager, win } = setup();
  await manager.ready;
  win.gZenStartup.isReady = false;
  let calls = 0;
  const pending = manager.openExternalURI(
    { spec: "https://example.com" },
    win,
    () => calls++
  );
  await new Promise(resolve => setTimeout(resolve, 30));
  // Firefox replaces its early blank chrome document before browser.xhtml is
  // ready. That unload is not a closed browser window.
  win.dispatchEvent(new Event("unload"));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 0, "The native open must still wait for browser startup");
  win.gZenStartup.isReady = true;
  await pending;
  assert.equal(calls, 1);
});

test("prefers a normal window already displaying the resolved Space", async () => {
  const { manager, win } = setup();
  await manager.ready;
  const other = {
    closed: false,
    toolbar: { visible: true },
    gZenStartup: { isReady: true },
    gZenWorkspaces: { workspaceEnabled: true, activeWorkspace: "work" },
  };
  windows.push(other);
  assert.equal(
    manager.getWindowForExternalUri(
      { spec: "https://example.com" },
      win,
      "work"
    ),
    other
  );
  other.private = true;
  assert.equal(
    manager.getWindowForExternalUri(
      { spec: "https://example.com" },
      win,
      "work"
    ),
    win
  );
});
