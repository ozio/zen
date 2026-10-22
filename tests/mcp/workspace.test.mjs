// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import test from "node:test";

// Execute the actual modules and disposable worker with native browser fakes.
// This checks provider behavior, not packaged Gecko acceptance.
const mocks = {};
globalThis.ChromeUtils = {
  defineESModuleGetters(object, names) {
    for (const name of Object.keys(names)) {
      Object.defineProperty(object, name, { get: () => mocks[name] });
    }
  },
};
globalThis.Services = {
  uuid: { generateUUID: () => `{${randomUUID()}}` },
  io: {
    newURI: value => {
      assert.equal(typeof value, "string");
      return new URL(value);
    },
  },
  eTLD: {
    getBaseDomainFromHost: host => host.split(".").slice(-2).join("."),
  },
  prefs: { getIntPref: () => 5 },
  scriptSecurityManager: { getSystemPrincipal: () => ({ system: true }) },
};
const moduleURL = text =>
  `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const load = name =>
  readFile(new URL(`../../src/zen/mcp/${name}`, import.meta.url), "utf8");
const utilsURL = moduleURL(await load("ZenMcpUtils.sys.mjs"));
const queryURL = moduleURL(
  (await load("ZenMcpTabQuery.sys.mjs")).replace(
    "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs",
    utilsURL
  )
);
const providerURL = moduleURL(
  (await load("ZenMcpWorkspaceTools.sys.mjs"))
    .replace("resource://gre/modules/Timer.sys.mjs", "node:timers")
    .replace("resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs", utilsURL)
    .replace("resource:///modules/zen/mcp/ZenMcpTabQuery.sys.mjs", queryURL)
);
const workerURL = moduleURL(
  (await load("ZenMcpLambdaWorker.sys.mjs")).replace(
    "./ZenMcpTabQuery.sys.mjs",
    queryURL
  )
);
const { ZenMcpWorkspaceTools } = await import(providerURL);
const { filterTabs, sortTabs } = await import(queryURL);

function realWorker(source) {
  const entryURL = moduleURL(
    source.replace(
      "resource:///modules/zen/mcp/ZenMcpLambdaWorker.sys.mjs",
      workerURL
    )
  );
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    const handlers = [];
    let ready = false;
    const pending = [];
    globalThis.postMessage = data => parentPort.postMessage(data);
    globalThis.addEventListener = (name, fn) => handlers.push(fn);
    parentPort.on('message', data => ready ? handlers.forEach(fn => fn({data})) : pending.push(data));
    import(${JSON.stringify(entryURL)}).then(() => { ready = true; pending.forEach(data => handlers.forEach(fn => fn({data}))); });
  `,
    { eval: true }
  );
  const api = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: data => worker.postMessage(data),
    terminate() {
      api.terminated = true;
      void worker.terminate();
    },
  };
  worker.on("message", data => api.onmessage?.({ data }));
  worker.on("error", error => {
    process.stderr.write(`Worker failed: ${error.message.slice(0, 300)}\n`);
    api.onerror?.(error);
  });
  return api;
}

const client = { id: "workspace-tests" };
const identity = { instanceId: "epoch" };
class Element {
  constructor(win, localName, attrs = {}) {
    this.ownerGlobal = this.documentGlobal = win;
    this.localName = localName;
    this.attrs = new Map(Object.entries(attrs));
    this.children = [];
    this.parentElement = null;
    this.classList = { contains: () => false };
  }
  getAttribute(key) {
    return this.attrs.get(key) ?? "";
  }
  setAttribute(key, value) {
    this.attrs.set(key, String(value));
  }
  hasAttribute(key) {
    return this.attrs.has(key);
  }
  removeAttribute(key) {
    this.attrs.delete(key);
  }
  get group() {
    return this.parentElement?.groupOwner ?? null;
  }
  get nextElementSibling() {
    return (
      this.parentElement?.children[
        this.parentElement.children.indexOf(this) + 1
      ] ?? null
    );
  }
  get lastChild() {
    return this.children.at(-1);
  }
  appendChild(child) {
    return this.insertBefore(child, null);
  }
  insertBefore(child, anchor) {
    if (child === anchor) {
      return child;
    }
    child.remove();
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert.ok(index >= 0, "Native insertion anchor exists");
    this.children.splice(index, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children.splice(
        this.parentElement.children.indexOf(this),
        1
      );
      this.parentElement = null;
    }
  }
  after(child) {
    this.parentElement.insertBefore(child, this.nextElementSibling);
  }
}

