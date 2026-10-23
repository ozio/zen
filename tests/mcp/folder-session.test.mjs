import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
  new URL("../../src/zen/folders/ZenFolders.mjs", import.meta.url),
  "utf8"
);

class Node {
  constructor(id, kind = "box") {
    this.id = id;
    this.kind = kind;
    this.classList = { contains: name => name === kind };
    this.children = [];
    this.parentElement = null;
    this.label = { addEventListener() {} };
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get nextElementSibling() {
    return (
      this.parentElement?.children[
        this.parentElement.children.indexOf(this) + 1
      ] ?? null
    );
  }
  contains(item) {
    return item === this || this.children.some(child => child.contains(item));
  }
  insertBefore(item, anchor = null) {
    item.remove();
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert.ok(index >= 0);
    this.children.splice(index, 0, item);
    item.parentElement = this;
  }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  before(item) {
    this.parentElement.insertBefore(item, this);
  }
  after(item) {
    this.parentElement.insertBefore(item, this.nextElementSibling);
  }
  querySelector(selector) {
    if (selector === ".tab-group-label-container") {
      return this.label;
    }
    return (
      this.children.find(child => selector.includes(child.kind)) ??
      this.children.map(child => child.querySelector(selector)).find(Boolean) ??
      null
    );
  }
}

function setup() {
  const byId = new Map();
  const spaces = new Map();
  for (const id of ["research", "archive"]) {
    const pinned = new Node(id);
    pinned.insertBefore(new Node(`${id}-start`, "zen-tab-group-start"));
    pinned.insertBefore(
      new Node(`${id}-end`, "pinned-tabs-container-separator")
    );
    spaces.set(id, {
      pinnedTabsContainer: pinned,
      tabsContainer: new Node(`${id}-normal`),
    });
  }
  const adds = [];
  const context = vm.createContext({
    window: {},
    nsZenDOMOperatedFeature: class {},
    Services: {
      prefs: { getIntPref: () => 5, getBoolPref: () => false },
      scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    },
    gZenWorkspaces: {
      activeWorkspace: "archive",
      workspaceElement: id => spaces.get(id),
      pinnedTabsContainer: spaces.get("archive").pinnedTabsContainer,
    },
    document: { getElementById: id => byId.get(id) ?? null },
    gBrowser: {
      addTab(url, options) {
        adds.push({ url, options });
        return new Node("empty", "tab");
      },
      pinTab(tab) {
        tab.pinned = true;
      },
      TabStateFlusher: { flush() {} },
    },
    gZenVerticalTabsManager: { animateItemOpen() {} },
  });
  vm.runInContext(source.replace(/^import .*;$/gm, ""), context);
  const manager = context.window.gZenFolders;
  manager.updateFolderIcon = () => {};
  manager._createFolderNode = options => {
    const node = new Node(options.id ?? "folder", "folder");
    node.pinned = true;
    node.tabs = [];
    node.addTabs = tabs => {
      node.tabs.push(...tabs);
      for (const tab of tabs) node.insertBefore(tab);
    };
    return node;
  };
  const add = (id, space = "research", kind = "tab") => {
    const node = new Node(id, kind);
    node.pinned = true;
    byId.set(id, node);
    const container = spaces.get(space).pinnedTabsContainer;
    container.insertBefore(node, container.children.at(-1));
    return node;
  };
  return { manager, spaces, adds, add };
}

test("creating a folder in an inactive Space assigns that Space to its empty placeholder", () => {
  const e = setup();
  const folder = e.manager.createFolder([], { workspaceId: "research" });
  assert.equal(e.adds[0].options.zenWorkspaceId, "research");
  assert.equal(
    folder.parentElement,
    e.spaces.get("research").pinnedTabsContainer
  );
  assert.equal(folder.tabs.length, 1);
});

test("session restore repairs a root folder's physical Space and saved sibling position", () => {
  const e = setup();
  const first = e.add("first");
  const last = e.add("last");
  const folder = e.add("folder", "archive", "folder");
  e.manager.restoreFolderPlacement(folder, {
    workspaceId: "research",
    parentId: null,
    prevSiblingInfo: { id: first.id },
  });
  assert.deepEqual(
    e.spaces.get("research").pinnedTabsContainer.children.map(x => x.id),
    ["research-start", first.id, folder.id, last.id, "research-end"]
  );
});

test("a stale sibling in another Space cannot redirect folder recovery", () => {
  const e = setup();
  const other = e.add("other", "archive");
  e.add("first");
  const folder = e.add("folder", "archive", "folder");
  e.manager.restoreFolderPlacement(folder, {
    workspaceId: "research",
    parentId: null,
    prevSiblingInfo: { id: other.id },
  });
  assert.equal(
    folder.parentElement,
    e.spaces.get("research").pinnedTabsContainer
  );
  assert.equal(folder.parentElement.children[1], folder);
});

test("a nested folder's start marker cannot become the Space insertion anchor", () => {
  const e = setup();
  const target = e.spaces.get("research").pinnedTabsContainer;
  target.children[0].remove();
  const sibling = e.add("sibling", "research", "folder");
  sibling.insertBefore(new Node("nested-start", "zen-tab-group-start"));
  sibling.insertBefore(new Node("nested-pin", "tab"));
  const folder = e.add("restored", "archive", "folder");
  e.manager.restoreFolderPlacement(folder, {
    workspaceId: "research",
    parentId: null,
  });
  assert.equal(folder.parentElement, target);
  assert.equal(target.firstElementChild, folder);
  assert.equal(sibling.children.length, 2);
});

test("session placement preserves nested folders and already-correct root order", () => {
  const e = setup();
  const parent = e.add("parent", "research", "folder");
  const child = new Node("child", "folder");
  parent.insertBefore(child);
  e.manager.restoreFolderPlacement(child, {
    workspaceId: "research",
    parentId: parent.id,
  });
  assert.equal(child.parentElement, parent);
  const before = [...parent.parentElement.children];
  e.manager.restoreFolderPlacement(parent, {
    workspaceId: "research",
    parentId: null,
  });
  assert.deepEqual(parent.parentElement.children, before);
});
