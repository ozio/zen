// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Run the real provider modules with native API fakes. These validate contracts,
// privacy/target handling and lazy reads; packaged Gecko is validated separately.
const mocks = {};
globalThis.ChromeUtils = {
  defineESModuleGetters(object, modules) {
    for (const name of Object.keys(modules)) {
      Object.defineProperty(object, name, {
        get: () => {
          assert.ok(name in mocks, `Missing native fake: ${name}`);
          return mocks[name];
        },
      });
    }
  },
};
globalThis.Ci = {
  nsINavHistoryQueryOptions: { RESULTS_AS_URI: 0, SORT_BY_DATE_DESCENDING: 4 },
  nsICookie: { SAMESITE_UNSET: 256 },
  nsICookieValidation: { eOK: 0 },
};
globalThis.Cr = { NS_ERROR_NOT_AVAILABLE: 1 };
globalThis.PathUtils = { isAbsolute: (path) => path.startsWith("/") };

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const utilsUrl = moduleUrl(
  await readFile(
    new URL("../../src/zen/mcp/ZenMcpUtils.sys.mjs", import.meta.url),
    "utf8",
  ),
);
const dataUrl = moduleUrl(
  (
    await readFile(
      new URL("../../src/zen/mcp/ZenMcpDataTools.sys.mjs", import.meta.url),
      "utf8",
    )
  ).replace("resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs", utilsUrl),
);
const browserUrl = moduleUrl(
  (
    await readFile(
      new URL("../../src/zen/mcp/ZenMcpBrowserTools.sys.mjs", import.meta.url),
      "utf8",
    )
  )
    .replace("resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs", utilsUrl)
    .replace("resource:///modules/zen/mcp/ZenMcpDataTools.sys.mjs", dataUrl)
    .replace("resource://gre/modules/Timer.sys.mjs", "node:timers"),
);
const { McpToolError } = await import(utilsUrl);
const { ZenMcpBrowserTools } = await import(browserUrl);
const { ZenMcpDataTools } = await import(dataUrl);
const client = { id: "test-client", name: "Tests" };
const identity = { instanceId: "test-instance" };

function fakeTab(
  win,
  n,
  {
    loaded = false,
    spaceId = "space-1",
    containerId = 0,
    essential = false,
  } = {},
) {
  const attrs = new Map([
    ["zen-workspace-id", spaceId],
    ["usercontextid", String(containerId)],
  ]);
  if (!loaded) {
    attrs.set("pending", "true");
  }
  if (essential) {
    attrs.set("zen-essential", "true");
  }
  const tab = {
    id: `native-tab-${n}`,
    mcpId: `tab-${n}`,
    ownerGlobal: win,
    linkedPanel: loaded ? `panel-${n}` : null,
    label: `Synthetic ${n}`,
    index: n,
    lazy: { url: `https://example.test/${n}`, title: `Synthetic ${n}` },
    closing: false,
    hidden: false,
    pinned: false,
    group: null,
    getAttribute: (key) => attrs.get(key) || "",
    hasAttribute: (key) => attrs.has(key),
    setAttribute: (key, value) => attrs.set(key, String(value)),
    removeAttribute: (key) => attrs.delete(key),
    toggleMuteAudio() {
      attrs.has("muted") ? attrs.delete("muted") : attrs.set("muted", "true");
    },
  };
  if (loaded) {
    tab.linkedBrowser = {
      currentURI: { spec: tab.lazy.url },
      browsingContext: {
        currentWindowGlobal: { innerWindowId: n + 1000 },
        mediaController: null,
      },
    };
  } else {
    tab.linkedBrowser = Object.fromEntries(
      [
        "currentURI",
        "browsingContext",
        "webProgress",
        "sessionHistory",
        "frameLoader",
      ].map((key) => [key, undefined]),
    );
    for (const key of Object.keys(tab.linkedBrowser)) {
      Object.defineProperty(tab.linkedBrowser, key, {
        get() {
          throw new Error(`Lazy browser must not be read: ${key}`);
        },
      });
    }
  }
  return tab;
}