function environment(options = {}) {
  let serial = 0;
  const known = new Map();
  const windows = [];
  const notifications = [];
  const flatten = element =>
    element.children.flatMap(child =>
      child.tabs
        ? child.tabs
        : child.localName === "tab"
          ? [child]
          : flatten(child)
    );
  const allTabs = win =>
    [...win.roots.values()].flatMap(root => [
      ...flatten(root.pinnedTabsContainer),
      ...flatten(root.tabsContainer),
    ]);
  const service = {
    assertInstance(args) {
      assert.equal(args.instanceId, "epoch");
    },
    getWindows: () => windows.filter(win => !win.closed),
    windowId: win => win.id,
    tabId: tab => tab.mcpId,
    getTab: id => {
      const tab = known.get(id);
      if (!tab || !allTabs(tab.ownerGlobal).includes(tab)) {
        throw Object.assign(new Error("Closed"), { code: "closed_tab" });
      }
      return tab;
    },
    listTabs: allTabs,
    notify: (kind, data) => notifications.push({ kind, data }),
  };
  function createWindow(id) {
    const win = {
      id,
      roots: new Map(),
      groups: [],
      closed: false,
      closedTabs: [],
    };
    for (const spaceId of ["work", "research"]) {
      win.roots.set(spaceId, {
        pinnedTabsContainer: new Element(win, "box"),
        tabsContainer: new Element(win, "box"),
      });
    }
    win.gZenWorkspaces = {
      activeWorkspace: "work",
      getWorkspaceFromId: id =>
        win.roots.has(id) ? { uuid: id, name: id, containerTabId: 0 } : null,
      getWorkspaces: () =>
        [...win.roots.keys()].map(id => ({
          uuid: id,
          name: id,
          containerTabId: 0,
        })),
      workspaceElement: id => win.roots.get(id),
      async changeWorkspaceWithID(id) {
        this.activeWorkspace = id;
      },
      moveTabToWorkspace(tab, id) {
        const root = win.roots.get(id);
        assert.ok(root);
        if (tab.getAttribute("zen-workspace-id") === id && tab.parentElement) {
          return;
        }
        tab.setAttribute("zen-workspace-id", id);
        (tab.pinned
          ? root.pinnedTabsContainer
          : root.tabsContainer
        ).appendChild(tab);
      },
    };
    win.gBrowser = {
      get tabs() {
        return allTabs(win);
      },
      selectedTab: null,
      addTab(url, config = {}) {
        const tab = new Element(win, "tab", {
          "zen-workspace-id": config.zenWorkspaceId ?? "work",
          usercontextid: String(config.userContextId ?? 0),
        });
        tab.id = tab.mcpId = `tab-${++serial}`;
        tab.url = url;
        tab.label = url;
        tab.closing = false;
        tab.loaded = !config.createLazyBrowser;
        tab.pinned = !!config.pinned;
        tab.history = [url];
        tab.closed = false;
        tab.lastAccessed = serial * 100;
        tab._creationTime = serial * 10;
        if (!tab.loaded) {
          tab.setAttribute("pending", "true");
        }
        Object.defineProperty(tab, "index", {
          get: () => allTabs(win).indexOf(tab),
        });
        Object.defineProperty(tab, "linkedPanel", {
          get: () => (tab.loaded ? "panel" : null),
        });
        tab.linkedBrowser = {
          tab,
          asyncPermitUnload: async () => ({ permitUnload: !tab.blockClose }),
          get currentURI() {
            return { spec: tab.url };
          },
          loadURI(uri) {
            tab.url = uri.href;
            tab.loaded = true;
          },
        };
        known.set(tab.mcpId, tab);
        const root = win.roots.get(tab.getAttribute("zen-workspace-id"));
        (tab.pinned
          ? root.pinnedTabsContainer
          : root.tabsContainer
        ).appendChild(tab);
        this.selectedTab ??= tab;
        return tab;
      },
      removeTab(tab) {
        if (tab.blockClose) {
          return;
        }
        if (tab.delayClose) {
          tab.closing = true;
          return;
        }
        tab.remove();
        tab.closed = true;
        if (this.selectedTab === tab) {
          this.selectedTab = allTabs(win)[0] ?? null;
        }
      },
      discardBrowser(tab) {
        if (tab === this.selectedTab || tab.media?.playing) {
          return false;
        }
        tab.loaded = false;
        tab.setAttribute("discarded", "true");
        return true;
      },
      insertBrowser(tab) {
        tab.loaded = true;
        tab.removeAttribute("discarded");
      },
      pinTab(tab) {
        if (tab.pinned) {
          return;
        }
        tab.pinned = true;
        win.roots
          .get(tab.getAttribute("zen-workspace-id"))
          .pinnedTabsContainer.appendChild(tab);
        tab._zenPinnedInitialState = {
          entry: { url: tab.url, title: tab.label },
        };
      },
      unpinTab(tab) {
        if (!tab.pinned) {
          return;
        }
        tab.pinned = false;
        win.roots
          .get(tab.getAttribute("zen-workspace-id"))
          .tabsContainer.appendChild(tab);
      },
      ungroupTab(tab) {
        win.roots
          .get(tab.getAttribute("zen-workspace-id"))
          [
            tab.pinned ? "pinnedTabsContainer" : "tabsContainer"
          ].appendChild(tab);
      },
      moveTabBefore(item, anchor) {
        anchor.parentElement.insertBefore(item, anchor);
      },
      moveTabAfter(item, anchor) {
        anchor.after(item);
      },
      zenHandleTabMove(item, callback) {
        callback();
      },
      adoptTab(tab, config) {
        const originalId = tab.mcpId;
        const adopted = this.addTab(tab.url, {
          ...config,
          createLazyBrowser: !tab.loaded,
          userContextId: Number(tab.getAttribute("usercontextid")),
          zenWorkspaceId: config.spaceId ?? "work",
          pinned: tab.pinned,
        });
        adopted.label = tab.label;
        adopted.history = tab.history.slice();
        adopted._zenPinnedInitialState = tab._zenPinnedInitialState;
        adopted.zenStaticLabel = tab.zenStaticLabel;
        owner(tab).gBrowser.removeTab(tab);
        known.set(originalId, tab);
        return adopted;
      },
      adoptTabGroup(group) {
        const tabs = group.tabs.map(tab => this.adoptTab(tab, {}));
        return createGroup(win, group.id, tabs, {
          folder: false,
          split: group.hasAttribute("split-view-group"),
        });
      },
      addTabGroup(tabs, config) {
        return createGroup(win, config.id, tabs, {
          folder: false,
          split: config.forSplitView,
          label: config.label,
        });
      },
      _setTabLabel(tab, label) {
        tab.label = label;
      },
      setTabTitle(tab) {
        tab.label = tab.url;
      },
    };
    win.gZenFolders = {
      createFolder: (tabs, config) =>
        createGroup(win, config.id ?? `folder-${++serial}`, tabs, {
          folder: true,
          label: config.label,
          spaceId: config.workspaceId,
          collapsed: config.collapsed,
        }),
      setFolderUserIcon: (group, icon) => {
        group.iconURL = icon;
      },
      changeFolderToSpace(group, id) {
        group.setAttribute("zen-workspace-id", id);
        for (const tab of group.tabs) {
          tab.setAttribute("zen-workspace-id", id);
          tab.group.setAttribute("zen-workspace-id", id);
        }
      },
    };
    win.gZenPinnedTabManager = {
      resetPinnedTab(tab) {
        tab.url = tab._zenPinnedInitialState.entry.url;
      },
      resetPinChangedUrl() {},
    };
    win.gZenWindowSync = {
      async setPinnedTabState(tab) {
        tab._zenPinnedInitialState = {
          entry: { url: tab.url, title: tab.label },
        };
      },
      setPinnedUrl(tab, url, image) {
        tab._zenPinnedInitialState = {
          entry: { url, title: tab.zenStaticLabel },
          image,
        };
      },
      setPinnedInitialState(tab, entry, image) {
        tab._zenPinnedInitialState = { entry, image };
      },
    };
    windows.push(win);
    return win;
  }
  function createGroup(
    win,
    id,
    tabs,
    {
      folder = true,
      split = false,
      label = id,
      spaceId = tabs[0]?.getAttribute("zen-workspace-id") ?? "work",
      collapsed = false,
    } = {}
  ) {
    const group = new Element(win, folder ? "zen-folder" : "tab-group", {
      "zen-workspace-id": spaceId,
    });
    group.id = id;
    group.label = label;
    group.isZenFolder = folder;
    group.pinned = folder || tabs.every(tab => tab.pinned);
    group.collapsed = collapsed;
    if (split) {
      group.setAttribute("split-view-group", "true");
    }
    group.groupContainer = new Element(win, "box");
    group.groupContainer.groupOwner = group;
    Object.defineProperty(group, "tabs", {
      get: () => flatten(group.groupContainer),
    });
    Object.defineProperty(group, "allItems", {
      get: () => group.groupContainer.children.slice(),
    });
    Object.defineProperty(group, "allItemsRecursive", {
      get: () =>
        group.allItems.flatMap(item =>
          item.isZenFolder ? [item, ...item.allItemsRecursive] : [item]
        ),
    });
    Object.defineProperty(group, "level", {
      get: () => (group.group ? group.group.level + 1 : 0),
    });
    group.addTabs = tabs => {
      for (const tab of tabs) {
        group.groupContainer.appendChild(tab);
      }
    };
    group.delete = async () => {
      for (const tab of group.tabs) {
        win.gBrowser.removeTab(tab);
      }
      group.remove();
      win.groups.splice(win.groups.indexOf(group), 1);
    };
    for (const tab of tabs) {
      if (folder) {
        win.gBrowser.pinTab(tab);
      }
    }
    group.addTabs(tabs);
    win.roots
      .get(spaceId)
      [
        group.pinned ? "pinnedTabsContainer" : "tabsContainer"
      ].appendChild(group);
    win.groups.push(group);
    return group;
  }
  const owner = tab => tab.ownerGlobal;
  const browser = {
    window(id) {
      const win = windows.find(
        win => win.id === id && !win.closed && !win.private
      );
      if (!win) {
        throw Object.assign(new Error("Unknown window"), {
          code: "unknown_window",
        });
      }
      return win;
    },
    tab(id, win) {
      const tab = service.getTab(id);
      if (
        tab.closing ||
        tab.ownerGlobal.private ||
        (win && tab.ownerGlobal !== win)
      ) {
        throw Object.assign(new Error("Wrong target"), { code: "unknown_tab" });
      }
      return tab;
    },
    mediaState(tab) {
      return {
        tabId: tab.mcpId,
        windowId: tab.ownerGlobal.id,
        documentId: tab.documentId ?? null,
        url: tab.url,
        title: tab.label,
        selected: owner(tab).gBrowser.selectedTab === tab,
        loaded: tab.loaded,
        pending: tab.hasAttribute("pending"),
        discarded: tab.hasAttribute("discarded"),
        pinned: tab.pinned,
        essential: tab.hasAttribute("zen-essential"),
        muted: tab.hasAttribute("muted"),
        soundPlaying: tab.hasAttribute("soundplaying"),
        hidden: false,
        spaceId: tab.getAttribute("zen-workspace-id"),
        containerId: Number(tab.getAttribute("usercontextid")),
        groupId: tab.group?.id ?? null,
        index: tab.index,
        media: tab.media ?? null,
      };
    },
    windowState: win => ({ windowId: win.id }),
    spaceState: (win, space) => ({ windowId: win.id, spaceId: space.uuid }),
    allGroups: win => win.groups,
    group(id, win, kind) {
      const group = win.groups.find(
        group => group.id === id && (kind !== "folder" || group.isZenFolder)
      );
      assert.ok(group);
      return group;
    },
    groupState: (win, group) => ({
      windowId: win.id,
      groupId: group.id,
      name: group.label,
      kind: group.isZenFolder
        ? "folder"
        : group.hasAttribute("split-view-group")
          ? "split"
          : "group",
      collapsed: group.collapsed,
      spaceId: group.getAttribute("zen-workspace-id"),
      parentGroupId: group.group?.id ?? null,
      tabIds: group.tabs.map(tab => tab.mcpId),
      childGroupIds: group.allItems
        .filter(item => item.tabs)
        .map(item => item.id),
    }),
    validateSpace(win, id) {
      assert.ok(win.gZenWorkspaces.getWorkspaceFromId(id));
    },
    validateContainer(id) {
      assert.ok(Number.isInteger(id) && id >= 0 && id < 3);
    },
    setPinMode(win, tab, mode) {
      if (mode === "normal") {
        tab.removeAttribute("zen-essential");
        win.gBrowser.unpinTab(tab);
      } else {
        win.gBrowser.pinTab(tab);
        if (mode === "essential") {
          tab.setAttribute("zen-essential", "true");
        } else {
          tab.removeAttribute("zen-essential");
        }
      }
    },
    async selectTab(tab) {
      owner(tab).gZenWorkspaces.activeWorkspace =
        tab.getAttribute("zen-workspace-id");
      owner(tab).gBrowser.selectedTab = tab;
    },
    async waitFor(fn) {
      if (!fn()) {
        throw Object.assign(new Error("Native action blocked"), {
          code: "state_timeout",
        });
      }
    },
    closedTabs: win => win.closedTabs,
    nestFolder(win, folder, parent) {
      parent.groupContainer.appendChild(folder);
    },
    changed(win, tab) {
      notifications.push({ win: win.id, tab: tab?.mcpId });
    },
  };
  service.browserTools = browser;
  mocks.SessionStore = {
    getTabState(tab) {
      return JSON.stringify({
        entries: tab.history.map(url => ({ url })),
        index: tab.history.length,
        pinned: tab.pinned,
        zen: {
          spaceId: tab.getAttribute("zen-workspace-id"),
          title: tab.zenStaticLabel,
        },
      });
    },
    setTabState(tab, raw) {
      const state = JSON.parse(raw);
      tab.history = state.entries.map(entry => entry.url);
      tab.url = tab.history[state.index - 1];
      tab.pinned = state.pinned;
      tab.zenStaticLabel = state.zen.title;
    },
    undoCloseById(closedId, privateMode, win) {
      assert.equal(privateMode, false);
      const index = win.closedTabs.findIndex(
        item => item.closedId === closedId
      );
      assert.ok(index >= 0);
      const [record] = win.closedTabs.splice(index, 1);
      const tab = win.gBrowser.addTab(record.url, { createLazyBrowser: true });
      win.gBrowser.selectedTab = tab;
      return tab;
    },
  };
  mocks.TabStateFlusher = { flush: async () => {} };
  const provider = new ZenMcpWorkspaceTools(service, {
    createWorker: realWorker,
    workerTimeout: 1500,
    ...options,
  });
  const win = createWindow("window-a");
  const add = (url = "https://example.test/", extra = {}) => {
    const tab = (extra.win ?? win).gBrowser.addTab(url, {
      createLazyBrowser: true,
      ...extra,
    });
    if (extra.title) {
      tab.label = extra.title;
    }
    return tab;
  };
  const execute = (name, args, user = client) =>
    provider.execute(name, { ...identity, ...args }, user);
  const planApply = async args => {
    const plan = await execute("zen_tabs_plan", { windowId: win.id, ...args });
    return execute("zen_tabs_apply", { planId: plan.planId });
  };
  return {
    service,
    browser,
    provider,
    win,
    windows,
    createWindow,
    createGroup,
    add,
    execute,
    planApply,
    notifications,
    known,
  };
}

