import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/spaces/ZenSpaceManager.mjs", import.meta.url),
  "utf8",
);

function setup({
  multiselected = false,
  activeMoved = false,
  reverse = false,
} = {}) {
  const active = { id: "active" };
  const background = { id: "background", multiselected };
  const existing = { id: "destination-selection" };
  const browser = {
    selectedTab: active,
    selectedTabs: activeMoved ? [active, background] : [background],
  };
  const moved = [];
  const switched = [];
  let closed = false;
  const context = vm.createContext({
    window: {},
    ChromeUtils: { defineESModuleGetters() {}, defineLazyGetter() {} },
    Services: { prefs: { getBoolPref: () => false } },
    TabContextMenu: {
      contextTab: activeMoved && !multiselected ? active : background,
    },
    gBrowser: browser,
    gZenGlanceManager: { getTabOrGlanceParent: (tab) => tab.parent ?? tab },
    document: {
      getElementById: () => ({
        hidePopup: () => {
          closed = true;
        },
      }),
    },
  });
  // Execute the complete canonical class with only platform boundaries mocked.
  vm.runInContext(source.replace(/^import .*;$/gm, ""), context);
  const manager = context.window.gZenWorkspaces;
  manager.lastSelectedWorkspaceTabs.destination = existing;
  manager.getWorkspaces = () => [{ uuid: "destination" }];
  manager.moveTabsToWorkspace = (tabs, id) => {
    assert.ok(closed, "The context menu closes before moving tabs");
    if (reverse) {
      tabs.reverse(); // Existing top-placement preference reverses this array.
    }
    moved.push(...tabs);
    for (const tab of tabs) {
      tab.space = id;
    }
  };
  manager.changeWorkspace = async (workspace) => {
    switched.push(workspace.uuid);
    browser.selectedTab = manager.lastSelectedWorkspaceTabs[workspace.uuid];
  };
  return { manager, browser, active, background, existing, moved, switched };
}

test("moving a background tab preserves both selections and the destination's remembered tab", async () => {
  const state = setup();
  await state.manager.changeTabWorkspace("destination");
  assert.equal(state.background.space, "destination");
  assert.deepEqual(state.switched, []);
  assert.equal(state.browser.selectedTab, state.active);
  assert.equal(
    state.manager.lastSelectedWorkspaceTabs.destination,
    state.existing,
  );
});

test("moving the active tab follows it to the destination", async () => {
  const state = setup({ activeMoved: true });
  await state.manager.changeTabWorkspace("destination");
  assert.equal(state.active.space, "destination");
  assert.deepEqual(state.switched, ["destination"]);
  assert.equal(state.browser.selectedTab, state.active);
});

test("a background-only multiselection moves without switching", async () => {
  const state = setup({ multiselected: true });
  const second = { id: "second-background" };
  state.browser.selectedTabs.push(second);
  await state.manager.changeTabWorkspace("destination");
  assert.deepEqual(state.moved, [state.background, second]);
  assert.equal(second.space, "destination");
  assert.deepEqual(state.switched, []);
  assert.equal(state.browser.selectedTab, state.active);
});

for (const reverse of [false, true]) {
  test(`multiselection follows the active tab regardless of placement order (reverse=${reverse})`, async () => {
    const state = setup({ multiselected: true, activeMoved: true, reverse });
    await state.manager.changeTabWorkspace("destination");
    assert.equal(state.active.space, "destination");
    assert.equal(state.background.space, "destination");
    assert.deepEqual(state.switched, ["destination"]);
    assert.equal(state.browser.selectedTab, state.active);
  });
}

test("an active Glance tab follows its parent into the destination", async () => {
  const state = setup({ activeMoved: true });
  const parent = { id: "glance-parent" };
  state.active.parent = parent;
  await state.manager.changeTabWorkspace("destination");
  assert.deepEqual(state.switched, ["destination"]);
  assert.equal(state.manager.lastSelectedWorkspaceTabs.destination, parent);
});