function fixture(count = 3) {
  const notifications = [];
  const win = {
    id: "window-1",
    closed: false,
    screenX: 10,
    screenY: 20,
    outerWidth: 1000,
    outerHeight: 800,
    windowState: 3,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.options = options;
      }
    },
    gBrowserInit: { delayedStartupFinished: true },
  };
  const spaces = [
    { uuid: "space-1", name: "One", icon: "", containerTabId: 0 },
    { uuid: "space-2", name: "Two", icon: "", containerTabId: 0 },
  ];
  win.gZenWorkspaces = {
    activeWorkspace: "space-1",
    allStoredTabs: [],
    allTabGroups: [],
    currentWindowIsSyncing: true,
    workspaceEnabled: true,
    getWorkspaces: () => spaces,
    getWorkspaceFromId: (id) => spaces.find((space) => space.uuid === id),
    workspaceElement: (id) =>
      spaces.some((space) => space.uuid === id)
        ? { pinnedTabsContainer: {} }
        : null,
    async changeWorkspaceWithID(id) {
      this.activeWorkspace = id;
    },
    saveWorkspace(value) {
      spaces.splice(
        spaces.findIndex((space) => space.uuid === value.uuid),
        1,
        value,
      );
    },
    async removeWorkspace(id) {
      spaces.splice(
        spaces.findIndex((space) => space.uuid === id),
        1,
      );
    },
    async reorderWorkspace(id, position) {
      spaces.splice(
        position,
        0,
        spaces.splice(
          spaces.findIndex((space) => space.uuid === id),
          1,
        )[0],
      );
    },
    moveTabToWorkspace(tab, id) {
      tab.setAttribute("zen-workspace-id", id);
    },
  };
  win.gBrowser = {
    tabContainer: { _invalidateCachedTabs() {} },
    removeTab(tab) {
      tab.closing = true;
      win.gZenWorkspaces.allStoredTabs.splice(
        win.gZenWorkspaces.allStoredTabs.indexOf(tab),
        1,
      );
    },
    moveTabTo(tab, options) {
      tab.index = options.tabIndex;
    },
    pinTab(tab) {
      tab.pinned = true;
    },
    unpinTab(tab) {
      tab.pinned = false;
    },
    discardBrowser(tab) {
      if (tab === this.selectedTab) {
        return false;
      }
      tab.linkedPanel = null;
      tab.setAttribute("discarded", "true");
      return true;
    },
  };
  win.gZenPinnedTabManager = {
    addToEssentials(tab) {
      tab.setAttribute("zen-essential", "true");
      tab.removeAttribute("zen-workspace-id");
      tab.pinned = true;
      return true;
    },
    removeEssentials(tab, unpin) {
      tab.removeAttribute("zen-essential");
      tab.setAttribute("zen-workspace-id", "space-1");
      if (unpin) {
        tab.pinned = false;
      }
    },
  };
  win.gZenViewSplitter = { _data: [], currentView: -1, MAX_TABS: 4 };
  win.gZenWorkspaces.allStoredTabs = Array.from({ length: count }, (_, n) =>
    fakeTab(win, n),
  );
  win.gBrowser.selectedTab = win.gZenWorkspaces.allStoredTabs[0];
  const windows = [win];
  const extraTabs = new Map();
  const service = {
    instanceId: identity.instanceId,
    kind: "playground",
    getWindows: () => windows.filter((value) => !value.closed),
    windowId: (value) => value.id,
    tabId: (tab) => tab.mcpId,
    getWindow: (id) => windows.find((value) => value.id === id),
    getTab: (id) =>
      windows
        .flatMap((value) => value.gZenWorkspaces.allStoredTabs)
        .find((tab) => tab.mcpId === id) || extraTabs.get(id),
    listTabs: (value) => value.gZenWorkspaces.allStoredTabs,
    notify: (kind, payload) => notifications.push({ kind, payload }),
    state: () => ({
      instanceId: identity.instanceId,
      kind: "playground",
      windows: windows.map((value) => ({
        windowId: value.id,
        tabCount: value.gZenWorkspaces.allStoredTabs.length,
      })),
    }),
    assertInstance(args) {
      if (args.instanceId !== identity.instanceId) {
        throw new McpToolError("wrong_instance", "Wrong instance");
      }
    },
  };
  const prefs = new Map();
  globalThis.Services = {
    uuid: { generateUUID: () => `{${randomUUID()}}` },
    io: {
      newURI(raw) {
        const uri = new URL(raw);
        return { scheme: uri.protocol.slice(0, -1), prePath: uri.origin };
      },
    },
    prefs: {
      PREF_BOOL: 128,
      PREF_INT: 64,
      PREF_STRING: 32,
      getPrefType: (name) => prefs.get(name)?.type ?? 0,
      getChildList: (prefix) =>
        [...prefs.keys()].filter((name) => name.startsWith(prefix)),
      getBoolPref: (name) => prefs.get(name)?.value,
      getIntPref: (name, fallback) => prefs.get(name)?.value ?? fallback,
      getStringPref: (name) => prefs.get(name)?.value,
      prefIsLocked: (name) => prefs.get(name)?.locked ?? false,
      prefHasUserValue: (name) => prefs.get(name)?.user ?? false,
      setBoolPref: (name, value) =>
        prefs.set(name, { type: 128, value, user: true }),
      setIntPref: (name, value) =>
        prefs.set(name, { type: 64, value, user: true }),
      setStringPref: (name, value) =>
        prefs.set(name, { type: 32, value, user: true }),
      clearUserPref: (name) => prefs.delete(name),
    },
  };
  mocks.SessionStore = {
    getLazyTabValue: (tab, key) => tab.lazy[key],
    getClosedTabData: () => [],
    getClosedWindowData: () => [],
  };
  return {
    win,
    windows,
    service,
    notifications,
    prefs,
    extraTabs,
    provider: new ZenMcpBrowserTools(service),
    data: new ZenMcpDataTools(service),
  };
}