test("descriptor filters, scoped duplicates, natural stable sorting and malformed filters", () => {
  const items = [
    {
      tabId: "1",
      url: "https://a.test/x#one",
      title: "Tab 10",
      containerId: 0,
      spaceId: "x",
      folderPath: [{ groupId: "folder" }],
      pinned: false,
    },
    {
      tabId: "2",
      url: "https://a.test/x#two",
      title: "Tab 2",
      containerId: 0,
      spaceId: "x",
      folderPath: [],
      pinned: false,
    },
    {
      tabId: "3",
      url: "https://a.test/x#two",
      title: "Tab 2",
      containerId: 1,
      spaceId: "x",
      folderPath: [],
      pinned: true,
    },
    {
      tabId: "4",
      url: "https://a.test/x#two",
      title: "Tab 2",
      containerId: 0,
      spaceId: "y",
      folderPath: [],
      pinned: false,
    },
  ];
  assert.deepEqual(
    filterTabs(items, {
      spaceId: "x",
      duplicates: { ignoreHash: true, keep: "first" },
    }).map(item => item.tabId),
    ["2"]
  );
  assert.deepEqual(
    filterTabs(items, {
      folderId: "folder",
      title: { glob: "Tab *" },
      not: { pinned: true },
    }).map(item => item.tabId),
    ["1"]
  );
  assert.deepEqual(
    sortTabs(items, { by: "title" }).map(item => item.tabId),
    ["2", "3", "4", "1"]
  );
  for (const filter of [
    { pinnd: true },
    { all: "no" },
    { title: { regex: "(" } },
    { recursive: true },
    { duplicates: { keep: "random" } },
  ]) {
    assert.throws(() => filterTabs(items, filter));
  }
});

