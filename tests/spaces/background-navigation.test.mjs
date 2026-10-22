import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/spaces/ZenSpaceManager.mjs", import.meta.url),
  "utf8"
);
function setup() {
  const tab = (id, space, extra = {}) => ({
    id,
    attributes: { "zen-workspace-id": space, ...extra },
    hasAttribute(name) {
      return Object.hasOwn(this.attributes, name);
    },
    getAttribute(name) {
      return this.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
  });
  const active = tab("active", "here");
  const background = tab("background", "there");
  const browser = { selectedTab: active };
  const scheduled = [];
  const context = vm.createContext({
    window: {},
    setTimeout: callback => scheduled.push(callback),
    ChromeUtils: { defineESModuleGetters() {}, defineLazyGetter() {} },
    Services: { prefs: { getBoolPref: () => false } },
    gBrowser: browser,
    document: { documentElement: { setAttribute() {} } },
    gZenCompactModeManager: { sidebar: { toggleAttribute() {} } },
    gZenGlanceManager: { getTabOrGlanceParent: item => item.parent ?? item },
  });
  vm.runInContext(source.replace(/^import .*;$/gm, ""), context);
  const manager = context.window.gZenWorkspaces;
  Object.defineProperty(manager, "workspaceEnabled", { value: true });
  Object.defineProperty(manager, "activeWorkspace", { value: "here" });
  manager._hasInitializedTabsStrip = true;
  manager.getActiveWorkspace = () => ({ uuid: "here" });
  manager.getWorkspaceFromId = uuid => ({ uuid });
  manager.lastSelectedWorkspaceTabs.here = active;
  const switched = [];
  manager.changeWorkspace = async space => switched.push(space.uuid);
  return { manager, browser, active, background, tab, switched, scheduled };
}

test("a background navigation in another Space preserves the current selection", async () => {
  const s = setup();
  await s.manager.onLocationChange({ target: s.background });
  assert.deepEqual(s.switched, []);
  assert.equal(s.browser.selectedTab, s.active);
});
test("a background navigation in the current Space does not replace its remembered tab", async () => {
  const s = setup();
  s.background.attributes["zen-workspace-id"] = "here";
  await s.manager.onLocationChange({ target: s.background });
  assert.equal(s.manager.lastSelectedWorkspaceTabs.here, s.active);
});
test("navigation of the selected tab still follows its assigned Space", async () => {
  const s = setup();
  s.browser.selectedTab = s.background;
  await s.manager.onLocationChange({ target: s.background });
  assert.deepEqual(s.switched, ["there"]);
});
test("a selected Glance parent still follows navigation in its child", async () => {
  const s = setup();
  s.active.attributes["zen-workspace-id"] = "there";
  const glance = s.tab("glance", "there", { "zen-glance-tab": "true" });
  glance.parentNode = { closest: () => s.active };
  await s.manager.onLocationChange({ target: glance });
  assert.deepEqual(s.switched, ["there"]);
});

test("inserting an eager background browser places it without scheduling a Space switch", async () => {
  const s = setup();
  s.background.attributes["change-workspace"] = "";
  const placed = [];
  s.manager.moveTabToWorkspace = (tab, id) => {
    placed.push(id);
    return true;
  };
  await s.manager.onTabBrowserInserted({ originalTarget: s.background });
  assert.deepEqual(placed, ["there"]);
  assert.deepEqual(s.switched, []);
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.background.hasAttribute("change-workspace"), false);
});
test("a deferred foreground insertion cannot steal focus after the user selects another tab", async () => {
  const s = setup();
  s.background.attributes["change-workspace"] = "";
  s.browser.selectedTab = s.background;
  s.manager.moveTabToWorkspace = () => true;
  await s.manager.onTabBrowserInserted({ originalTarget: s.background });
  assert.equal(s.scheduled.length, 1);
  s.browser.selectedTab = s.active;
  s.scheduled[0]();
  assert.deepEqual(s.switched, []);
});