const execute = (provider, name, args = {}, signal) =>
  provider.execute(name, { ...identity, ...args }, client, signal);
const rejectsCode = (promise, code) =>
  assert.rejects(
    promise,
    (error) => error instanceof McpToolError && error.code === code,
  );

test("all native and data tools expose explicit strict identity/argument/result schemas", () => {
  const { provider } = fixture();
  const tools = provider.getTools();
  assert.equal(tools.length, 34);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith("zen_"));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.type, "object");
    assert.ok(Object.keys(tool.outputSchema.properties).length > 2);
    assert.equal(
      tool.inputSchema.required.includes("instanceId"),
      tool.name !== "zen_browser_state",
    );
    assert.equal(
      tool.annotations.readOnlyHint,
      tool.name.endsWith("_list") || tool.name === "zen_browser_state",
    );
    if (tool.inputSchema.properties.action) {
      assert.ok(tool.inputSchema.required.includes("action"));
    }
  }
});

test("state works without identity; other calls reject wrong instance and missing targets", async () => {
  const { provider } = fixture();
  assert.equal(
    (await provider.execute("zen_browser_state", {}, client)).instanceId,
    identity.instanceId,
  );
  await rejectsCode(
    provider.execute(
      "zen_tabs_list",
      { instanceId: "old", windowId: "window-1" },
      client,
    ),
    "wrong_instance",
  );
  await rejectsCode(execute(provider, "zen_tabs_list"), "invalid_argument");
  await rejectsCode(
    execute(provider, "zen_tab", { action: "mute", muted: true }),
    "invalid_argument",
  );
  await rejectsCode(execute(provider, "zen_fake"), "unknown_tool");
});

test("1500 allStoredTabs paginate without waking lazy browsers or dropping inactive Spaces", async () => {
  const { win, provider } = fixture(1500);
  win.gZenWorkspaces.allStoredTabs[1400].setAttribute(
    "zen-workspace-id",
    "space-2",
  );
  const first = await execute(provider, "zen_tabs_list", { windowId: win.id });
  assert.equal(first.total, 1500);
  assert.equal(first.items.length, 100);
  assert.equal(first.nextCursor, "100");
  assert.equal(first.items[0].url, "https://example.test/0");
  assert.equal(first.items[0].documentId, null);
  assert.ok(first.items.every((tab) => !tab.loaded));
  const last = await execute(provider, "zen_tabs_list", {
    windowId: win.id,
    cursor: "1400",
    limit: 500,
  });
  assert.equal(last.items.length, 100);
  assert.equal(last.nextCursor, undefined);
  assert.equal(last.items[0].spaceId, "space-2");
  assert.equal(
    (
      await execute(provider, "zen_tabs_list", {
        windowId: win.id,
        spaceId: "space-2",
      })
    ).total,
    1,
  );
  await rejectsCode(
    execute(provider, "zen_tabs_list", { windowId: win.id, limit: 501 }),
    "invalid_limit",
  );
  await rejectsCode(
    execute(provider, "zen_tabs_list", { windowId: win.id, cursor: "001" }),
    "invalid_cursor",
  );
});