test("default standard-worker factory cleans up its private in-memory resource", async () => {
  const savedWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const savedChrome = Object.getOwnPropertyDescriptor(
    globalThis,
    "ChromeWorker"
  );
  const savedCi = Object.getOwnPropertyDescriptor(globalThis, "Ci");
  const previousHandler = Services.io.getProtocolHandler;
  const substitutions = new Map();
  const blobs = [];
  const handler = {
    QueryInterface() {
      return this;
    },
    setSubstitution(name, uri) {
      if (uri) {
        substitutions.set(name, uri.href);
        blobs.push(uri.href);
      } else {
        substitutions.delete(name);
      }
    },
  };
  Services.io.getProtocolHandler = () => handler;
  globalThis.Ci = { nsIResProtocolHandler: "resource-handler" };
  globalThis.Worker = class {
    constructor(url) {
      const entry = substitutions.get(new URL(url).hostname);
      assert.ok(entry, "Worker must use its private resource substitution");
      let delegate,
        stopped = false;
      const messages = [];
      const api = {
        onmessage: null,
        onerror: null,
        postMessage(data) {
          delegate ? delegate.postMessage(data) : messages.push(data);
        },
        terminate() {
          stopped = true;
          delegate?.terminate();
        },
      };
      resolveObjectURL(entry)
        .text()
        .then(source => {
          if (stopped) {
            return;
          }
          delegate = realWorker(source);
          delegate.onmessage = event => api.onmessage?.(event);
          delegate.onerror = error => api.onerror?.(error);
          messages.forEach(data => delegate.postMessage(data));
        })
        .catch(error => api.onerror?.(error));
      return api;
    }
  };
  globalThis.ChromeWorker = class {
    constructor() {
      throw new Error("Non-removable ctypes capability");
    }
  };
  try {
    const e = environment({ createWorker: undefined });
    const tab = e.add("https://safe.test");
    const result = await e.execute("zen_tabs_query", {
      windowId: e.win.id,
      filterLambda:
        "(() => { if (typeof fetch !== 'undefined' || typeof ctypes !== 'undefined' || typeof Function !== 'undefined') { throw new Error('ambient capability'); } return t => t.url.includes('safe'); })()",
    });
    assert.deepEqual(
      result.items.map(item => item.tabId),
      [tab.mcpId]
    );
    assert.equal(substitutions.size, 0);
    assert.equal(resolveObjectURL(blobs[0]), undefined);
  } finally {
    Services.io.getProtocolHandler = previousHandler;
    for (const [key, descriptor] of [
      ["Worker", savedWorker],
      ["ChromeWorker", savedChrome],
      ["Ci", savedCi],
    ]) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete globalThis[key];
      }
    }
  }
});

