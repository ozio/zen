// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  McpToolError,
  makeTool,
  paginate,
  requireValue,
  schema,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import { ZenMcpDataTools } from "resource:///modules/zen/mcp/ZenMcpDataTools.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService:
    "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs",
  PictureInPicture:
    "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const page = {
  cursor: schema.string,
  limit: { type: "integer", minimum: 1, maximum: 500 },
};
const index = { type: "integer", minimum: 0 };
const targetWindow = { windowId: schema.string };
const targetGroup = { ...targetWindow, groupId: schema.string };
const tabIds = {
  type: "array",
  items: schema.string,
  minItems: 1,
  uniqueItems: true,
};
const nullableString = { type: ["string", "null"] };
const windowSchema = {
  type: "object",
  properties: {
    windowId: schema.string,
    selectedTabId: nullableString,
    activeSpaceId: nullableString,
    tabCount: schema.integer,
    state: schema.integer,
    synced: schema.boolean,
    bounds: {
      type: "object",
      properties: {
        x: schema.integer,
        y: schema.integer,
        width: schema.integer,
        height: schema.integer,
      },
    },
  },
};
const tabSchema = {
  type: "object",
  properties: {
    tabId: schema.string,
    windowId: schema.string,
    documentId: nullableString,
    url: schema.string,
    title: schema.string,
    selected: schema.boolean,
    loaded: schema.boolean,
    pending: schema.boolean,
    discarded: schema.boolean,
    pinned: schema.boolean,
    essential: schema.boolean,
    muted: schema.boolean,
    soundPlaying: schema.boolean,
    hidden: schema.boolean,
    spaceId: nullableString,
    containerId: schema.integer,
    groupId: nullableString,
    splitView: schema.boolean,
    index: { type: ["integer", "null"] },
    pictureInPicture: schema.boolean,
    media: {
      type: ["object", "null"],
      properties: {
        controllerId: schema.string,
        playing: schema.boolean,
        audible: schema.boolean,
        muted: schema.boolean,
        playbackState: schema.string,
        supportedKeys: schema.strings,
        metadata: schema.object,
        position: { type: ["object", "null"] },
      },
    },
  },
};
const spaceSchema = {
  type: "object",
  properties: {
    spaceId: schema.string,
    windowId: schema.string,
    name: schema.string,
    icon: nullableString,
    containerId: schema.integer,
    selected: schema.boolean,
  },
};
const containerSchema = {
  type: "object",
  properties: {
    containerId: schema.integer,
    name: schema.string,
    icon: schema.string,
    color: schema.string,
    sites: schema.strings,
  },
};
const groupSchema = {
  type: ["object", "null"],
  properties: {
    windowId: schema.string,
    groupId: schema.string,
    kind: schema.string,
    name: schema.string,
    color: schema.string,
    collapsed: schema.boolean,
    spaceId: nullableString,
    parentGroupId: nullableString,
    icon: nullableString,
    tabIds: schema.strings,
    childGroupIds: schema.strings,
  },
};
const splitSchema = {
  type: ["object", "null"],
  properties: {
    windowId: schema.string,
    groupId: schema.string,
    layout: schema.string,
    selected: schema.boolean,
    tabIds: schema.strings,
    layoutTree: schema.object,
  },
};

function listOutput(item) {
  return {
    items: { type: "array", items: item },
    total: schema.integer,
    nextCursor: schema.string,
  };
}

function describeOutput(tool, properties) {
  return {
    ...tool,
    outputSchema: {
      ...tool.outputSchema,
      properties: { ...tool.outputSchema.properties, ...properties },
    },
  };
}

function string(value, field, allowEmpty = false) {
  requireValue(
    typeof value === "string" && (allowEmpty || !!value.trim().length),
    "invalid_argument",
    `${field} must be a ${allowEmpty ? "" : "non-empty "}string`
  );
  return value;
}

function integer(value, field, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(
    Number.isSafeInteger(value) && value >= minimum && value <= maximum,
    "invalid_argument",
    `${field} must be an integer from ${minimum} to ${maximum}`
  );
  return value;
}

function boolean(value, field) {
  requireValue(
    typeof value === "boolean",
    "invalid_argument",
    `${field} must be boolean`
  );
  return value;
}

/** Native Zen APIs; tab-list reads deliberately avoid browser-binding properties. */
export class ZenMcpBrowserTools {
  constructor(service) {
    this.service = service;
    this.data = new ZenMcpDataTools(service);
  }