test("explicit targets exclude private/stale tabs even if getTab returns them", async () => {
  const { provider, extraTabs } = fixture();
  const privateWin = { gZenWorkspaces: { allStoredTabs: [] } };
  const privateTab = fakeTab(privateWin, "private");
  extraTabs.set(privateTab.mcpId, privateTab);
  await rejectsCode(
    execute(provider, "zen_tab", {
      action: "mute",
      tabId: privateTab.mcpId,
      muted: true,
    }),
    "unknown_tab",
  );
  await rejectsCode(
    execute(provider, "zen_tab", { action: "select", tabId: "closed" }),
    "unknown_tab",
  );
  await rejectsCode(
    execute(provider, "zen_tabs_list", { windowId: "private" }),
    "unknown_window",
  );
});

test("pin/mute/move return actual changed state and do not affect other tabs", async () => {
  const { provider, win } = fixture();
  const a = win.gZenWorkspaces.allStoredTabs[1];
  const b = win.gZenWorkspaces.allStoredTabs[2];
  assert.equal(
    (
      await execute(provider, "zen_tab", {
        action: "mute",
        tabId: a.mcpId,
        muted: true,
      })
    ).tab.muted,
    true,
  );
  assert.equal(
    (
      await execute(provider, "zen_tab", {
        action: "pin",
        tabId: a.mcpId,
        mode: "pinned",
      })
    ).tab.pinned,
    true,
  );
  assert.equal(
    (
      await execute(provider, "zen_tab", {
        action: "move",
        tabId: a.mcpId,
        spaceId: "space-2",
      })
    ).tab.spaceId,
    "space-2",
  );
  assert.equal(b.pinned, false);
  assert.equal(b.hasAttribute("muted"), false);
  assert.equal(b.getAttribute("zen-workspace-id"), "space-1");
  await rejectsCode(
    execute(provider, "zen_tab", { action: "mute", tabId: a.mcpId }),
    "invalid_argument",
  );
  await rejectsCode(
    execute(provider, "zen_tab", { action: "move", tabId: a.mcpId }),
    "invalid_argument",
  );
});

test("failed essential-space moves validate before adopting the tab", async () => {
  const { win, service, provider, windows } = fixture();
  const tab = win.gZenWorkspaces.allStoredTabs[1];
  tab.setAttribute("zen-essential", "true");
  const destination = {
    ...win,
    id: "window-2",
    gBrowser: {
      ...win.gBrowser,
      adoptTab() {
        assert.fail("must not adopt before validation");
      },
    },
  };
  windows.push(destination);
  await rejectsCode(
    execute(provider, "zen_tab", {
      action: "move",
      tabId: tab.mcpId,
      destinationWindowId: service.windowId(destination),
      spaceId: "space-2",
    }),
    "essential_has_no_space",
  );
});

test("Space update/switch/reorder read back metadata and last Space removal is refused", async () => {
  const { provider, win } = fixture();
  const target = { windowId: win.id, spaceId: "space-2" };
  assert.equal(
    (
      await execute(provider, "zen_space", {
        ...target,
        action: "update",
        name: "Changed",
      })
    ).space.name,
    "Changed",
  );
  assert.equal(
    (await execute(provider, "zen_space", { ...target, action: "switch" }))
      .space.selected,
    true,
  );
  await execute(provider, "zen_space", {
    ...target,
    action: "reorder",
    index: 0,
  });
  assert.equal(
    (await execute(provider, "zen_spaces_list", { windowId: win.id })).items[0]
      .spaceId,
    "space-2",
  );
  await execute(provider, "zen_space", {
    windowId: win.id,
    spaceId: "space-1",
    action: "remove",
  });
  await rejectsCode(
    execute(provider, "zen_space", { ...target, action: "remove" }),
    "last_space",
  );
});

test("closed-session lists return minimal public metadata; reopen IDs must come from the requested source", async () => {
  const { provider, win } = fixture();
  mocks.SessionStore.getClosedTabData = (options) => {
    assert.equal(options.private, false);
    assert.equal(options.sourceWindow, win);
    assert.equal(options.closedTabsFromAllWindows, false);
    return [
      {
        closedId: 7,
        title: "Synthetic",
        state: {
          index: 1,
          entries: [{ url: "https://example.test", title: "Synthetic" }],
          cookies: [{ value: "must-not-leak" }],
        },
      },
    ];
  };
  mocks.SessionStore.getClosedWindowData = () => [
    { closedId: 8, title: "Public", tabs: [] },
    { closedId: 9, title: "Private", isPrivate: true },
  ];
  const tabs = await execute(provider, "zen_closed_tabs_list", {
    windowId: win.id,
  });
  assert.equal(tabs.items[0].closedId, 7);
  assert.equal(JSON.stringify(tabs).includes("must-not-leak"), false);
  assert.equal((await execute(provider, "zen_closed_windows_list")).total, 1);
  await rejectsCode(
    execute(provider, "zen_tab", {
      action: "reopen",
      windowId: win.id,
      closedId: 42,
    }),
    "unknown_closed_tab",
  );
  await rejectsCode(
    execute(provider, "zen_window", {
      action: "reopen",
      windowId: win.id,
      closedId: 9,
    }),
    "unknown_closed_window",
  );
});