test("real disposable worker evaluates lambdas over frozen pure data, strips ambient capabilities", async () => {
  const e = environment();
  e.add("https://github.com/a", { title: "Issue 10" });
  const second = e.add("https://github.com/b", { title: "Issue 2" });
  const queried = await e.execute("zen_tabs_query", {
    windowId: e.win.id,
    filter: { domain: { equals: "github.com" } },
    filterLambda:
      "t => t.title.includes('2') && typeof fetch === 'undefined' && typeof process === 'undefined' && typeof importScripts === 'undefined' && typeof Function === 'undefined' && typeof ({}).constructor.constructor === 'undefined'",
  });
  assert.deepEqual(
    queried.items.map(item => item.tabId),
    [second.mcpId]
  );
  await assert.rejects(
    e.execute("zen_tabs_query", {
      windowId: e.win.id,
      filterLambda: "t => { t.title = 'changed'; return true; }",
    }),
    error => error.code === "invalid_expression"
  );
  await assert.rejects(
    e.execute("zen_tabs_query", {
      windowId: e.win.id,
      filterLambda: "t => import/**/('https://example.test/evil')",
    }),
    error => error.code === "invalid_expression"
  );
  const plan = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "sort",
    sortKeyLambda: "t => [t.domain, Number(t.title.split(' ')[1])]",
  });
  await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.equal(e.service.listTabs(e.win)[0], second);
  assert.equal(e.provider.workers.size, 0);
});

test("infinite lambda and catastrophic regex terminate without blocking browser mutation", async () => {
  const e = environment({ workerTimeout: 100 });
  e.add("https://example.test/", { title: `${"a".repeat(10000)}!` });
  await assert.rejects(
    e.execute("zen_tabs_query", {
      windowId: e.win.id,
      filterLambda: "t => { while (true) {} }",
    }),
    error => error.code === "lambda_timeout"
  );
  await assert.rejects(
    e.execute("zen_tabs_query", {
      windowId: e.win.id,
      filter: { title: { regex: "^(a+)+$" } },
    }),
    error => error.code === "lambda_timeout"
  );
  assert.equal(e.provider.workers.size, 0);
});

test("selection ownership, exact full-set pagination, stale state, expiry and private targets", async () => {
  let now = 10;
  const e = environment({ now: () => now });
  const first = e.add();
  const second = e.add("https://example.test/2");
  const result = await e.execute("zen_tabs_query", {
    windowId: e.win.id,
    limit: 1,
  });
  assert.equal(result.total, 2);
  assert.equal(result.items.length, 1);
  const page = await e.execute("zen_tabs_query", {
    windowId: e.win.id,
    selectionId: result.selectionId,
    cursor: result.nextCursor,
  });
  assert.equal(page.items[0].tabId, second.mcpId);
  assert.equal(page.revision, result.revision);
  await assert.rejects(
    e.provider.resolveTargets(
      { windowId: e.win.id, selectionId: result.selectionId },
      { id: "other" }
    ),
    error => error.code === "unknown_selection"
  );
  first.media = { playing: true };
  await assert.rejects(
    e.provider.resolveTargets(
      { windowId: e.win.id, selectionId: result.selectionId },
      client
    ),
    error => error.code === "selection_conflict"
  );
  now += 5 * 60 * 1000;
  await assert.rejects(
    e.provider.resolveTargets(
      { windowId: e.win.id, selectionId: result.selectionId },
      client
    ),
    error => error.code === "unknown_selection"
  );
  const privateWin = e.createWindow("private");
  privateWin.private = true;
  const privateTab = e.add("https://secret.test", { win: privateWin });
  await assert.rejects(
    e.provider.resolveTargets({ tabIds: [privateTab.mcpId] }, client)
  );
  assert.deepEqual(
    await e.provider.resolveTargets({ tabIds: [second.mcpId] }, client),
    [second]
  );
});

test("previews are read-only, stale plans reject, applies are idempotent and focus is preserved", async () => {
  const e = environment();
  const first = e.add("https://z.test", { title: "Z" });
  const second = e.add("https://a.test", { title: "A" });
  const plan = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "sort",
    sort: { by: "title" },
  });
  assert.deepEqual(e.service.listTabs(e.win), [first, second]);
  const result = await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.deepEqual(e.service.listTabs(e.win), [second, first]);
  assert.equal(e.win.gBrowser.selectedTab, first);
  assert.deepEqual(
    await e.execute("zen_tabs_apply", { planId: plan.planId }),
    result
  );
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.deepEqual(e.service.listTabs(e.win), [first, second]);
  const stale = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "close",
    tabIds: [second.mcpId],
  });
  second.media = { playing: true };
  await assert.rejects(
    e.execute("zen_tabs_apply", { planId: stale.planId }),
    error => error.code === "plan_conflict"
  );
  assert.ok(e.service.listTabs(e.win).includes(second));
});

test("stored sidebar indexes do not reuse the inactive strip's cached tab indexes", async () => {
  const e = environment();
  const tabs = [
    e.add("https://a.test"),
    e.add("https://b.test"),
    e.add("https://c.test"),
  ];
  const state = e.browser.mediaState.bind(e.browser);
  e.browser.mediaState = tab => ({ ...state(tab), index: 1 });
  const selected = await e.execute("zen_tabs_query", { windowId: e.win.id });
  assert.deepEqual(
    selected.items.map(item => item.index),
    [0, 1, 2]
  );
  await e.planApply({
    action: "sort",
    tabIds: [tabs[2].mcpId, tabs[0].mcpId, tabs[1].mcpId],
    sort: { by: "index" },
  });
  assert.deepEqual(
    e.service.listTabs(e.win).map(tab => tab.mcpId),
    tabs.map(tab => tab.mcpId)
  );
});

test("completed effects retain their receipt when restoring focus fails", async () => {
  const e = environment();
  e.add("https://z.test", { title: "Z" });
  e.add("https://a.test", { title: "A" });
  e.provider.restoreFocus = async () => {
    throw Object.assign(new Error("Window changed during focus restore"), {
      code: "focus_unavailable",
    });
  };
  const result = await e.planApply({ action: "sort", sort: { by: "title" } });
  assert.equal(result.summary.sorted, 2);
  assert.equal(result.focusError.code, "focus_unavailable");
  assert.ok(result.operationId);
  assert.deepEqual(
    e.service.listTabs(e.win).map(tab => tab.label),
    ["A", "Z"]
  );
});

