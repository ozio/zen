import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/spaces/ZenSpaceManager.mjs", import.meta.url),
  "utf8",
);

function setup({ continueSession = true, firefoxView = false } = {}) {
  function tab(id, space) {
    const attributes = new Map([["zen-workspace-id", space]]);
    return {
      id,
      collapsed: false,
      hasAttribute: (name) => attributes.has(name),
      getAttribute: (name) => attributes.get(name) ?? null,
    };
  }
  const otherPinned = tab("other-space-pin", "alpha");
  const empty = tab("empty", "beta");
  const expected = tab("previously-selected", "beta");
  const neighbour = tab("neighbour", "beta");
  const startup = tab("startup-placeholder", "beta");
  const view = tab("firefox-view", "beta");
  const browser = {
    tabs: [empty, expected, neighbour, startup],
    selectedTab: startup,
    removeTab: (item) => removed.push(item),
  };
  const removed = [];
  const events = [];
  const context = vm.createContext({
    window: {
      FirefoxViewHandler: { tab: firefoxView ? view : null },
      addEventListener() {},
      dispatchEvent: (event) => events.push(event.type),
    },
    ChromeUtils: { defineESModuleGetters() {}, defineLazyGetter() {} },
    Services: {
      prefs: {
        getBoolPref: (name) =>
          name === "zen.workspaces.continue-where-left-off"
            ? continueSession
            : false,
      },
    },
    gBrowser: browser,
    gBrowserInit: { uriToLoadPromise: Promise.resolve("about:blank") },
    delayedStartupPromise: Promise.resolve(),
    gZenUIManager: { testingEnabled: false },
    gZenVerticalTabsManager: { _canReplaceNewTab: true },
    gZenGlanceManager: { getTabOrGlanceParent: (item) => item.parent ?? item },
    isInitialPage: () => true,
    setTimeout: () => 1,
    clearTimeout() {},
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
  });
  // Run the complete canonical class; only Firefox/platform boundaries are mocked.
  vm.runInContext(source.replace(/^import .*;$/gm, ""), context);
  const manager = context.window.gZenWorkspaces;
  Object.defineProperty(manager, "workspaceEnabled", { value: true });
  Object.defineProperty(manager, "activeWorkspace", { value: "beta" });
  manager.getWorkspaces = () => [{ uuid: "beta", containerTabId: 0 }];
  manager._allStoredTabs = [otherPinned, empty, expected, neighbour];
  if (firefoxView) {
    manager._allStoredTabs.splice(1, 0, view);
  }
  manager._sessionSelected = 3; // Existing one-based index in serialized tabs.
  manager._tabToRemoveForEmpty = startup;
  manager._emptyTab = empty;
  manager.selectEmptyTab = () => {
    browser.selectedTab = empty;
  };
  return {
    manager,
    browser,
    expected,
    neighbour,
    empty,
    startup,
    removed,
    events,
  };
}

test("resume selects the saved tab when another Space has a pinned tab", async () => {
  const state = setup();
  await state.manager.selectStartPage();
  assert.equal(state.browser.selectedTab, state.expected);
  assert.deepEqual(state.removed, [state.startup]);
  assert.deepEqual(state.events, ["AfterWorkspacesSessionRestore"]);
  assert.equal(state.manager._sessionSelected, undefined);
  await state.manager.selectStartPage();
  assert.deepEqual(
    state.removed,
    [state.startup],
    "Startup selection runs once",
  );
});

test("resume ignores Firefox View because it has no serialized session row", async () => {
  const state = setup({ firefoxView: true });
  await state.manager.selectStartPage();
  assert.equal(state.browser.selectedTab, state.expected);
});

test("non-resume startup retains the visible-tab selection contract", async () => {
  const state = setup({ continueSession: false });
  state.manager._tabToSelect = 1;
  await state.manager.selectStartPage();
  assert.equal(state.browser.selectedTab, state.expected);
});

test("a saved tab in another Space still falls back to the empty tab", async () => {
  const state = setup();
  state.manager._sessionSelected = 1;
  await state.manager.selectStartPage();
  assert.equal(state.browser.selectedTab, state.empty);
  assert.deepEqual(state.removed, [state.startup]);
});