test("media enumeration skips unloaded browsers and accepts absent native position state", async () => {
  const { provider, win } = fixture();
  const tab = fakeTab(win, 50, { loaded: true });
  tab.linkedBrowser.browsingContext.mediaController = {
    id: 1,
    isActive: true,
    isPlaying: true,
    supportedKeys: ["play", "pause"],
    getMetadata: () => ({ title: "Synthetic audio" }),
    getPositionState() {
      throw { result: Cr.NS_ERROR_NOT_AVAILABLE };
    },
    pause(reason) {
      assert.equal(reason, "user");
      this.isPlaying = false;
    },
  };
  win.gZenWorkspaces.allStoredTabs.push(tab);
  const listed = await execute(provider, "zen_media_list", {
    windowId: win.id,
  });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].media.position, null);
  assert.equal(
    (
      await execute(provider, "zen_media", {
        action: "pause",
        tabId: tab.mcpId,
      })
    ).tab.media.playing,
    false,
  );
  await rejectsCode(
    execute(provider, "zen_media", {
      action: "seek",
      tabId: tab.mcpId,
      positionSeconds: 10,
    }),
    "media_key_unsupported",
  );
  await rejectsCode(
    execute(provider, "zen_media", { action: "play", tabId: "tab-1" }),
    "tab_unloaded",
  );
});

test("history pagination visits only requested native nodes and closes the result", async () => {
  const { data } = fixture();
  const indexes = [];
  const root = {
    childCount: 1000,
    containerOpen: false,
    getChild(n) {
      indexes.push(n);
      return {
        pageGuid: `g${n}`,
        uri: `https://example.test/${n}`,
        title: "History",
        accessCount: 2,
        time: 123000,
      };
    },
  };
  const query = {};
  mocks.PlacesUtils = {
    history: {
      getNewQuery: () => query,
      getNewQueryOptions: () => ({}),
      executeQuery: () => ({ root }),
    },
  };
  const result = await execute(data, "zen_history_list", {
    cursor: "400",
    limit: 3,
    since: 1000,
  });
  assert.deepEqual(indexes, [400, 401, 402]);
  assert.equal(result.total, 1000);
  assert.equal(result.nextCursor, "403");
  assert.equal(result.items[0].lastVisitTime, 123);
  assert.equal(query.beginTime, 1000000);
  assert.equal(root.containerOpen, false);
});

test("single-page history also paginates visit lists", async () => {
  const { data } = fixture();
  mocks.PlacesUtils = {
    history: {
      async fetch() {
        return {
          guid: "history",
          url: new URL("https://example.test"),
          title: null,
          visits: Array.from({ length: 1500 }, (_, n) => ({
            date: new Date(n),
            transition: 1,
          })),
        };
      },
    },
  };
  const result = await execute(data, "zen_history_list", {
    url: "https://example.test",
    cursor: "1300",
  });
  assert.equal(result.total, 1500);
  assert.equal(result.nextCursor, "1400");
  assert.equal(result.item.visits.length, 100);
  assert.equal(result.item.title, "");
  assert.equal(result.item.visits[0].date, new Date(1300).toISOString());
});