test("sort replaces only selected sibling slots; exact manual order rejects cross-tree ambiguity", async () => {
  const e = environment();
  const a = e.add("https://example.test/a", { title: "C" });
  const keep = e.add("https://example.test/keep", { title: "Keep" });
  const b = e.add("https://example.test/b", { title: "A" });
  await e.planApply({
    action: "sort",
    tabIds: [a.mcpId, b.mcpId],
    order: [b.mcpId, a.mcpId],
  });
  assert.deepEqual(e.service.listTabs(e.win), [b, keep, a]);
  const folder = e.createGroup(e.win, "folder", [a]);
  await assert.rejects(
    e.execute("zen_tabs_plan", {
      windowId: e.win.id,
      action: "sort",
      tabIds: [a.mcpId, b.mcpId],
      order: [a.mcpId, b.mcpId],
    }),
    error => error.code === "invalid_order"
  );
  assert.equal(a.group, folder);
});

test("folder/subtree sort keeps group units intact and sorts nested children", async () => {
  const e = environment();
  const z = e.add("https://z.test", { title: "Z" });
  const a = e.add("https://a.test", { title: "A" });
  const c = e.add("https://c.test", { title: "C" });
  const child = e.createGroup(e.win, "child", [z, a], { label: "B folder" });
  const root = e.createGroup(e.win, "root", [c]);
  e.browser.nestFolder(e.win, child, root);
  const result = await e.planApply({
    action: "sort",
    folderId: root.id,
    scope: "subtree",
    sort: { by: "title" },
  });
  assert.deepEqual(root.allItems, [child, c]);
  assert.deepEqual(child.tabs, [a, z]);
  assert.equal(e.win.gBrowser.selectedTab, z);
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.deepEqual(child.tabs, [z, a]);
  assert.deepEqual(root.allItems, [c, child]);
});

test("folder and subtree sorts honor an empty or partial shared selection", async () => {
  const e = environment();
  const a = e.add("https://z.test", { title: "Z" });
  const excluded = e.add("https://keep.test", { title: "0 excluded" });
  const b = e.add("https://a.test", { title: "A" });
  const root = e.createGroup(e.win, "root", []);
  const child = e.createGroup(e.win, "child", [a, excluded, b]);
  root.groupContainer.appendChild(child);
  await e.planApply({
    action: "sort",
    scope: "folder",
    folderId: child.id,
    tabIds: [],
    sort: { by: "title" },
  });
  assert.deepEqual(
    child.allItems.map(item => item.id),
    [a.id, excluded.id, b.id]
  );
  for (const scope of ["folder", "subtree"]) {
    const sorted = await e.planApply({
      action: "sort",
      scope,
      folderId: scope === "folder" ? child.id : root.id,
      tabIds: [a.mcpId, b.mcpId],
      sort: { by: "title" },
    });
    assert.deepEqual(
      child.allItems.map(item => item.id),
      [b.id, excluded.id, a.id]
    );
    assert.equal(child.group, root);
    await e.execute("zen_tabs_undo", { operationId: sorted.operationId });
    assert.deepEqual(
      child.allItems.map(item => item.id),
      [a.id, excluded.id, b.id]
    );
  }
});

test("batch manual destinations, anchors, nested pin folders and undo preserve tree", async () => {
  const e = environment();
  const a = e.add("https://a.test");
  const b = e.add("https://b.test");
  const c = e.add("https://c.test");
  const target = e.createGroup(e.win, "research-folder", [], {
    spaceId: "research",
  });
  const result = await e.planApply({
    action: "move",
    placements: [
      { tabIds: [a.mcpId, b.mcpId], spaceId: "research", folderId: target.id },
      { tabIds: [c.mcpId], spaceId: "research", folderId: null },
    ],
  });
  assert.equal(target.tabs.length, 2);
  assert.equal(a.pinned, true);
  assert.equal(c.getAttribute("zen-workspace-id"), "research");
  assert.equal(e.win.gZenWorkspaces.activeWorkspace, "work");
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.deepEqual(e.service.listTabs(e.win), [a, b, c]);
  assert.equal(a.pinned, false);
  const anchorMove = await e.planApply({
    action: "move",
    tabIds: [c.mcpId, b.mcpId],
    beforeId: a.mcpId,
  });
  assert.deepEqual(e.service.listTabs(e.win), [c, b, a]);
  assert.equal(anchorMove.summary.moved, 2);
});

test("cross-window batch adoption and whole nested folders preserve hierarchy and reject collisions", async () => {
  const e = environment();
  const targetWin = e.createWindow("window-b");
  const a = e.add("https://a.test");
  const b = e.add("https://b.test");
  const child = e.createGroup(e.win, "child", [b]);
  const root = e.createGroup(e.win, "root", [a]);
  e.browser.nestFolder(e.win, child, root);
  const collision = e.createGroup(targetWin, "child", []);
  await assert.rejects(
    e.execute("zen_tabs_plan", {
      windowId: e.win.id,
      action: "move",
      tabIds: [],
      groupIds: [root.id],
      destinationWindowId: targetWin.id,
      spaceId: "research",
    }),
    error => error.code === "group_collision"
  );
  await collision.delete();
  const result = await e.planApply({
    action: "move",
    tabIds: [],
    groupIds: [root.id],
    destinationWindowId: targetWin.id,
    spaceId: "research",
  });
  assert.equal(result.summary.moved, 2, JSON.stringify(result));
  const movedRoot = targetWin.groups.find(group => group.id === "root");
  const movedChild = targetWin.groups.find(group => group.id === "child");
  assert.equal(movedChild.group, movedRoot);
  assert.equal(movedRoot.tabs.length, 2);
  assert.equal(e.service.listTabs(e.win).length, 0);
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.equal(e.service.listTabs(e.win).length, 2);
  assert.equal(
    e.win.groups.find(group => group.id === "child").group.id,
    "root"
  );
  assert.equal(targetWin.groups.length, 0);
});