  getTools() {
    return (this.tools ??= [
      makeTool(
        "zen_browser_state",
        "Identify this Zen instance/build and enumerate ready non-private windows and counts. No target is inferred from focus.",
        {},
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_windows_list",
        "List ready non-private browser windows, their bounds and explicit selected tab/Space IDs.",
        page,
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_window",
        "Create a regular window using windowId as explicit opener, or focus/close/resize/minimize/maximize/restore/reopen a window. reopen requires closedId from closed_windows_list. Browser unload checks remain active.",
        {
          action: schema.enum(
            "create",
            "focus",
            "close",
            "resize",
            "minimize",
            "maximize",
            "restore",
            "reopen"
          ),
          ...targetWindow,
          closedId: index,
          x: schema.integer,
          y: schema.integer,
          width: { type: "integer", minimum: 100 },
          height: { type: "integer", minimum: 100 },
          synced: schema.boolean,
        },
        ["action", "windowId"]
      ),
      makeTool(
        "zen_tabs_list",
        "List all stored tabs in an explicit window, including inactive Spaces and unloaded tabs, without inserting/loading their browsers. Optional Space/container filter; 100 per page by default.",
        {
          ...targetWindow,
          spaceId: schema.string,
          containerId: index,
          ...page,
        },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_tab",
        "Create/select/move/pin/mute/discard/close/reopen an explicit tab. create requires windowId and uses optional spaceId/containerId/url/lazy/select; move requires destinationWindowId and/or spaceId/index. pin mode normal/pinned/essential; mute requires muted; reopen requires windowId/closedId.",
        {
          action: schema.enum(
            "create",
            "select",
            "move",
            "pin",
            "mute",
            "discard",
            "close",
            "reopen"
          ),
          tabId: schema.string,
          ...targetWindow,
          destinationWindowId: schema.string,
          spaceId: schema.string,
          containerId: index,
          url: schema.string,
          lazy: schema.boolean,
          select: schema.boolean,
          mode: schema.enum("normal", "pinned", "essential"),
          muted: schema.boolean,
          index,
          closedId: index,
        },
        ["action"]
      ),
      makeTool(
        "zen_closed_tabs_list",
        "List restorable tabs from one explicit regular window. closedId is instance-scoped; full session state/cookies/form data are not returned.",
        { ...targetWindow, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_closed_windows_list",
        "List restorable regular windows with closedId and a minimal tab count/title; private sessions are excluded.",
        page,
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_spaces_list",
        "List Zen Spaces and current selection in an explicit window.",
        { ...targetWindow, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_space",
        "Create/update/switch/remove/reorder a Space using Zen's workspace manager. create requires name; other actions require spaceId. Removing a Space closes its owned tabs; at least one Space must remain.",
        {
          action: schema.enum(
            "create",
            "update",
            "switch",
            "remove",
            "reorder"
          ),
          ...targetWindow,
          spaceId: schema.string,
          name: schema.string,
          icon: schema.string,
          containerId: index,
          index,
          select: schema.boolean,
        },
        ["action", "windowId"]
      ),
      makeTool(
        "zen_containers_list",
        "List public Firefox containers and their exact-host associations.",
        page,
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_container",
        "Create/update/remove/reorder public containers or associate/unassociate an exact site host. Removal uses the native container service and closes public tabs in that container. create requires name; other actions require containerId (except unassociate); associate/unassociate require site.",
        {
          action: schema.enum(
            "create",
            "update",
            "remove",
            "reorder",
            "associate",
            "unassociate"
          ),
          containerId: index,
          name: schema.string,
          color: schema.string,
          icon: schema.string,
          index,
          site: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_folders_list",
        "List folders from every Space of an explicit window, including nested folders and their tab IDs.",
        { ...targetWindow, spaceId: schema.string, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_folder",
        "Create/update/addTabs/removeTabs/move/unpack/remove a Zen folder. create requires explicit spaceId and name; other actions require groupId. optional parentGroupId nests a folder; empty string moves to Space root. add/removeTabs require tabIds in the same window; remove closes its tabs, unpack preserves non-placeholder tabs.",
        {
          action: schema.enum(
            "create",
            "update",
            "addTabs",
            "removeTabs",
            "move",
            "unpack",
            "remove"
          ),
          ...targetGroup,
          spaceId: schema.string,
          name: schema.string,
          icon: schema.string,
          collapsed: schema.boolean,
          parentGroupId: schema.string,
          index,
          tabIds,
        },
        ["action", "windowId"]
      ),
      makeTool(
        "zen_groups_list",
        "List ordinary tab groups from all Spaces in an explicit window; folders and Split View groups use their separate tools.",
        { ...targetWindow, spaceId: schema.string, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_group",
        "Create/update/addTabs/removeTabs/move/ungroup/remove a regular tab group. create requires tabIds in the same Space/window; other actions require groupId. name/color/collapsed update metadata, move requires index. remove closes tabs; ungroup preserves them.",
        {
          action: schema.enum(
            "create",
            "update",
            "addTabs",
            "removeTabs",
            "move",
            "ungroup",
            "remove"
          ),
          ...targetGroup,
          tabIds,
          name: schema.string,
          color: schema.string,
          collapsed: schema.boolean,
          index,
        },
        ["action", "windowId"]
      ),
      makeTool(
        "zen_splits_list",
        "List Split Views and their layout/tab IDs in an explicit window without loading tabs.",
        { ...targetWindow, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_split",
        "Create/update/select/remove/removeTab a Split View. create requires 2..4 visible non-essential tabs in one Space/window; other actions require groupId. layout grid/vsep/hsep; remove preserves tabs, removeTab requires tabId.",
        {
          action: schema.enum(
            "create",
            "update",
            "select",
            "remove",
            "removeTab"
          ),
          ...targetGroup,
          tabIds,
          tabId: schema.string,
          layout: schema.enum("grid", "vsep", "hsep"),
          select: schema.boolean,
          selectedTabId: schema.string,
        },
        ["action", "windowId"]
      ),
      makeTool(
        "zen_media_list",
        "Read playback metadata/controllers from loaded tabs in one explicit window; unloaded tabs remain unloaded.",
        { ...targetWindow, ...page },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_media",
        "Control an explicit loaded tab's media: play/pause/stop/previous/next/seek/mute/unmute or PiP open/close. seek uses positionSeconds; PiP opens the native eligible video selected by Firefox's launcher and closes only PiP windows associated with this tab.",
        {
          action: schema.enum(
            "play",
            "pause",
            "stop",
            "previous",
            "next",
            "seek",
            "mute",
            "unmute",
            "pipOpen",
            "pipClose"
          ),
          tabId: schema.string,
          positionSeconds: { type: "number", minimum: 0 },
        },
        ["action", "tabId"]
      ),
      ...this.data.getTools(),
    ].map(tool => {
      const outputs = {
        zen_browser_state: {
          kind: schema.string,
          windows: { type: "array", items: windowSchema },
        },
        zen_windows_list: listOutput(windowSchema),
        zen_window: {
          window: windowSchema,
          windowId: schema.string,
          closed: schema.boolean,
          windows: { type: "array", items: windowSchema },
        },
        zen_tabs_list: { windowId: schema.string, ...listOutput(tabSchema) },
        zen_tab: {
          tab: tabSchema,
          tabId: schema.string,
          closing: schema.boolean,
          closed: schema.boolean,
          window: windowSchema,
        },
        zen_closed_tabs_list: {
          windowId: schema.string,
          ...listOutput({
            type: "object",
            properties: {
              closedId: schema.integer,
              title: schema.string,
              url: schema.string,
              closedAt: { type: ["integer", "null"] },
              containerId: schema.integer,
            },
          }),
        },
        zen_closed_windows_list: listOutput({
          type: "object",
          properties: {
            closedId: schema.integer,
            title: schema.string,
            tabCount: schema.integer,
            closedAt: { type: ["integer", "null"] },
          },
        }),
        zen_spaces_list: {
          windowId: schema.string,
          activeSpaceId: schema.string,
          ...listOutput(spaceSchema),
        },
        zen_space: {
          space: spaceSchema,
          activeSpaceId: schema.string,
          spaceId: schema.string,
          removed: schema.boolean,
          spaces: { type: "array", items: spaceSchema },
        },
        zen_containers_list: listOutput(containerSchema),
        zen_container: {
          container: containerSchema,
          containerId: schema.integer,
          site: schema.string,
          removed: schema.boolean,
        },
        zen_folders_list: {
          windowId: schema.string,
          ...listOutput(groupSchema),
        },
        zen_folder: {
          folder: groupSchema,
          groupId: schema.string,
          removed: schema.boolean,
        },
        zen_groups_list: {
          windowId: schema.string,
          ...listOutput(groupSchema),
        },
        zen_group: {
          group: groupSchema,
          groupId: schema.string,
          removed: schema.boolean,
        },
        zen_splits_list: {
          windowId: schema.string,
          ...listOutput(splitSchema),
        },
        zen_split: {
          split: splitSchema,
          groupId: schema.string,
          removed: schema.boolean,
          tab: tabSchema,
        },
        zen_media_list: { windowId: schema.string, ...listOutput(tabSchema) },
        zen_media: { tab: tabSchema },
      };
      return outputs[tool.name]
        ? describeOutput(tool, outputs[tool.name])
        : tool;
    }));
  }

  async execute(name, args, client, signal) {
    if (name !== "zen_browser_state") {
      this.service.assertInstance(args);
    }
    requireValue(
      !signal?.aborted,
      "cancelled",
      "The request was cancelled before the operation"
    );
    if (this.data.owns(name)) {
      return this.data.execute(name, args, client, signal);
    }
    const handlers = {
      zen_browser_state: () => this.service.state(),
      zen_windows_list: () => this.windowsList(args),
      zen_window: () => this.windowAction(args, signal),
      zen_tabs_list: () => this.tabsList(args),
      zen_tab: () => this.tabAction(args, signal),
      zen_closed_tabs_list: () => this.closedTabsList(args),
      zen_closed_windows_list: () => this.closedWindowsList(args),
      zen_spaces_list: () => this.spacesList(args),
      zen_space: () => this.spaceAction(args, signal),
      zen_containers_list: () => this.containersList(args),
      zen_container: () => this.containerAction(args, signal),
      zen_folders_list: () => this.groupsList(args, "folder"),
      zen_folder: () => this.folderAction(args, signal),
      zen_groups_list: () => this.groupsList(args, "group"),
      zen_group: () => this.groupAction(args),
      zen_splits_list: () => this.splitsList(args),
      zen_split: () => this.splitAction(args),
      zen_media_list: () => this.mediaList(args),
      zen_media: () => this.mediaAction(args, signal),
    };
    requireValue(
      handlers[name],
      "unknown_tool",
      `Unknown native tool: ${name}`
    );
    return { instanceId: this.service.instanceId, ...(await handlers[name]()) };
  }

  window(id) {
    const win = this.service.getWindow(string(id, "windowId"));
    requireValue(
      win && !win.closed && this.service.getWindows().includes(win),
      "unknown_window",
      "Window is closed, private or belongs to another instance"
    );
    return win;
  }

  tab(id, win) {
    const tab = this.service.getTab(string(id, "tabId"));
    const owner = tab?.ownerGlobal ?? tab?.documentGlobal;
    requireValue(
      tab &&
        owner &&
        this.service.getWindows().includes(owner) &&
        !tab.closing &&
        (!win || owner === win) &&
        this.service.listTabs(owner).includes(tab),
      "unknown_tab",
      "Tab is closed, private, from another window or belongs to another instance"
    );
    return tab;
  }

  tabs(ids, win) {
    requireValue(
      Array.isArray(ids) && !!ids.length && new Set(ids).size === ids.length,
      "invalid_argument",
      "tabIds must be a non-empty array of unique explicit IDs"
    );
    return ids.map(id => this.tab(id, win));
  }

  tabState(tab) {
    const win = tab.ownerGlobal ?? tab.documentGlobal;
    const loaded = !!tab.linkedPanel;
    const browser = tab.linkedBrowser;
    // SessionStore's lazy state avoids the 27 browser properties which insert browsers on read.
    const url = loaded
      ? browser.currentURI?.spec || "about:blank"
      : lazy.SessionStore.getLazyTabValue(tab, "url") || "about:blank";
    const global = loaded ? browser.browsingContext?.currentWindowGlobal : null;
    return {
      tabId: this.service.tabId(tab),
      windowId: this.service.windowId(win),
      documentId: global ? String(global.innerWindowId) : null,
      url,
      title:
        tab.label ||
        (loaded ? "" : lazy.SessionStore.getLazyTabValue(tab, "title")) ||
        "",
      selected: win.gBrowser.selectedTab === tab,
      loaded,
      pending: tab.hasAttribute("pending"),
      discarded: tab.hasAttribute("discarded"),
      pinned: !!tab.pinned,
      essential: tab.hasAttribute("zen-essential"),
      muted: tab.hasAttribute("muted"),
      soundPlaying: tab.hasAttribute("soundplaying"),
      hidden: !!tab.hidden,
      spaceId: tab.getAttribute("zen-workspace-id") || null,
      containerId: Number(tab.getAttribute("usercontextid") || 0),
      groupId: tab.group?.id || null,
      splitView: !!tab.splitView,
      index: Number.isInteger(tab.index) ? tab.index : null,
    };
  }

  windowState(win) {
    return {
      windowId: this.service.windowId(win),
      selectedTabId: win.gBrowser.selectedTab
        ? this.service.tabId(win.gBrowser.selectedTab)
        : null,
      activeSpaceId: win.gZenWorkspaces?.activeWorkspace || null,
      tabCount: this.service.listTabs(win).length,
      bounds: {
        x: win.screenX,
        y: win.screenY,
        width: win.outerWidth,
        height: win.outerHeight,
      },
      state: win.windowState,
      synced: !!win.gZenWorkspaces?.currentWindowIsSyncing,
    };
  }

  changed(win, tab, extras = {}) {
    this.service.notify("browser", {
      ...(win ? { windowId: this.service.windowId(win) } : {}),
      ...(tab ? { tabId: this.service.tabId(tab) } : {}),
      ...extras,
    });
  }

  async waitFor(predicate, signal, message, timeout = 10000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
      requireValue(
        !signal?.aborted,
        "cancelled",
        "The request was cancelled; inspect state before issuing another action"
      );
      requireValue(Date.now() < end, "state_timeout", message);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  windowsList(args) {
    const slice = paginate(this.service.getWindows(), args);
    return { ...slice, items: slice.items.map(win => this.windowState(win)) };
  }

  async windowAction(args, signal) {
    const win = this.window(args.windowId);
    if (args.action === "create") {
      const created = win.OpenBrowserWindow({
        private: false,
        zenSyncedWindow: args.synced ?? true,
      });
      await this.waitFor(
        () => created.closed || this.service.getWindows().includes(created),
        signal,
        "Window opened but its Zen startup did not finish; inspect windows_list",
        30000
      );
      requireValue(
        !created.closed && this.service.getWindows().includes(created),
        "window_unavailable",
        "The new window closed or is not a regular browser window"
      );
      this.changed(created);
      return { window: this.windowState(created) };
    }
    if (args.action === "reopen") {
      const closedId = integer(args.closedId, "closedId");
      requireValue(
        this.closedWindows().some(value => value.closedId === closedId),
        "unknown_closed_window",
        "Closed window is no longer restorable"
      );
      const restored = lazy.SessionStore.undoCloseById(closedId, false, win);
      requireValue(
        restored,
        "restore_failed",
        "SessionStore did not restore the window"
      );
      await this.waitFor(
        () => restored.closed || this.service.getWindows().includes(restored),
        signal,
        "Restored window has not finished Zen startup; inspect windows_list",
        30000
      );
      requireValue(
        !restored.closed && this.service.getWindows().includes(restored),
        "window_unavailable",
        "Restored window is not available"
      );
      this.changed(restored);
      return { window: this.windowState(restored) };
    }
    switch (args.action) {
      case "focus":
        win.focus();
        break;
      case "close":
        win.BrowserCommands.tryToCloseWindow();
        this.changed(win);
        return {
          windowId: args.windowId,
          closed: !!win.closed,
          windows: this.windowsList({}).items,
        };
      case "resize": {
        requireValue(
          args.x !== undefined ||
            args.y !== undefined ||
            args.width !== undefined ||
            args.height !== undefined,
          "invalid_argument",
          "Specify a position or size"
        );
        if (args.width !== undefined || args.height !== undefined) {
          const width = integer(
            args.width ?? win.outerWidth,
            "width",
            100,
            32768
          );
          const height = integer(
            args.height ?? win.outerHeight,
            "height",
            100,
            32768
          );
          win.resizeTo(width, height);
        }
        if (args.x !== undefined || args.y !== undefined) {
          const x = integer(args.x ?? win.screenX, "x", -32768, 32768);
          const y = integer(args.y ?? win.screenY, "y", -32768, 32768);
          win.moveTo(x, y);
        }
        break;
      }
      case "minimize":
        win.minimize();
        break;
      case "maximize":
        win.maximize();
        break;
      case "restore":
        win.restore();
        break;
      default:
        throw new McpToolError("invalid_action", "Unknown window action");
    }
    this.changed(win);
    return { window: this.windowState(win) };
  }

  tabsList(args) {
    const win = this.window(args.windowId);
    const items = this.service
      .listTabs(win)
      .filter(
        tab =>
          (args.spaceId === undefined ||
            tab.getAttribute("zen-workspace-id") === args.spaceId) &&
          (args.containerId === undefined ||
            Number(tab.getAttribute("usercontextid") || 0) === args.containerId)
      );
    const slice = paginate(items, args);
    return {
      windowId: args.windowId,
      ...slice,
      items: slice.items.map(tab => this.tabState(tab)),
    };
  }

  validateSpace(win, id) {
    const manager = win.gZenWorkspaces;
    const space = manager?.getWorkspaceFromId(string(id, "spaceId"));
    requireValue(
      space,
      "unknown_space",
      "Space no longer exists in this window"
    );
    return space;
  }

  validateContainer(id) {
    integer(id, "containerId");
    if (id !== 0) {
      requireValue(
        lazy.ContextualIdentityService.getPublicIdentityFromId(id),
        "unknown_container",
        "Public container does not exist"
      );
    }
  }

  async selectTab(tab) {
    const win = tab.ownerGlobal ?? tab.documentGlobal;
    const spaceId = tab.getAttribute("zen-workspace-id");
    if (spaceId && spaceId !== win.gZenWorkspaces.activeWorkspace) {
      this.validateSpace(win, spaceId);
      await win.gZenWorkspaces.changeWorkspaceWithID(spaceId);
    }
    win.gBrowser.selectedTab = tab;
  }

  async tabAction(args, signal) {
    if (args.action === "create") {
      const win = this.window(args.windowId);
      const spaceId = args.spaceId ?? win.gZenWorkspaces.activeWorkspace;
      this.validateSpace(win, spaceId);
      const spaceContainer =
        win.gZenWorkspaces.getWorkspaceFromId(spaceId).containerTabId;
      const containerId =
        args.containerId ??
        (typeof spaceContainer === "number" ? spaceContainer : 0);
      this.validateContainer(containerId);
      const url = args.url ?? "about:blank";
      string(url, "url");
      Services.io.newURI(url);
      const tab = win.gBrowser.addTab(url, {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        userContextId: containerId,
        createLazyBrowser: args.lazy ?? false,
        skipAnimation: true,
        skipRoute: true,
        zenWorkspaceId: spaceId,
      });
      win.gZenWorkspaces.moveTabToWorkspace(tab, spaceId);
      if (args.select === true) {
        await this.selectTab(tab);
      }
      this.changed(win, tab);
      return { tab: this.tabState(tab) };
    }
    if (args.action === "reopen") {
      const win = this.window(args.windowId);
      const closedId = integer(args.closedId, "closedId");
      requireValue(
        this.closedTabs(win).some(value => value.closedId === closedId),
        "unknown_closed_tab",
        "Closed tab is no longer restorable in this window"
      );
      const tab = lazy.SessionStore.undoCloseById(closedId, false, win);
      requireValue(
        tab && this.service.listTabs(win).includes(tab),
        "restore_failed",
        "SessionStore did not restore the tab"
      );
      this.changed(win, tab);
      return { tab: this.tabState(tab) };
    }
    let tab = this.tab(
      args.tabId,
      args.windowId === undefined ? undefined : this.window(args.windowId)
    );
    let win = tab.ownerGlobal ?? tab.documentGlobal;
    switch (args.action) {
      case "select":
        await this.selectTab(tab);
        break;
      case "move": {
        requireValue(
          args.destinationWindowId !== undefined ||
            args.spaceId !== undefined ||
            args.index !== undefined,
          "invalid_argument",
          "Specify destinationWindowId, spaceId or index"
        );
        const destination =
          args.destinationWindowId === undefined
            ? win
            : this.window(args.destinationWindowId);
        if (args.spaceId !== undefined) {
          this.validateSpace(destination, args.spaceId);
        }
        if (args.spaceId !== undefined) {
          requireValue(
            !tab.hasAttribute("zen-essential"),
            "essential_has_no_space",
            "Essentials are shared across Spaces; change pin mode before moving into a Space"
          );
        }
        const position =
          args.index === undefined
            ? this.service.listTabs(destination).length
            : integer(
                args.index,
                "index",
                0,
                this.service.listTabs(destination).length
              );
        if (destination !== win) {
          const oldWin = win;
          const adopted = destination.gBrowser.adoptTab(tab, {
            tabIndex: position,
            selectTab: args.select ?? false,
            spaceId: args.spaceId ?? destination.gZenWorkspaces.activeWorkspace,
          });
          requireValue(
            adopted,
            "tab_move_failed",
            "Zen refused to adopt this tab; inspect source and destination"
          );
          tab = adopted;
          win = destination;
          this.changed(oldWin);
        }
        if (args.spaceId !== undefined) {
          win.gZenWorkspaces.moveTabToWorkspace(tab, args.spaceId);
        }
        if (args.index !== undefined) {
          win.gBrowser.moveTabTo(tab, { tabIndex: position });
        }
        if (args.select === true) {
          await this.selectTab(tab);
        }
        break;
      }
      case "pin": {
        this.setPinMode(win, tab, args.mode);
        break;
      }
      case "mute":
        if (tab.hasAttribute("muted") !== boolean(args.muted, "muted")) {
          tab.toggleMuteAudio();
        }
        break;
      case "discard":
        if (tab.linkedPanel) {
          requireValue(
            win.gBrowser.discardBrowser(tab, true),
            "tab_not_discardable",
            "Zen cannot discard this tab (selected or active media/sharing); inspect its state"
          );
        }
        break;
      case "close": {
        const id = this.service.tabId(tab);
        win.gBrowser.removeTab(tab, { animate: false });
        await this.waitFor(
          () => tab.closing || !this.service.listTabs(win).includes(tab),
          signal,
          "Close is waiting for a page unload check; inspect the tab's dialogs"
        );
        this.changed(win);
        return {
          tabId: id,
          closing: !!tab.closing,
          closed: !this.service.listTabs(win).includes(tab),
          ...(win.closed ? {} : { window: this.windowState(win) }),
        };
      }
      default:
        throw new McpToolError("invalid_action", "Unknown tab action");
    }
    this.changed(win, tab);
    return { tab: this.tabState(tab) };
  }

  setPinMode(win, tab, mode) {
    requireValue(
      ["normal", "pinned", "essential"].includes(mode),
      "invalid_argument",
      "mode must be normal, pinned or essential"
    );
    const pins = win.gZenPinnedTabManager;
    if (mode === "essential") {
      requireValue(
        pins.addToEssentials(tab),
        "essential_rejected",
        "Zen rejected this Essential for the current container; select its Space first"
      );
    } else {
      if (tab.hasAttribute("zen-essential")) {
        pins.removeEssentials(tab, mode === "normal");
      }
      if (mode === "pinned") {
        win.gBrowser.pinTab(tab);
      }
      if (mode === "normal") {
        win.gBrowser.unpinTab(tab);
      }
    }
  }

  closedTabs(win) {
    return lazy.SessionStore.getClosedTabData({
      sourceWindow: win,
      private: false,
      closedTabsFromAllWindows: false,
      closedTabsFromClosedWindows: false,
    });
  }

  closedTabsList(args) {
    const win = this.window(args.windowId);
    const slice = paginate(this.closedTabs(win), args);
    return {
      windowId: args.windowId,
      ...slice,
      items: slice.items.map(value => {
        const state = value.state;
        const entry =
          state?.entries?.[(state.index || state.entries.length) - 1];
        return {
          closedId: value.closedId,
          title: value.title || entry?.title || "",
          url: entry?.url || "",
          closedAt: value.closedAt || null,
          containerId: state?.userContextId ?? 0,
        };
      }),
    };
  }

  closedWindows() {
    return lazy.SessionStore.getClosedWindowData().filter(
      value => !value.isPrivate
    );
  }

  closedWindowsList(args) {
    const slice = paginate(this.closedWindows(), args);
    return {
      ...slice,
      items: slice.items.map(value => ({
        closedId: value.closedId,
        title: value.title || "",
        tabCount: value.tabs?.length || 0,
        closedAt: value.closedAt || null,
      })),
    };
  }

  spaceState(win, space) {
    return {
      spaceId: space.uuid,
      windowId: this.service.windowId(win),
      name: space.name,
      icon: space.icon ?? null,
      containerId:
        typeof space.containerTabId === "number" ? space.containerTabId : 0,
      selected: win.gZenWorkspaces.activeWorkspace === space.uuid,
    };
  }

  spacesList(args) {
    const win = this.window(args.windowId);
    const slice = paginate(win.gZenWorkspaces.getWorkspaces(), args);
    return {
      windowId: args.windowId,
      activeSpaceId: win.gZenWorkspaces.activeWorkspace,
      ...slice,
      items: slice.items.map(space => this.spaceState(win, space)),
    };
  }

  async spaceAction(args, signal) {
    const win = this.window(args.windowId);
    const manager = win.gZenWorkspaces;
    requireValue(
      manager.workspaceEnabled && manager.currentWindowIsSyncing,
      "spaces_unavailable",
      "This window does not support synchronized Spaces"
    );
    let space;
    if (args.action === "create") {
      const name = string(args.name, "name");
      const containerId = args.containerId ?? 0;
      this.validateContainer(containerId);
      space = await manager.createAndSaveWorkspace(
        name,
        args.icon,
        true,
        containerId
      );
      requireValue(
        space,
        "space_creation_failed",
        "Zen did not create the Space"
      );
      await this.waitFor(
        () =>
          manager.getWorkspaceFromId(space.uuid) &&
          manager.workspaceElement(space.uuid),
        signal,
        "Space metadata was created but its UI has not appeared; inspect spaces_list"
      );
      if (args.select === true) {
        await manager.changeWorkspaceWithID(space.uuid);
      }
    } else {
      space = this.validateSpace(win, args.spaceId);
      switch (args.action) {
        case "update": {
          requireValue(
            args.name !== undefined ||
              args.icon !== undefined ||
              args.containerId !== undefined,
            "invalid_argument",
            "Specify a Space field to update"
          );
          const changed = { ...space };
          if (args.name !== undefined) {
            changed.name = string(args.name, "name");
          }
          if (args.icon !== undefined) {
            changed.icon = string(args.icon, "icon", true);
          }
          if (args.containerId !== undefined) {
            this.validateContainer(args.containerId);
            changed.containerTabId = args.containerId;
          }
          manager.saveWorkspace(changed);
          await this.waitFor(
            () => {
              const current = manager.getWorkspaceFromId(space.uuid);
              return (
                current &&
                current.name === changed.name &&
                current.icon === changed.icon &&
                current.containerTabId === changed.containerTabId
              );
            },
            signal,
            "Space update has not propagated; inspect spaces_list"
          );
          break;
        }
        case "switch":
          await manager.changeWorkspaceWithID(space.uuid);
          break;
        case "remove":
          requireValue(
            manager.getWorkspaces().length > 1,
            "last_space",
            "The last Space cannot be removed"
          );
          await manager.removeWorkspace(space.uuid);
          this.changed(win, null, { spaceId: space.uuid });
          return {
            spaceId: space.uuid,
            removed: !manager.getWorkspaceFromId(space.uuid),
            spaces: this.spacesList({ windowId: args.windowId }).items,
          };
        case "reorder":
          await manager.reorderWorkspace(
            space.uuid,
            integer(args.index, "index", 0, manager.getWorkspaces().length - 1)
          );
          break;
        default:
          throw new McpToolError("invalid_action", "Unknown Space action");
      }
    }
    this.changed(win, null, { spaceId: space.uuid });
    return {
      space: this.spaceState(win, manager.getWorkspaceFromId(space.uuid)),
      activeSpaceId: manager.activeWorkspace,
    };
  }

  containerState(value) {
    const api = lazy.ContextualIdentityService;
    return {
      containerId: value.userContextId,
      name: api.getUserContextLabel(value.userContextId),
      icon: value.icon,
      color: value.color,
      sites: api
        .getSiteAssociations(value.userContextId)
        .map(item => item.site),
    };
  }

  containersList(args) {
    const slice = paginate(
      lazy.ContextualIdentityService.getPublicIdentities(),
      args
    );
    return {
      ...slice,
      items: slice.items.map(value => this.containerState(value)),
    };
  }

  async containerAction(args, signal) {
    const api = lazy.ContextualIdentityService;
    if (args.action === "unassociate") {
      const site = string(args.site, "site");
      api.removeSiteAssociation(site);
      this.service.notify("profile", { kind: "containers" });
      return { site, containerId: api.getSiteAssociation(site) };
    }
    let value;
    if (args.action === "create") {
      value = api.create(
        string(args.name, "name"),
        args.icon ?? "fingerprint",
        args.color ?? "blue"
      );
    } else {
      const id = integer(args.containerId, "containerId", 1);
      value = api.getPublicIdentityFromId(id);
      requireValue(
        value,
        "unknown_container",
        "Public container no longer exists"
      );
      switch (args.action) {
        case "update":
          requireValue(
            args.name !== undefined ||
              args.icon !== undefined ||
              args.color !== undefined,
            "invalid_argument",
            "Specify a container field to update"
          );
          api.update(
            id,
            args.name === undefined
              ? api.getUserContextLabel(id)
              : string(args.name, "name"),
            args.icon ?? value.icon,
            args.color ?? value.color
          );
          break;
        case "remove":
          // Do not delete the identity/data while an unload prompt kept one of its public tabs alive.
          for (const win of this.service.getWindows()) {
            for (const tab of [...this.service.listTabs(win)]) {
              if (Number(tab.getAttribute("usercontextid") || 0) === id) {
                win.gBrowser.removeTab(tab, { animate: false });
                await this.waitFor(
                  () => win.closed || !this.service.listTabs(win).includes(tab),
                  signal,
                  "A container tab is still waiting for an unload check; inspect its dialogs before removing the container"
                );
                this.changed(win);
              }
            }
          }
          api.remove(id);
          this.service.notify("profile", { kind: "containers" });
          return { containerId: id, removed: !api.getPublicIdentityFromId(id) };
        case "reorder":
          api.move(
            [id],
            integer(
              args.index,
              "index",
              0,
              api.getPublicIdentities().length - 1
            )
          );
          break;
        case "associate":
          api.setSiteAssociation(string(args.site, "site"), id);
          break;
        default:
          throw new McpToolError("invalid_action", "Unknown container action");
      }
    }
    this.service.notify("profile", { kind: "containers" });
    return {
      container: this.containerState(
        api.getPublicIdentityFromId(value.userContextId)
      ),
    };
  }

  allGroups(win) {
    return [...new Set(win.gZenWorkspaces.allTabGroups)];
  }

  group(id, win, kind) {
    const value = this.allGroups(win).find(
      group => group.id === string(id, "groupId")
    );
    requireValue(
      value &&
        (kind === "folder"
          ? value.isZenFolder
          : !value.isZenFolder && !value.hasAttribute("split-view-group")),
      "unknown_group",
      `The ${kind} is closed or belongs to another window`
    );
    return value;
  }

  groupState(win, group) {
    let kind = "group";
    if (group.isZenFolder) {
      kind = "folder";
    } else if (group.hasAttribute("split-view-group")) {
      kind = "split";
    }
    return {
      windowId: this.service.windowId(win),
      groupId: group.id,
      kind,
      name: group.label,
      color: group.color,
      collapsed: !!group.collapsed,
      spaceId:
        group.getAttribute("zen-workspace-id") ||
        group.tabs[0]?.getAttribute("zen-workspace-id") ||
        null,
      parentGroupId: group.group?.id || null,
      icon: group.isZenFolder ? group.iconURL || null : null,
      tabIds: Array.from(group.tabs)
        .filter(tab => this.service.listTabs(win).includes(tab))
        .map(tab => this.service.tabId(tab)),
      childGroupIds: group.isZenFolder
        ? group.allItems
            .filter(
              value => value.isZenFolder || win.gBrowser.isTabGroup(value)
            )
            .map(value => value.id)
        : [],
    };
  }

  groupsList(args, kind) {
    const win = this.window(args.windowId);
    const items = this.allGroups(win).filter(
      value =>
        (kind === "folder"
          ? value.isZenFolder
          : !value.isZenFolder && !value.hasAttribute("split-view-group")) &&
        (args.spaceId === undefined ||
          (value.getAttribute("zen-workspace-id") ||
            value.tabs[0]?.getAttribute("zen-workspace-id")) === args.spaceId)
    );
    const slice = paginate(items, args);
    return {
      windowId: args.windowId,
      ...slice,
      items: slice.items.map(group => this.groupState(win, group)),
    };
  }

  dispatchGroupUpdate(win, group) {
    group.dispatchEvent(
      new win.CustomEvent("TabGroupUpdate", { bubbles: true })
    );
    win.gBrowser.tabContainer._invalidateCachedTabs();
    this.changed(win, null, { groupId: group.id });
  }

  validateFolderParent(folder, parent) {
    if (!parent) {
      return;
    }
    requireValue(
      folder !== parent && !folder.allItemsRecursive.includes(parent),
      "folder_cycle",
      "A folder cannot be moved inside itself or its descendants"
    );
    const relativeDepth = group =>
      1 +
      Math.max(
        0,
        ...group.allItems.filter(value => value.isZenFolder).map(relativeDepth)
      );
    const maxDepth = Services.prefs.getIntPref("zen.folders.max-subfolders", 5);
    requireValue(
      parent.level + relativeDepth(folder) < maxDepth,
      "folder_depth",
      "Zen's maximum nested folder depth would be exceeded"
    );
  }

  nestFolder(win, folder, parent) {
    this.validateFolderParent(folder, parent);
    requireValue(
      win.gZenFolders.canDropElement(
        folder,
        parent.groupContainer.lastElementChild
      ),
      "folder_depth",
      "Zen rejected this folder nesting depth"
    );
    parent.groupContainer.appendChild(folder);
    win.gBrowser.tabContainer._invalidateCachedTabs();
    this.dispatchGroupUpdate(win, folder);
  }

  async createFolder(win, args, signal) {
    const space = this.validateSpace(win, args.spaceId);
    const tabs = args.tabIds === undefined ? [] : this.tabs(args.tabIds, win);
    requireValue(
      tabs.every(
        tab =>
          !tab.hasAttribute("zen-essential") &&
          tab.getAttribute("zen-workspace-id") === space.uuid
      ),
      "folder_target_mismatch",
      "Folder tabs must belong to the requested Space and cannot be Essentials"
    );
    const parent = args.parentGroupId
      ? this.group(args.parentGroupId, win, "folder")
      : null;
    requireValue(
      !parent || parent.getAttribute("zen-workspace-id") === space.uuid,
      "folder_target_mismatch",
      "Parent folder must be in the requested Space"
    );
    if (parent) {
      requireValue(
        parent.level + 1 <
          Services.prefs.getIntPref("zen.folders.max-subfolders", 5),
        "folder_depth",
        "Zen's maximum nested folder depth would be exceeded"
      );
    }
    const folder = win.gZenFolders.createFolder(tabs, {
      label: string(args.name, "name"),
      workspaceId: space.uuid,
      collapsed: args.collapsed ?? false,
      renameFolder: false,
    });
    requireValue(
      folder,
      "folder_creation_failed",
      "Zen did not create the folder"
    );
    if (parent) {
      this.nestFolder(win, folder, parent);
    }
    if (args.icon !== undefined) {
      win.gZenFolders.setFolderUserIcon(folder, args.icon || null);
    }
    await this.waitFor(
      () => this.allGroups(win).includes(folder),
      signal,
      "Folder was created but not registered; inspect folders_list"
    );
    return folder;
  }

  async folderAction(args, signal) {
    const win = this.window(args.windowId);
    let folder;
    if (args.action === "create") {
      folder = await this.createFolder(win, args, signal);
    } else {
      folder = this.group(args.groupId, win, "folder");
      switch (args.action) {
        case "update":
          requireValue(
            args.name !== undefined ||
              args.icon !== undefined ||
              args.collapsed !== undefined,
            "invalid_argument",
            "Specify a folder field to update"
          );
          if (args.name !== undefined) {
            folder.label = string(args.name, "name", true);
          }
          if (args.collapsed !== undefined) {
            folder.collapsed = boolean(args.collapsed, "collapsed");
          }
          if (args.icon !== undefined) {
            win.gZenFolders.setFolderUserIcon(folder, args.icon || null);
          }
          break;
        case "addTabs": {
          const tabs = this.tabs(args.tabIds, win);
          const spaceId = folder.getAttribute("zen-workspace-id");
          requireValue(
            tabs.every(
              tab =>
                tab.getAttribute("zen-workspace-id") === spaceId &&
                !tab.hasAttribute("zen-essential")
            ),
            "folder_target_mismatch",
            "Tabs must belong to the folder's Space and cannot be Essentials"
          );
          for (const tab of tabs) {
            win.gBrowser.pinTab(tab);
          }
          folder.addTabs(tabs);
          break;
        }
        case "removeTabs": {
          const tabs = this.tabs(args.tabIds, win);
          requireValue(
            tabs.every(tab => folder.tabs.includes(tab)),
            "folder_target_mismatch",
            "Every tab must be in this folder"
          );
          for (const tab of tabs) {
            win.gBrowser.ungroupTab(tab);
          }
          break;
        }
        case "move": {
          requireValue(
            args.spaceId !== undefined ||
              args.parentGroupId !== undefined ||
              args.index !== undefined,
            "invalid_argument",
            "Specify spaceId, parentGroupId or index"
          );
          const spaceId =
            args.spaceId ?? folder.getAttribute("zen-workspace-id");
          this.validateSpace(win, spaceId);
          const parent = args.parentGroupId
            ? this.group(args.parentGroupId, win, "folder")
            : null;
          this.validateFolderParent(folder, parent);
          requireValue(
            !parent || parent.getAttribute("zen-workspace-id") === spaceId,
            "folder_target_mismatch",
            "Parent folder must be in the destination Space"
          );
          if (args.spaceId !== undefined) {
            win.gZenFolders.changeFolderToSpace(folder, spaceId, {
              hasDndSwitch: true,
            });
          }
          if (args.parentGroupId !== undefined) {
            if (parent) {
              this.nestFolder(win, folder, parent);
            } else {
              const root =
                win.gZenWorkspaces.workspaceElement(
                  spaceId
                ).pinnedTabsContainer;
              root.insertBefore(folder, root.lastChild);
            }
          } else if (args.spaceId !== undefined) {
            const root =
              win.gZenWorkspaces.workspaceElement(spaceId).pinnedTabsContainer;
            root.insertBefore(folder, root.lastChild);
          }
          if (args.index !== undefined) {
            win.gBrowser.moveTabTo(folder, {
              tabIndex: integer(
                args.index,
                "index",
                0,
                this.service.listTabs(win).length
              ),
            });
          }
          break;
        }
        case "unpack":
          await folder.unpackTabs();
          break;
        case "remove":
          await folder.delete();
          this.changed(win, null, { groupId: args.groupId });
          return {
            groupId: args.groupId,
            removed: !this.allGroups(win).includes(folder),
          };
        default:
          throw new McpToolError("invalid_action", "Unknown folder action");
      }
    }
    this.dispatchGroupUpdate(win, folder);
    return {
      folder: this.allGroups(win).includes(folder)
        ? this.groupState(win, folder)
        : null,
      removed: !this.allGroups(win).includes(folder),
    };
  }

  async groupAction(args) {
    const win = this.window(args.windowId);
    let group;
    if (args.action === "create") {
      const tabs = this.tabs(args.tabIds, win);
      const space = tabs[0].getAttribute("zen-workspace-id");
      requireValue(
        tabs.every(
          tab =>
            tab.getAttribute("zen-workspace-id") === space &&
            !tab.hasAttribute("zen-essential") &&
            !tab.splitView
        ),
        "group_target_mismatch",
        "Group tabs must share a Space and cannot be Essentials or Split View members"
      );
      group = win.gBrowser.addTabGroup(tabs, {
        label: args.name ?? "",
        color: args.color ?? "blue",
        insertBefore: tabs[0],
      });
      requireValue(
        group,
        "group_creation_failed",
        "Zen did not create the group"
      );
      group.setAttribute("zen-workspace-id", space);
      if (args.collapsed !== undefined) {
        group.collapsed = boolean(args.collapsed, "collapsed");
      }
    } else {
      group = this.group(args.groupId, win, "group");
      switch (args.action) {
        case "update":
          requireValue(
            args.name !== undefined ||
              args.color !== undefined ||
              args.collapsed !== undefined,
            "invalid_argument",
            "Specify a group field to update"
          );
          if (args.name !== undefined) {
            group.label = string(args.name, "name", true);
          }
          if (args.color !== undefined) {
            group.color = string(args.color, "color");
          }
          if (args.collapsed !== undefined) {
            group.collapsed = boolean(args.collapsed, "collapsed");
          }
          break;
        case "addTabs": {
          const tabs = this.tabs(args.tabIds, win);
          const spaceId =
            group.getAttribute("zen-workspace-id") ||
            group.tabs[0]?.getAttribute("zen-workspace-id");
          requireValue(
            tabs.every(
              tab =>
                tab.getAttribute("zen-workspace-id") === spaceId &&
                !tab.hasAttribute("zen-essential") &&
                !tab.splitView
            ),
            "group_target_mismatch",
            "Tabs must share this group's Space and cannot be Essentials or Split View members"
          );
          group.addTabs(tabs);
          break;
        }
        case "removeTabs": {
          const tabs = this.tabs(args.tabIds, win);
          requireValue(
            tabs.every(tab => group.tabs.includes(tab)),
            "group_target_mismatch",
            "Every tab must belong to this group"
          );
          for (const tab of tabs) {
            win.gBrowser.ungroupTab(tab);
          }
          break;
        }
        case "move":
          win.gBrowser.moveTabTo(group, {
            tabIndex: integer(
              args.index,
              "index",
              0,
              this.service.listTabs(win).length
            ),
          });
          break;
        case "ungroup":
          group.ungroupTabs();
          break;
        case "remove":
          await win.gBrowser.removeTabGroup(group, { isUserTriggered: true });
          break;
        default:
          throw new McpToolError("invalid_action", "Unknown group action");
      }
    }
    this.dispatchGroupUpdate(win, group);
    return {
      group: this.allGroups(win).includes(group)
        ? this.groupState(win, group)
        : null,
      removed: !this.allGroups(win).includes(group),
    };
  }

  splitState(win, value) {
    const node = item =>
      item.tab
        ? {
            tabId: this.service.tabId(item.tab),
            sizeInParent: item.sizeInParent,
          }
        : {
            direction: item.direction,
            sizeInParent: item.sizeInParent,
            children: item.children.map(node),
          };
    return {
      windowId: this.service.windowId(win),
      groupId: value.groupId,
      layout: value.gridType,
      selected:
        win.gZenViewSplitter._data[win.gZenViewSplitter.currentView] === value,
      tabIds: value.tabs.map(tab => this.service.tabId(tab)),
      layoutTree: node(value.layoutTree),
    };
  }

  splitsList(args) {
    const win = this.window(args.windowId);
    const slice = paginate(win.gZenViewSplitter._data, args);
    return {
      windowId: args.windowId,
      ...slice,
      items: slice.items.map(value => this.splitState(win, value)),
    };
  }

  splitAction(args) {
    const win = this.window(args.windowId);
    const manager = win.gZenViewSplitter;
    const layout = args.layout ?? "grid";
    requireValue(
      ["grid", "vsep", "hsep"].includes(layout),
      "invalid_argument",
      "Unknown Split View layout"
    );
    let value;
    if (args.action === "create") {
      const tabs = this.tabs(args.tabIds, win);
      const space = tabs[0].getAttribute("zen-workspace-id");
      requireValue(
        tabs.length >= 2 && tabs.length <= manager.MAX_TABS,
        "split_tab_count",
        "Split View requires 2..4 tabs"
      );
      requireValue(
        tabs.every(
          tab =>
            tab.getAttribute("zen-workspace-id") === space &&
            !tab.hasAttribute("zen-essential") &&
            !tab.hasAttribute("zen-empty-tab") &&
            !tab.hidden &&
            !tab.splitView
        ),
        "split_target_mismatch",
        "Split tabs must be visible regular tabs in the same Space and not already split"
      );
      const initialIndex =
        args.selectedTabId === undefined
          ? 0
          : tabs.indexOf(this.tab(args.selectedTabId, win));
      requireValue(
        initialIndex >= 0,
        "split_target_mismatch",
        "selectedTabId must belong to this Split View"
      );
      value = manager.splitTabs(
        tabs,
        layout,
        args.select === false ? -1 : initialIndex,
        { activate: args.select !== false }
      );
      requireValue(
        value,
        "split_creation_failed",
        "Zen refused to split these tabs"
      );
    } else {
      const groupId = string(args.groupId, "groupId");
      const groupIndex = manager._data.findIndex(
        item => item.groupId === groupId
      );
      requireValue(
        groupIndex >= 0,
        "unknown_split",
        "Split View no longer exists in this window"
      );
      value = manager._data[groupIndex];
      switch (args.action) {
        case "update":
          requireValue(
            args.layout !== undefined,
            "invalid_argument",
            "Specify layout to update"
          );
          value.gridType = layout;
          value.layoutTree = manager.calculateLayoutTree(value.tabs, layout);
          if (manager.currentView === groupIndex) {
            manager.activateSplitView(value, true);
          }
          break;
        case "select": {
          const tab =
            args.selectedTabId === undefined
              ? value.tabs[0]
              : this.tab(args.selectedTabId, win);
          requireValue(
            value.tabs.includes(tab),
            "split_target_mismatch",
            "selectedTabId must belong to this Split View"
          );
          win.gBrowser.selectedTab = tab;
          manager.activateSplitView(value);
          break;
        }
        case "remove":
          manager.removeGroup(groupIndex);
          this.changed(win, null, { groupId });
          return {
            groupId,
            removed: !manager._data.some(item => item.groupId === groupId),
          };
        case "removeTab": {
          const tab = this.tab(args.tabId, win);
          requireValue(
            value.tabs.includes(tab),
            "split_target_mismatch",
            "tabId must belong to this Split View"
          );
          manager.removeTabFromGroup(tab, groupIndex, { forUnsplit: true });
          this.changed(win, tab, { groupId });
          const updated = manager._data.find(item => item.groupId === groupId);
          return {
            split: updated ? this.splitState(win, updated) : null,
            removed: !updated,
            tab: this.tabState(tab),
          };
        }
        default:
          throw new McpToolError("invalid_action", "Unknown Split View action");
      }
    }
    this.changed(win, null, { groupId: value.groupId });
    return { split: this.splitState(win, value) };
  }

  mediaState(tab) {
    const state = this.tabState(tab);
    if (!tab.linkedPanel) {
      return { ...state, media: null };
    }
    const controller = tab.linkedBrowser.browsingContext?.mediaController;
    let media = null;
    if (controller?.isActive) {
      let position = null;
      try {
        position = controller.getPositionState();
      } catch (error) {
        if (error.result !== Cr.NS_ERROR_NOT_AVAILABLE) {
          throw error;
        }
      }
      media = {
        controllerId: String(controller.id),
        playing: controller.isPlaying,
        audible: controller.isAudible,
        muted: controller.isMuted,
        playbackState: controller.playbackState,
        supportedKeys: Array.from(controller.supportedKeys),
        metadata: controller.getMetadata(),
        position,
      };
    }
    return {
      ...state,
      pictureInPicture: tab.hasAttribute("pictureinpicture"),
      media,
    };
  }

  mediaList(args) {
    const win = this.window(args.windowId);
    const tabs = this.service
      .listTabs(win)
      .filter(
        tab =>
          tab.linkedPanel &&
          (tab.hasAttribute("soundplaying") ||
            tab.hasAttribute("pictureinpicture") ||
            tab.linkedBrowser.browsingContext?.mediaController?.isActive)
      );
    const slice = paginate(tabs, args);
    return {
      windowId: args.windowId,
      ...slice,
      items: slice.items.map(tab => this.mediaState(tab)),
    };
  }

  async mediaAction(args, signal) {
    const tab = this.tab(args.tabId);
    const win = tab.ownerGlobal ?? tab.documentGlobal;
    requireValue(
      tab.linkedPanel,
      "tab_unloaded",
      "Media control requires an explicitly loaded tab"
    );
    const browser = tab.linkedBrowser;
    if (args.action === "pipOpen") {
      const { totalPipCount } =
        lazy.PictureInPicture.getEligiblePipVideoCount(browser);
      requireValue(
        totalPipCount > 0,
        "no_pip_video",
        "Firefox has no eligible video in this tab"
      );
      if (!tab.hasAttribute("pictureinpicture")) {
        browser.browsingContext.currentWindowGlobal
          .getActor("PictureInPictureLauncher")
          .sendAsyncMessage("PictureInPicture:KeyToggle");
        await this.waitFor(
          () => tab.hasAttribute("pictureinpicture"),
          signal,
          "PiP launcher did not open a player; inspect media state before retrying"
        );
      }
    } else if (args.action === "pipClose") {
      const players = Array.from(
        Services.wm.getEnumerator("Toolkit:PictureInPicture")
      ).filter(
        player => lazy.PictureInPicture.weakWinToBrowser.get(player) === browser
      );
      for (const player of players) {
        await lazy.PictureInPicture.closePipWindow(player);
      }
    } else if (args.action === "mute" || args.action === "unmute") {
      const muted = args.action === "mute";
      if (tab.hasAttribute("muted") !== muted) {
        tab.toggleMuteAudio();
      }
    } else {
      const controller = browser.browsingContext?.mediaController;
      requireValue(
        controller?.isActive,
        "no_media_controller",
        "This tab has no active media controller"
      );
      const key = {
        play: "play",
        pause: "pause",
        stop: "stop",
        previous: "previoustrack",
        next: "nexttrack",
        seek: "seekto",
      }[args.action];
      requireValue(key, "invalid_action", "Unknown media action");
      requireValue(
        controller.supportedKeys.includes(key),
        "media_key_unsupported",
        "The page does not support this media action"
      );
      switch (args.action) {
        case "play":
          controller.play();
          break;
        case "pause":
          controller.pause("user");
          break;
        case "stop":
          controller.stop();
          break;
        case "previous":
          controller.prevTrack();
          break;
        case "next":
          controller.nextTrack();
          break;
        case "seek":
          requireValue(
            Number.isFinite(args.positionSeconds) && args.positionSeconds >= 0,
            "invalid_argument",
            "positionSeconds must be a non-negative number"
          );
          controller.seekTo(args.positionSeconds);
          break;
      }
    }
    this.changed(win, tab);
    return { tab: this.mediaState(tab) };
  }

  cleanup(clientId) {
    this.data.cleanup(clientId);
  }

  destroy() {
    this.data.destroy();
  }
}