test("cookie writes use milliseconds/public attributes and read back Gecko validation", async () => {
  const { data } = fixture();
  const values = [
    {
      host: "secret.test",
      name: "private",
      originAttributes: { privateBrowsingId: 1 },
    },
  ];
  const calls = [];
  Services.cookies = {
    cookies: values,
    add(...args) {
      calls.push(args);
      const [
        host,
        path,
        name,
        value,
        isSecure,
        isHttpOnly,
        isSession,
        expiry,
        attrs,
        sameSite,
        schemeMap,
        isPartitioned,
      ] = args;
      values.push({
        host,
        path,
        name,
        value,
        isSecure,
        isHttpOnly,
        isSession,
        expiry,
        originAttributes: attrs,
        sameSite,
        schemeMap,
        isPartitioned,
      });
      return { result: 0 };
    },
  };
  const expiry = 1791500000000;
  const result = await execute(data, "zen_cookie", {
    action: "set",
    host: "example.test",
    name: "demo",
    value: "ok",
    expiry,
    originAttributes: { userContextId: 2 },
  });
  assert.equal(calls[0][7], expiry);
  assert.deepEqual(calls[0][8], { userContextId: 2, privateBrowsingId: 0 });
  assert.equal(result.item.value, "ok");
  assert.equal(result.item.isSession, false);
  assert.equal((await execute(data, "zen_cookies_list")).total, 1);
  await rejectsCode(
    execute(data, "zen_cookie", {
      action: "set",
      host: "example.test",
      name: "x",
      value: "",
      originAttributes: { privateBrowsingId: 1 },
    }),
    "invalid_origin_attributes",
  );
  Services.cookies.add = () => ({ result: 1, errorString: "Native rejection" });
  await rejectsCode(
    execute(data, "zen_cookie", {
      action: "set",
      host: "example.test",
      name: "x",
      value: "",
    }),
    "cookie_rejected",
  );
});

test("typed preferences preserve locked/type boundaries and reject invalid writes", async () => {
  const { data, prefs } = fixture();
  prefs.set("test.locked", { type: 128, value: true, locked: true });
  prefs.set("test.integer", { type: 64, value: 1 });
  await rejectsCode(
    execute(data, "zen_preference", {
      action: "set",
      name: "test.locked",
      type: "boolean",
      value: false,
    }),
    "locked_preference",
  );
  await rejectsCode(
    execute(data, "zen_preference", {
      action: "set",
      name: "test.integer",
      type: "string",
      value: "3",
    }),
    "preference_type_mismatch",
  );
  await rejectsCode(
    execute(data, "zen_preference", {
      action: "set",
      name: "new",
      type: "integer",
      value: 2 ** 31,
    }),
    "invalid_argument",
  );
  const changed = await execute(data, "zen_preference", {
    action: "set",
    name: "test.integer",
    type: "integer",
    value: 8,
  });
  assert.equal(changed.item.value, 8);
  assert.equal(changed.item.hasUserValue, true);
  const listed = await execute(data, "zen_preferences_list", {
    prefix: "test.",
    limit: 1,
  });
  assert.equal(listed.total, 2);
  assert.equal(listed.nextCursor, "1");
});

test("storage delegates exact tab/frame/area scope and validates before mutating", async () => {
  const { data, service } = fixture();
  const calls = [];
  service.pageTools = {
    async query(...args) {
      calls.push(args);
      return { origin: "https://example.test", documentId: "1", value: "demo" };
    },
  };
  const args = {
    action: "set",
    tabId: "tab-1",
    frameId: "frame-2",
    area: "session",
    key: "",
    value: "value",
  };
  const result = await execute(data, "zen_storage", args);
  assert.equal(calls[0][0], "tab-1");
  assert.equal(calls[0][1], "frame-2");
  assert.equal(calls[0][2], "storage");
  assert.equal(calls[0][3].area, "session");
  assert.equal(result.documentId, "1");
  await rejectsCode(
    execute(data, "zen_storage", { ...args, value: 1 }),
    "invalid_argument",
  );
  await rejectsCode(
    execute(data, "zen_storage", {
      action: "clear",
      tabId: "tab-1",
      area: "indexedDB",
    }),
    "invalid_argument",
  );
  await execute(data, "zen_storage", {
    action: "set",
    tabId: "tab-1",
    area: "indexedDB",
    database: "demo",
    store: "items",
    key: 2,
    value: { hello: true },
  });
  assert.equal(calls[1][3].database, "demo");
  assert.deepEqual(calls[1][3].value, { hello: true });
});

test("public downloads exclude private records and removal does not delete completed files", async () => {
  const { data } = fixture();
  const ops = [];
  const a = {
    source: { url: "https://example.test/file", isPrivate: false },
    target: { path: "/tmp/synthetic", exists: true },
    startTime: new Date(),
    stopped: true,
    succeeded: true,
    cancel: async () => ops.push("cancel"),
    finalize: async (remove) => ops.push(["finalize", remove]),
  };
  const values = [a, { source: { isPrivate: true } }];
  const list = {
    getAll: async () => values,
    remove: async (value) => values.splice(values.indexOf(value), 1),
  };
  mocks.Downloads = {
    PUBLIC: "public",
    getList: async (type) => {
      assert.equal(type, "public");
      return list;
    },
  };
  const listed = await execute(data, "zen_downloads_list");
  assert.equal(listed.total, 1);
  const id = listed.items[0].downloadId;
  assert.equal(
    (await execute(data, "zen_downloads_list")).items[0].downloadId,
    id,
  );
  const removed = await execute(data, "zen_download", {
    action: "remove",
    downloadId: id,
  });
  assert.equal(removed.removed, true);
  assert.deepEqual(ops, ["cancel", ["finalize", false]]);
  await rejectsCode(
    execute(data, "zen_download", { action: "cancel", downloadId: id }),
    "unknown_download",
  );
});