test("whole folder move within a window restores its original Space, parent and position", async () => {
  const e = environment();
  const a = e.add("https://a.test");
  const b = e.add("https://b.test");
  const root = e.createGroup(e.win, "root", [a]);
  const sibling = e.createGroup(e.win, "sibling", [b]);
  const destination = e.createGroup(e.win, "destination", [], {
    spaceId: "research",
  });
  const result = await e.planApply({
    action: "move",
    tabIds: [],
    groupIds: [root.id],
    spaceId: "research",
    folderId: destination.id,
  });
  assert.equal(root.group, destination);
  assert.equal(a.getAttribute("zen-workspace-id"), "research");
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.equal(root.group, null);
  assert.equal(root.getAttribute("zen-workspace-id"), "work");
  assert.equal(a.group, root);
  assert.equal(a.getAttribute("zen-workspace-id"), "work");
  assert.deepEqual(e.win.roots.get("work").pinnedTabsContainer.children, [
    root,
    sibling,
  ]);
});

test("explicit nested folders move without absorbing their enclosing folder", async () => {
  const e = environment();
  const tab = e.add("https://child.test");
  const outer = e.createGroup(e.win, "outer", []);
  const inner = e.createGroup(e.win, "inner", [tab]);
  outer.groupContainer.appendChild(inner);
  const plan = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "move",
    groupIds: [inner.id],
    spaceId: "research",
  });
  assert.deepEqual(plan.preview.moves[0].units, [
    { id: inner.id, group: true },
  ]);
  const moved = await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.equal(inner.getAttribute("zen-workspace-id"), "research");
  assert.equal(outer.getAttribute("zen-workspace-id"), "work");
  await e.execute("zen_tabs_undo", { operationId: moved.operationId });
  assert.equal(inner.group, outer);
  assert.equal(tab.group, inner);
  const empty = e.createGroup(e.win, "empty-child", []);
  inner.groupContainer.appendChild(empty);
  assert.deepEqual(e.provider.units([], [inner, empty]), [inner]);
});

test("batch close retains complete SessionStore history independently of native closed-tab retention", async () => {
  const e = environment();
  const first = e.add("https://example.test/first");
  const tabs = Array.from({ length: 40 }, (_, i) =>
    e.add(`https://example.test/${i}`)
  );
  tabs[0].history = ["https://example.test/start", tabs[0].url];
  tabs[1].blockClose = true;
  const result = await e.planApply({
    action: "close",
    tabIds: tabs.map(tab => tab.mcpId),
  });
  assert.equal(result.summary.closed, 39);
  assert.equal(result.summary.blocked, 1);
  assert.equal(e.win.gBrowser.selectedTab, first);
  const reopen = await e.planApply({
    action: "reopen",
    operationId: result.operationId,
  });
  assert.equal(reopen.summary.restored, 39);
  assert.equal(e.service.listTabs(e.win).length, 41);
  assert.deepEqual(e.service.listTabs(e.win)[1].history, [
    "https://example.test/start",
    tabs[0].url,
  ]);
  assert.equal(e.win.gBrowser.selectedTab, first);
  const repeated = await e.planApply({
    action: "reopen",
    operationId: result.operationId,
  });
  assert.deepEqual(repeated.outcomes, []);
  assert.equal(e.service.listTabs(e.win).length, 41);
  // A formerly blocked close can complete later, without making recovery of
  // the already restored batch repeat itself.
  tabs[1].blockClose = false;
  e.win.gBrowser.removeTab(tabs[1]);
  const late = await e.planApply({
    action: "reopen",
    operationId: result.operationId,
  });
  assert.equal(late.summary.restored, 1);
  assert.equal(e.service.listTabs(e.win).length, 41);
});

test("delayed close reconciliation retains receipt instead of throwing closed_tab", async () => {
  const e = environment();
  const tab = e.add();
  tab.delayClose = true;
  const plan = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "close",
    tabIds: [tab.mcpId],
  });
  const pending = await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.equal(pending.summary.pending, 1);
  tab.remove();
  const settled = await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.equal(settled.summary.closed, 1);
});

test("batch native closed IDs are scoped, stale-checked, restored once and preserve focus", async () => {
  const e = environment();
  const active = e.add();
  e.win.closedTabs.push(
    { closedId: 11, url: "https://one.test" },
    { closedId: 12, url: "https://two.test" }
  );
  const plan = await e.execute("zen_tabs_plan", {
    windowId: e.win.id,
    action: "reopen",
    closedIds: [11, 12],
  });
  const result = await e.execute("zen_tabs_apply", { planId: plan.planId });
  assert.equal(result.summary.restored, 2);
  assert.equal(e.win.gBrowser.selectedTab, active);
  assert.equal(
    (await e.execute("zen_tabs_apply", { planId: plan.planId })).operationId,
    result.operationId
  );
  await assert.rejects(
    e.execute("zen_tabs_plan", {
      windowId: e.win.id,
      action: "reopen",
      closedIds: [11],
    }),
    error => error.code === "unknown_closed_tab"
  );
});

test("empty folder move and sort remain reversible", async () => {
  const e = environment();
  e.add();
  const folder = e.createGroup(e.win, "empty", []);
  const result = await e.planApply({
    action: "move",
    groupIds: [folder.id],
    spaceId: "research",
  });
  assert.equal(result.undoable, true);
  assert.equal(folder.getAttribute("zen-workspace-id"), "research");
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.equal(folder.getAttribute("zen-workspace-id"), "work");
  assert.equal(
    e.service.listTabs(e.win)[0].getAttribute("zen-workspace-id"),
    "work"
  );
});

test("background/lazy opens reuse only same URL, Space and container; undo closes only created tabs", async () => {
  const e = environment();
  const current = e.add("https://example.test");
  const result = await e.planApply({
    action: "open",
    urls: [
      "https://example.test",
      { url: "https://example.test", containerId: 1 },
      "https://other.test",
    ],
    lazy: true,
    reuse: "url",
  });
  assert.equal(result.summary.reused, 1);
  assert.equal(result.summary.opened, 2);
  assert.equal(e.win.gBrowser.selectedTab, current);
  assert.ok(e.service.listTabs(e.win).every(tab => !tab.loaded));
  await e.execute("zen_tabs_undo", { operationId: result.operationId });
  assert.deepEqual(e.service.listTabs(e.win), [current]);
});