test("extension policies are enforced and client cleanup cancels only owned installations", async () => {
  const { data } = fixture();
  const value = { id: "system", permissions: 0 };
  mocks.AddonManager = {
    getAddonByID: async () => value,
    PERM_CAN_ENABLE: 2,
    PERM_CAN_DISABLE: 4,
    PERM_CAN_UNINSTALL: 1,
  };
  await rejectsCode(
    execute(data, "zen_extension", { action: "uninstall", addonId: "system" }),
    "addon_policy",
  );
  const cancelled = [];
  data.installs.set("a", {
    clientId: "a",
    install: { cancel: () => cancelled.push("a") },
  });
  data.installs.set("b", {
    clientId: "b",
    install: { cancel: () => cancelled.push("b") },
  });
  data.cleanup("a");
  assert.deepEqual(cancelled, ["a"]);
  assert.equal(data.installs.size, 1);
  data.destroy();
  assert.deepEqual(cancelled, ["a", "b"]);
  assert.equal(data.installs.size, 0);
});

test("already cancelled calls never change native/profile state", async () => {
  const { provider, win } = fixture();
  const abort = new AbortController();
  abort.abort();
  await rejectsCode(
    execute(
      provider,
      "zen_tab",
      { action: "mute", tabId: "tab-1", muted: true },
      abort.signal,
    ),
    "cancelled",
  );
  assert.equal(
    win.gZenWorkspaces.allStoredTabs[1].hasAttribute("muted"),
    false,
  );
});

test("new window waits for the service's Zen-ready identity rather than only Gecko startup", async () => {
  const { provider, win, windows, service } = fixture();
  const created = {
    ...win,
    id: "window-2",
    ready: false,
    gBrowser: { ...win.gBrowser, selectedTab: null },
    gZenWorkspaces: { ...win.gZenWorkspaces, allStoredTabs: [] },
  };
  win.ready = true;
  windows.push(created);
  service.getWindows = () =>
    windows.filter((window) => window.ready && !window.closed);
  win.OpenBrowserWindow = (options) => {
    assert.equal(options.private, false);
    setTimeout(() => {
      created.ready = true;
    }, 1);
    return created;
  };
  const result = await execute(provider, "zen_window", {
    action: "create",
    windowId: win.id,
  });
  assert.equal(result.window.windowId, created.id);
  assert.equal(created.ready, true);
});

test("group/Split View creation reject mismatched Spaces before calling native mutators", async () => {
  const { provider, win } = fixture();
  const first = win.gZenWorkspaces.allStoredTabs[0];
  const second = win.gZenWorkspaces.allStoredTabs[1];
  second.setAttribute("zen-workspace-id", "space-2");
  win.gBrowser.addTabGroup = () =>
    assert.fail("must validate before creating a group");
  win.gZenViewSplitter.splitTabs = () =>
    assert.fail("must validate before splitting tabs");
  const args = {
    action: "create",
    windowId: win.id,
    tabIds: [first.mcpId, second.mcpId],
  };
  await rejectsCode(
    execute(provider, "zen_group", args),
    "group_target_mismatch",
  );
  await rejectsCode(
    execute(provider, "zen_split", args),
    "split_target_mismatch",
  );
  await rejectsCode(
    execute(provider, "zen_split", { ...args, tabIds: [first.mcpId] }),
    "split_tab_count",
  );
  await rejectsCode(
    execute(provider, "zen_group", {
      ...args,
      tabIds: [first.mcpId, first.mcpId],
    }),
    "invalid_argument",
  );
});

test("folder nesting refuses cycles and checks the configured limit for the entire subtree", () => {
  const { provider, prefs } = fixture();
  const child = { isZenFolder: true, allItems: [] };
  const folder = { allItems: [child], allItemsRecursive: [child] };
  assert.throws(
    () => provider.validateFolderParent(folder, folder),
    (error) => error.code === "folder_cycle",
  );
  assert.throws(
    () => provider.validateFolderParent(folder, child),
    (error) => error.code === "folder_cycle",
  );
  prefs.set("zen.folders.max-subfolders", { type: 64, value: 3 });
  assert.throws(
    () => provider.validateFolderParent(folder, { level: 1 }),
    (error) => error.code === "folder_depth",
  );
  assert.doesNotThrow(() =>
    provider.validateFolderParent(
      { allItems: [], allItemsRecursive: [] },
      { level: 1 },
    ),
  );
});