test("cross-window moves and Undo request that an emptied donor window stays open", async () => {
  const e = environment();
  const first = e.add("https://a.test");
  const second = e.add("https://b.test");
  const target = e.createWindow("window-b");
  for (const win of [e.win, target]) {
    const adopt = win.gBrowser.adoptTab.bind(win.gBrowser);
    win.gBrowser.adoptTab = (tab, options) => {
      const donor = tab.ownerGlobal;
      const last = e.service.listTabs(donor).length === 1;
      const result = adopt(tab, options);
      if (last && options.closeWindowWithLastTab !== false) {
        donor.closed = true;
      }
      return result;
    };
  }
  const moved = await e.planApply({
    action: "move",
    tabIds: [first.mcpId, second.mcpId],
    destinationWindowId: target.id,
  });
  assert.equal(e.win.closed, false);
  await e.execute("zen_tabs_undo", { operationId: moved.operationId });
  assert.equal(target.closed, false);
  assert.deepEqual(
    e.service.listTabs(e.win).map(tab => tab.url),
    ["https://a.test", "https://b.test"]
  );
});

test("batch beforeunload checks leave confirmation tabs open without dispatching a blocking close", async () => {
  const e = environment();
  const dirty = e.add("https://dirty.test", { createLazyBrowser: false });
  const clean = e.add("https://clean.test", { createLazyBrowser: false });
  dirty.linkedBrowser.asyncPermitUnload = async action => {
    assert.equal(action, "dontUnload");
    return { permitUnload: false };
  };
  const remove = e.win.gBrowser.removeTab.bind(e.win.gBrowser);
  const dispatched = [];
  e.win.gBrowser.removeTab = (tab, options) => {
    dispatched.push(tab);
    assert.equal(options.skipPermitUnload, true);
    return remove(tab, options);
  };
  const result = await e.planApply({
    action: "close",
    tabIds: [dirty.mcpId, clean.mcpId],
  });
  assert.deepEqual(dispatched, [clean]);
  assert.deepEqual(
    result.outcomes.map(item => item.status),
    ["blocked", "closed"]
  );
  assert.equal(result.outcomes[0].error.code, "beforeunload_confirmation");
  assert.ok(e.service.listTabs(e.win).includes(dirty));
  const undone = await e.execute("zen_tabs_undo", {
    operationId: result.operationId,
  });
  assert.equal(undone.undone, true);
  assert.ok(e.service.listTabs(e.win).includes(dirty));
});

test("a background batch retains URL order when native inactive-Space insertion prepends", async () => {
  const e = environment();
  e.add("https://current.test");
  const addTab = e.win.gBrowser.addTab.bind(e.win.gBrowser);
  e.win.gBrowser.addTab = (url, options) => {
    const tab = addTab(url, options);
    const root = tab.parentElement;
    root.insertBefore(tab, root.children[0]);
    return tab;
  };
  const urls = [
    "https://first.test",
    "https://second.test",
    "https://third.test",
  ];
  await e.planApply({ action: "open", urls, spaceId: "research", lazy: true });
  const opened = e.service
    .listTabs(e.win)
    .filter(tab => tab.getAttribute("zen-workspace-id") === "research");
  assert.deepEqual(
    opened.map(tab => tab.url),
    urls
  );
});

test("pin saved/current URL, rename, reset, replace, unload and conflict-aware undo", async () => {
  const e = environment();
  e.add("https://active.test");
  const tab = e.add("https://saved.test");
  e.win.gBrowser.pinTab(tab);
  tab.url = "https://current.test";
  const listed = await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "list",
    tabIds: [tab.mcpId],
  });
  assert.equal(listed.items[0].pinChanged, true);
  assert.equal(listed.items[0].savedUrl, "https://saved.test");
  const replaced = await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "replace",
    tabIds: [tab.mcpId],
  });
  assert.equal(tab._zenPinnedInitialState.entry.url, "https://current.test");
  await e.execute("zen_tabs_undo", { operationId: replaced.operationId });
  assert.equal(tab._zenPinnedInitialState.entry.url, "https://saved.test");
  const renamed = await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "rename",
    tabIds: [tab.mcpId],
    title: "  My   pin  ",
  });
  assert.equal(tab.zenStaticLabel, "My pin");
  tab.url = "https://user-changed.test";
  await assert.rejects(
    e.execute("zen_tabs_undo", { operationId: renamed.operationId }),
    error => error.code === "undo_conflict"
  );
  await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "reset",
    tabIds: [tab.mcpId],
  });
  assert.equal(tab.url, "https://saved.test");
  await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "setUrl",
    tabIds: [tab.mcpId],
    url: "https://new-home.test",
  });
  assert.equal(tab._zenPinnedInitialState.entry.url, "https://new-home.test");
  tab.loaded = true;
  await e.execute("zen_pins", {
    windowId: e.win.id,
    action: "unload",
    tabIds: [tab.mcpId],
  });
  assert.equal(tab.loaded, false);
  assert.equal(tab.pinned, true);
});

test("native discard restrictions, cancellation, empty future rules and bounded client retention", async () => {
  const e = environment();
  const selected = e.add();
  const playing = e.add();
  playing.loaded = true;
  playing.media = { playing: true };
  selected.loaded = true;
  const discarded = await e.planApply({ action: "discard" });
  assert.equal(discarded.summary.blocked, 2);
  const empty = await e.planApply({ action: "sort", tabIds: [] });
  assert.equal(empty.undoable, false);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(
    e.provider.execute(
      "zen_tabs_query",
      { ...identity, windowId: e.win.id },
      client,
      cancel.signal
    ),
    error => error.code === "cancelled"
  );
  for (let i = 0; i < 150; i++) {
    await e.execute("zen_tabs_query", { windowId: e.win.id });
  }
  assert.equal(e.provider.selections.size, 128);
  e.provider.cleanup(client.id, "idle");
  assert.equal(e.provider.operations.size, 2);
  e.provider.releaseOperation(empty.operationId, client);
  assert.equal(e.provider.operations.size, 1);
  e.provider.cleanup(client.id);
  assert.equal(e.provider.operations.size, 0);
  assert.equal(e.provider.selections.size, 0);
});