test("bookmark folder CRUD uses GUIDs/native types and reports observed removal", async () => {
  const { data } = fixture();
  const items = new Map();
  let n = 0;
  mocks.PlacesUtils = {
    bookmarks: {
      rootGuid: "root",
      TYPE_BOOKMARK: 1,
      TYPE_FOLDER: 2,
      TYPE_SEPARATOR: 3,
      async insert(info) {
        const item = {
          ...info,
          guid: `guid-${++n}`,
          index: n,
          dateAdded: new Date(0),
          lastModified: new Date(0),
        };
        items.set(item.guid, item);
        return item;
      },
      async fetch(id, callback) {
        if (typeof id === "string") {
          return items.get(id) ?? null;
        }
        for (const item of items.values()) {
          if (item.parentGuid === id.parentGuid) {
            callback(item);
          }
        }
        return null;
      },
      async update(info) {
        Object.assign(items.get(info.guid), info);
      },
      async remove(id) {
        items.delete(id);
      },
    },
  };
  await rejectsCode(
    execute(data, "zen_bookmark", {
      action: "create",
      type: "folder",
      title: "Folder",
    }),
    "invalid_argument",
  );
  const created = await execute(data, "zen_bookmark", {
    action: "create",
    type: "folder",
    title: "Folder",
    parentGuid: "root",
  });
  assert.equal(created.item.type, 2);
  assert.equal(created.item.url, null);
  assert.equal(created.item.dateAdded, "1970-01-01T00:00:00.000Z");
  const updated = await execute(data, "zen_bookmark", {
    action: "update",
    guid: created.item.guid,
    title: "Renamed",
  });
  assert.equal(updated.item.title, "Renamed");
  assert.equal(
    (await execute(data, "zen_bookmarks_list")).items[0].guid,
    created.item.guid,
  );
  const removed = await execute(data, "zen_bookmark", {
    action: "remove",
    guid: created.item.guid,
  });
  assert.equal(removed.removed, true);
});

test("site permission writes use explicit public principals and validated native states", async () => {
  const { data } = fixture();
  const principalCalls = [];
  const state = { state: 0, scope: "persistent" };
  Services.scriptSecurityManager = {
    createContentPrincipal(uri, attributes) {
      principalCalls.push(attributes);
      return { origin: uri.prePath, originAttributes: attributes };
    },
  };
  const nativeCalls = [];
  mocks.SitePermissions = {
    SCOPE_PERSISTENT: "persistent",
    SCOPE_SESSION: "session",
    listPermissions: () => ["camera"],
    getAvailableStates: () => [0, 1, 2],
    setForPrincipal(principal, permission, value, scope) {
      nativeCalls.push({ principal, permission });
      Object.assign(state, { state: value, scope });
    },
    getForPrincipal: () => state,
  };
  const result = await execute(data, "zen_permission", {
    action: "set",
    origin: "https://example.test",
    permission: "camera",
    state: 1,
    scope: "session",
    originAttributes: { userContextId: 2 },
  });
  assert.equal(result.state, 1);
  assert.equal(result.scope, "session");
  assert.deepEqual(principalCalls[0], {
    userContextId: 2,
    privateBrowsingId: 0,
  });
  await rejectsCode(
    execute(data, "zen_permission", {
      action: "set",
      origin: "https://example.test",
      permission: "camera",
      state: 99,
    }),
    "invalid_permission_state",
  );
  await rejectsCode(
    execute(data, "zen_permission", {
      action: "set",
      origin: "https://example.test/page",
      permission: "camera",
      state: 1,
    }),
    "invalid_origin",
  );
  assert.equal(nativeCalls.length, 1);
  Services.perms = {
    all: [
      {
        principal: {
          origin: "https://example.test",
          originAttributes: { privateBrowsingId: 0 },
        },
        type: "camera",
        capability: 1,
      },
      {
        principal: {
          origin: "https://private.test",
          originAttributes: { privateBrowsingId: 1 },
        },
        type: "camera",
        capability: 1,
      },
    ],
  };
  const listed = await execute(data, "zen_permissions_list");
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].origin, "https://example.test");
});
