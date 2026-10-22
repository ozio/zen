// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  makeTool,
  paginate,
  requireValue,
  schema,
  uuid,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PictureInPicture:
    "moz-src:///toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
});
const SELECT = {
  windowId: schema.string,
  tabIds: schema.strings,
  selectionId: schema.string,
  filter: schema.object,
  filterLambda: schema.string,
};
const MEDIA_ACTIONS = [
  "play",
  "pause",
  "stop",
  "mute",
  "unmute",
  "volume",
  "rate",
  "seek",
  "pauseOthers",
  "duckOthers",
  "restore",
];
const CONTROL = {
  volume: { type: "number", minimum: 0, maximum: 1 },
  playbackRate: { type: "number", minimum: 0.0625, maximum: 16 },
  positionSeconds: schema.number,
  offsetSeconds: schema.number,
};
const POSITION = {
  monitorId: schema.string,
  topologyRevision: schema.string,
  corner: schema.enum(
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "center"
  ),
  x: schema.number,
  y: schema.number,
  width: { type: "number", minimum: 80 },
  height: { type: "number", minimum: 45 },
  margin: { type: "number", minimum: 0, maximum: 1000 },
};
const LIMIT = {
  cursor: schema.string,
  limit: { type: "integer", minimum: 1, maximum: 500 },
};
const EFFECT_TTL = 2 * 60 * 60 * 1000;

function failure(error) {
  return {
    code: error instanceof McpToolError ? error.code : "media_operation_failed",
    message:
      error instanceof McpToolError
        ? error.message
        : "Media operation failed; inspect the current state before retrying",
  };
}

function abortCheck(signal) {
  requireValue(!signal?.aborted, "cancelled", "The request was cancelled");
}

function deadline(promise, signal, onCancel = () => {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const cancel = code => {
      try {
        onCancel();
      } catch {}
      finish(
        reject,
        new McpToolError(
          code,
          "Media operation interrupted; inspect current state before retrying"
        )
      );
    };
    const abort = () => cancel("cancelled");
    timer = setTimeout(() => cancel("media_timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    Promise.resolve(promise).then(
      value => finish(resolve, value),
      error => finish(reject, error)
    );
  });
}

function loaded(tab) {
  // A lazy linkedBrowser getter can instantiate a discarded tab. Never read it
  // until the native tab declares that a panel already exists.
  return !!tab.linkedPanel && !tab.hasAttribute("pending") && !tab.closing;
}

function frames(tab) {
  if (!loaded(tab)) {
    return [];
  }
  const top = tab.linkedBrowser.browsingContext;
  const all = top ? [top] : [];
  for (let index = 0; index < all.length && index < 256; index++) {
    all.push(...all[index].children);
  }
  requireValue(
    all.length <= 256,
    "frame_limit",
    "The tab has more than 256 frames; narrow the target"
  );
  return all;
}

function rect(screen, method) {
  const values = [{}, {}, {}, {}];
  screen[method](...values);
  return {
    x: values[0].value,
    y: values[1].value,
    width: values[2].value,
    height: values[3].value,
  };
}

export function screenDescriptor(screen) {
  const scale = screen.defaultCSSScaleFactor / screen.contentsScaleFactor;
  requireValue(
    Number.isFinite(scale) && scale > 0,
    "invalid_screen",
    "Screen scale is not available"
  );
  return {
    bounds: rect(screen, "GetRectDisplayPix"),
    workArea: rect(screen, "GetAvailRectDisplayPix"),
    cssToDesktopScale: scale,
  };
}

export function desktopWindowRect(win) {
  const scale = win.devicePixelRatio / win.desktopToDeviceScale;
  requireValue(
    Number.isFinite(scale) && scale > 0,
    "invalid_screen",
    "Window scale is not available"
  );
  return {
    x: win.screenX * scale,
    y: win.screenY * scale,
    width: win.outerWidth * scale,
    height: win.outerHeight * scale,
  };
}

// All public coordinates are desktop pixels, including on mixed-DPI setups.
export function pipPlacement(current, monitor, ratio, args) {
  const area = monitor.workArea;
  requireValue(
    Number.isFinite(ratio) && ratio > 0 && area.width > 0 && area.height > 0,
    "invalid_geometry",
    "Video aspect ratio or monitor work area is unavailable"
  );
  for (const key of ["x", "y", "width", "height", "margin"]) {
    requireValue(
      args[key] === undefined || Number.isFinite(args[key]),
      "invalid_geometry",
      `${key} must be finite`
    );
  }
  requireValue(
    args.width === undefined || args.width >= 80,
    "invalid_geometry",
    "width must be at least 80 desktop pixels"
  );
  requireValue(
    args.height === undefined || args.height >= 45,
    "invalid_geometry",
    "height must be at least 45 desktop pixels"
  );
  requireValue(
    (args.x === undefined) === (args.y === undefined),
    "invalid_geometry",
    "Specify both x and y"
  );
  requireValue(
    !args.corner || args.x === undefined,
    "invalid_geometry",
    "Use corner or x/y, not both"
  );
  requireValue(
    !args.corner ||
      [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
        "center",
      ].includes(args.corner),
    "invalid_geometry",
    "Unknown corner"
  );
  const margin = args.margin ?? 16;
  requireValue(
    margin >= 0 &&
      margin <= 1000 &&
      margin * 2 < Math.min(area.width, area.height),
    "invalid_geometry",
    "margin does not fit the monitor work area"
  );
  let width =
    args.width ??
    (args.height === undefined ? current.width : args.height * ratio);
  let height = width / ratio;
  if (args.height !== undefined && height > args.height) {
    height = args.height;
    width = height * ratio;
  }
  const fit = Math.min(
    1,
    (area.width - margin * 2) / width,
    (area.height - margin * 2) / height
  );
  width *= fit;
  height *= fit;
  let x = args.x ?? current.x;
  let y = args.y ?? current.y;
  if (args.corner === "center") {
    x = area.x + (area.width - width) / 2;
    y = area.y + (area.height - height) / 2;
  } else if (args.corner) {
    x = args.corner.endsWith("right")
      ? area.x + area.width - margin - width
      : area.x + margin;
    y = args.corner.startsWith("bottom")
      ? area.y + area.height - margin - height
      : area.y + margin;
  }
  x = Math.max(
    area.x + margin,
    Math.min(area.x + area.width - margin - width, x)
  );
  y = Math.max(
    area.y + margin,
    Math.min(area.y + area.height - margin - height, y)
  );
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export class ZenMcpMediaTools {
  constructor(service) {
    this.service = service;
    this.clients = new Map();
    this.playerIds = new WeakMap();
    this.players = new Map();
    this.actors = new Map();
    this.operations = new Map();
    this.topologyKey = null;
    this.topologyRevision = null;
    this.closed = false;
  }

  getTools() {
    return [
      makeTool(
        "zen_media_items",
        "List individual audio/video elements across selected loaded tabs and frames. mediaId handles belong to this client and their original tab/frame/document. Unloaded tabs stay unloaded.",
        { ...SELECT, ...LIMIT },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_media_control",
        "Control exact mediaIds or media in a shared tab selection. pauseOthers/duckOthers exclude exceptMediaIds/exceptTabIds and return an operationId. restore only reverses still-unchanged effects owned by that operation. Batches return per-item observed outcomes and never retry effects.",
        {
          ...SELECT,
          mediaIds: schema.strings,
          action: schema.enum(...MEDIA_ACTIONS),
          ...CONTROL,
          exceptMediaIds: schema.strings,
          exceptTabIds: schema.strings,
          operationId: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_pip_windows",
        "List exact native Picture-in-Picture players with source media IDs, desktop-pixel geometry and native monitor work areas. Monitor IDs are stable only within this instance and unchanged display topology, not hardware identifiers.",
        { ...SELECT },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_pip",
        "Open one exact mediaId in PiP without activation by default; close/control/place one playerId. Placement uses monitorId and optional topologyRevision from zen_pip_windows. Coordinates and sizes are desktop pixels; width/height form an aspect-preserving bounding box clamped to the work area. Returns actual geometry, which the OS may constrain.",
        {
          action: schema.enum(
            "open",
            "close",
            "place",
            "play",
            "pause",
            "stop",
            "seek",
            "volume",
            "rate",
            "mute",
            "unmute"
          ),
          mediaId: schema.string,
          playerId: schema.string,
          activate: schema.boolean,
          ...POSITION,
          ...CONTROL,
        },
        ["action"]
      ),
    ];
  }

  async execute(name, args, client, signal) {
    this.service.assertInstance(args);
    requireValue(!this.closed, "server_stopped", "The MCP service stopped");
    requireValue(
      typeof client?.id === "string",
      "invalid_client",
      "An authenticated client is required"
    );
    abortCheck(signal);
    let result;
    switch (name) {
      case "zen_media_items": {
        const inventory = await this.inventory(args, client, signal);
        result = { ...inventory, ...paginate(inventory.items, args) };
        break;
      }
      case "zen_media_control":
        result = await this.control(args, client, signal);
        break;
      case "zen_pip_windows":
        result = await this.pipWindows(args, client, signal);
        break;
      case "zen_pip":
        result = await this.pip(args, client, signal);
        break;
      default:
        throw new McpToolError("unknown_tool", "Unknown media tool");
    }
    return { instanceId: this.service.instanceId, ...result };
  }

  clientMedia(client) {
    if (!this.clients.has(client.id)) {
      this.clients.set(client.id, new Map());
    }
    return this.clients.get(client.id);
  }

  media(mediaId, client) {
    const item = this.clientMedia(client).get(mediaId);
    requireValue(
      item,
      "unknown_media",
      "List media in this client before using a mediaId"
    );
    return item;
  }

  async targets(args, client, signal) {
    if (Object.keys(SELECT).some(key => args[key] !== undefined)) {
      requireValue(
        this.service.workspaceTools,
        "selector_unavailable",
        "The shared tab selector is unavailable"
      );
      return this.service.workspaceTools.resolveTargets(args, client, signal);
    }
    return this.service.getWindows().flatMap(win => this.service.listTabs(win));
  }

  async query(item, command, args, client, signal) {
    abortCheck(signal);
    const tab = this.service.getTab(item.tabId);
    requireValue(
      loaded(tab),
      "unloaded_tab",
      "The tab is unloaded; media operations do not load it"
    );
    const frame = frames(tab).find(
      candidate => String(candidate.id) === item.frameId
    );
    const wgp = frame?.currentWindowGlobal;
    requireValue(
      wgp && !wgp.isClosed && String(wgp.innerWindowId) === item.documentId,
      "stale_document",
      "The frame or document changed; list media again"
    );
    const actor = wgp.getActor("ZenMcpMedia");
    this.actors.set(item.documentId, new WeakRef(actor));
    if (this.actors.size > 1024) {
      for (const [id, reference] of this.actors) {
        if (!reference.deref()) {
          this.actors.delete(id);
        }
      }
    }
    const requestId = uuid();
    const response = await deadline(
      actor.sendQuery("ZenMcpMedia:Query", {
        clientId: client.id,
        requestId,
        command,
        args: { ...args, documentId: item.documentId },
      }),
      signal,
      () =>
        actor.sendAsyncMessage("ZenMcpMedia:Cancel", {
          clientId: client.id,
          requestId,
        })
    );
    requireValue(
      response?.ok,
      response?.error?.code || "media_operation_failed",
      response?.error?.message || "Media operation failed"
    );
    requireValue(
      frame.currentWindowGlobal === wgp &&
        response.value.documentId === item.documentId,
      "stale_document",
      "The document changed during the operation; inspect current state before retrying"
    );
    return response.value;
  }

  async inventory(args, client, signal) {
    const tabs = await this.targets(args, client, signal);
    const items = [];
    const unavailable = [];
    let truncated = false;
    const cache = this.clientMedia(client);
    for (const tab of tabs) {
      abortCheck(signal);
      const tabId = this.service.tabId(tab);
      if (!loaded(tab)) {
        unavailable.push({ tabId, code: "unloaded_tab" });
        continue;
      }
      let all;
      try {
        all = frames(tab);
      } catch (error) {
        unavailable.push({ tabId, ...failure(error) });
        continue;
      }
      for (const frame of all) {
        const wgp = frame.currentWindowGlobal;
        if (!wgp || wgp.isClosed) {
          continue;
        }
        const identity = {
          tabId,
          windowId: this.service.windowId(
            tab.ownerGlobal ?? tab.documentGlobal
          ),
          frameId: String(frame.id),
          documentId: String(wgp.innerWindowId),
        };
        try {
          const value = await this.query(identity, "list", {}, client, signal);
          truncated ||= value.truncated;
          for (const media of value.items) {
            if (items.length === 2048) {
              truncated = true;
              break;
            }
            const item = { ...media, ...identity };
            cache.set(item.mediaId, item);
            items.push(item);
          }
        } catch (error) {
          abortCheck(signal);
          unavailable.push({ ...identity, ...failure(error) });
        }
      }
    }
    while (cache.size > 4096) {
      cache.delete(cache.keys().next().value);
    }
    return {
      items,
      unavailable,
      truncated,
      selectedTabIds: tabs.map(tab => this.service.tabId(tab)),
    };
  }

  validateControl(args) {
    requireValue(
      MEDIA_ACTIONS.includes(args.action),
      "invalid_action",
      "Unknown media action"
    );
    if (["volume", "duckOthers"].includes(args.action)) {
      const volume =
        args.volume ?? (args.action === "duckOthers" ? 0.15 : undefined);
      requireValue(
        Number.isFinite(volume) && volume >= 0 && volume <= 1,
        "invalid_volume",
        "volume must be from 0 to 1"
      );
    }
    if (args.action === "rate") {
      requireValue(
        Number.isFinite(args.playbackRate) &&
          args.playbackRate >= 0.0625 &&
          args.playbackRate <= 16,
        "invalid_rate",
        "playbackRate must be from 0.0625 to 16"
      );
    }
    if (args.action === "seek") {
      requireValue(
        (args.positionSeconds !== undefined) !==
          (args.offsetSeconds !== undefined) &&
          Number.isFinite(args.positionSeconds ?? args.offsetSeconds),
        "invalid_seek",
        "Specify one finite positionSeconds or offsetSeconds"
      );
    }
    if (args.mediaIds !== undefined) {
      requireValue(
        Array.isArray(args.mediaIds) &&
          !!args.mediaIds.length &&
          args.mediaIds.length <= 256 &&
          args.mediaIds.every(id => typeof id === "string"),
        "invalid_media_ids",
        "mediaIds must contain 1 to 256 IDs"
      );
      requireValue(
        !Object.keys(SELECT).some(key => args[key] !== undefined),
        "ambiguous_selection",
        "Use mediaIds or a shared tab selection"
      );
    }
  }

  async control(args, client, signal) {
    this.validateControl(args);
    if (args.action === "restore") {
      return this.restore(args, client, signal);
    }
    requireValue(
      args.mediaIds || Object.keys(SELECT).some(key => args[key] !== undefined),
      "missing_selection",
      "Provide mediaIds or an explicit tab selection"
    );
    const inventory = args.mediaIds
      ? {
          items: [...new Set(args.mediaIds)].map(id => this.media(id, client)),
          unavailable: [],
          truncated: false,
        }
      : await this.inventory(args, client, signal);
    requireValue(
      !inventory.truncated && inventory.items.length <= 256,
      "media_limit",
      "Selection exceeds media limits; narrow it before applying an action"
    );
    const exceptMedia = new Set(args.exceptMediaIds || []);
    const exceptTabs = new Set(args.exceptTabIds || []);
    for (const id of exceptMedia) {
      this.media(id, client);
    }
    for (const id of exceptTabs) {
      this.service.getTab(id);
    }
    const focus = ["pauseOthers", "duckOthers"].includes(args.action);
    requireValue(
      focus || (!exceptMedia.size && !exceptTabs.size),
      "invalid_exclusion",
      "Exclusions apply to pauseOthers and duckOthers"
    );
    const items = inventory.items.filter(
      item => !exceptMedia.has(item.mediaId) && !exceptTabs.has(item.tabId)
    );
    const results = [];
    const effects = [];
    let operationId;
    if (focus) {
      this.pruneOperations();
      operationId = `media-operation-${uuid()}`;
      this.operations.set(operationId, {
        clientId: client.id,
        effects,
        expiresAt: Date.now() + EFFECT_TTL,
      });
    }
    for (const item of items) {
      abortCheck(signal);
      try {
        const result = await this.query(
          item,
          "control",
          {
            ...args,
            mediaId: item.mediaId,
            action:
              { pauseOthers: "pauseForFocus", duckOthers: "duckForFocus" }[
                args.action
              ] || args.action,
            volume:
              args.volume ?? (args.action === "duckOthers" ? 0.15 : undefined),
          },
          client,
          signal
        );
        results.push({ ...result, tabId: item.tabId });
        if (result.effectId) {
          effects.push({ item, effectId: result.effectId });
        }
      } catch (error) {
        results.push({
          mediaId: item.mediaId,
          tabId: item.tabId,
          status: "failed",
          error: failure(error),
        });
        abortCheck(signal);
      }
    }
    return {
      action: args.action,
      results,
      unavailable: inventory.unavailable,
      selected: inventory.items.length,
      excluded: inventory.items.length - items.length,
      ...(operationId
        ? { operationId, restorable: effects.length, expiresInMs: EFFECT_TTL }
        : {}),
    };
  }

  pruneOperations() {
    for (const [id, operation] of this.operations) {
      if (operation.expiresAt < Date.now()) {
        this.operations.delete(id);
      }
    }
    while (this.operations.size >= 64) {
      const candidate = [...this.operations].find(([, value]) => !value.busy);
      requireValue(
        candidate,
        "operation_limit",
        "Too many concurrent media operations"
      );
      this.operations.delete(candidate[0]);
    }
  }

  async restore(args, client, signal) {
    requireValue(
      !args.mediaIds &&
        !Object.keys(SELECT).some(key => args[key] !== undefined),
      "ambiguous_selection",
      "restore uses only its operationId"
    );
    const operation = this.operations.get(args.operationId);
    requireValue(
      operation?.clientId === client.id && operation.expiresAt >= Date.now(),
      "unknown_operation",
      "This client has no unexpired media operation with that ID"
    );
    requireValue(
      !operation.busy,
      "operation_busy",
      "This operation is already restoring"
    );
    operation.busy = true;
    const results = [];
    try {
      while (operation.effects.length) {
        abortCheck(signal);
        const { item, effectId } = operation.effects[0];
        try {
          const value = await this.query(
            item,
            "control",
            { mediaId: item.mediaId, action: "restore", effectId },
            client,
            signal
          );
          results.push({ ...value, tabId: item.tabId });
        } catch (error) {
          results.push({
            mediaId: item.mediaId,
            tabId: item.tabId,
            status: "failed",
            error: failure(error),
          });
        }
        // Never replay a restore whose response was lost. Remaining untouched
        // effects are still available if this request is cancelled.
        operation.effects.shift();
      }
      this.operations.delete(args.operationId);
    } finally {
      operation.busy = false;
    }
    return { action: "restore", operationId: args.operationId, results };
  }

  screens() {
    const manager = Cc["@mozilla.org/gfx/screenmanager;1"].getService(
      Ci.nsIScreenManager
    );
    requireValue(
      manager.screens?.length,
      "screen_enumeration_unavailable",
      "This build does not expose native monitor enumeration"
    );
    const primary = screenDescriptor(manager.primaryScreen);
    const raw = manager.screens.map(screenDescriptor);
    // Mirrored monitors share a single desktop surface. Identical logical
    // geometry is deliberately one selectable surface, never guessed hardware.
    const unique = [
      ...new Map(raw.map(value => [JSON.stringify(value), value])).values(),
    ];
    unique.sort(
      (a, b) =>
        a.bounds.x - b.bounds.x ||
        a.bounds.y - b.bounds.y ||
        a.bounds.width - b.bounds.width ||
        a.bounds.height - b.bounds.height ||
        JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
    const key = JSON.stringify({ monitors: unique, primary });
    if (this.topologyKey !== key) {
      this.topologyKey = key;
      this.topologyRevision = `screens-${uuid()}`;
    }
    return {
      topologyRevision: this.topologyRevision,
      coordinateSystem: "desktop-pixels",
      monitorIdentity: "instance-and-topology",
      monitors: unique.map((value, index) => ({
        monitorId: `${this.topologyRevision}:${index + 1}`,
        primary: JSON.stringify(value) === JSON.stringify(primary),
        ...value,
      })),
    };
  }

  nativePlayers() {
    const browsers = new Map();
    for (const win of this.service.getWindows()) {
      for (const tab of this.service.listTabs(win)) {
        if (loaded(tab)) {
          browsers.set(tab.linkedBrowser, tab);
        }
      }
    }
    const players = [];
    for (const win of Services.wm.getEnumerator("Toolkit:PictureInPicture")) {
      const tab = browsers.get(lazy.PictureInPicture.weakWinToBrowser.get(win));
      if (!win.closed && tab) {
        let playerId = this.playerIds.get(win);
        if (!playerId) {
          playerId = `pip-${uuid()}`;
          this.playerIds.set(win, playerId);
          this.players.set(playerId, {
            window: new WeakRef(win),
            clients: new Set(),
          });
        }
        players.push({
          win,
          tab,
          playerId,
          pipFrameId: String(
            win.document.getElementById("browser")?.browsingContext?.id ?? ""
          ),
        });
      }
    }
    for (const [id, player] of this.players) {
      if (!player.window.deref() || player.window.deref().closed) {
        this.players.delete(id);
      }
    }
    return players;
  }

  async pipWindows(args, client, signal) {
    const inventory = await this.inventory(args, client, signal);
    const selection = new Set(inventory.selectedTabIds);
    const topology = this.screens();
    const items = this.nativePlayers()
      .filter(player => selection.has(this.service.tabId(player.tab)))
      .map(player => {
        this.players.get(player.playerId).clients.add(client.id);
        const source = inventory.items.find(
          item =>
            item.tabId === this.service.tabId(player.tab) &&
            item.pipFrameId === player.pipFrameId
        );
        const geometry = desktopWindowRect(player.win);
        const monitor = this.monitorForRect(geometry, topology.monitors);
        return {
          playerId: player.playerId,
          tabId: this.service.tabId(player.tab),
          windowId: this.service.windowId(
            player.tab.ownerGlobal ?? player.tab.documentGlobal
          ),
          source: source || null,
          sourceResolved: !!source,
          geometry,
          monitorId: monitor?.monitorId || null,
          fullscreen: !!player.win.fullScreen,
        };
      });
    return {
      ...topology,
      items,
      unavailable: inventory.unavailable,
      truncated: inventory.truncated,
    };
  }

  monitorForRect(bounds, monitors) {
    let best = null;
    let area = 0;
    for (const monitor of monitors) {
      const other = monitor.bounds;
      const overlap =
        Math.max(
          0,
          Math.min(bounds.x + bounds.width, other.x + other.width) -
            Math.max(bounds.x, other.x)
        ) *
        Math.max(
          0,
          Math.min(bounds.y + bounds.height, other.y + other.height) -
            Math.max(bounds.y, other.y)
        );
      if (overlap > area) {
        area = overlap;
        best = monitor;
      }
    }
    return best || monitors.find(monitor => monitor.primary) || monitors[0];
  }

  async pip(args, client, signal) {
    if (args.action === "open") {
      requireValue(
        args.mediaId && !args.playerId,
        "invalid_target",
        "PiP open requires one mediaId"
      );
      const item = this.media(args.mediaId, client);
      if (Object.keys(POSITION).some(key => args[key] !== undefined)) {
        // Validate placement before opening anything. Actual placement below
        // is calculated from the real newly opened window, never this seed.
        const topology = this.screens();
        requireValue(
          !args.topologyRevision ||
            args.topologyRevision === topology.topologyRevision,
          "stale_monitor",
          "Display topology changed; list PiP windows again"
        );
        const monitor = args.monitorId
          ? topology.monitors.find(value => value.monitorId === args.monitorId)
          : topology.monitors.find(value => value.primary) ||
            topology.monitors[0];
        requireValue(
          monitor,
          "stale_monitor",
          "Monitor ID is not in the current display topology"
        );
        pipPlacement(
          { ...monitor.workArea },
          monitor,
          item.videoWidth / item.videoHeight,
          args
        );
      }
      const result = await this.query(
        item,
        "control",
        {
          action: "pipOpen",
          mediaId: item.mediaId,
          activate: args.activate === true,
        },
        client,
        signal
      );
      const list = await this.pipWindows(
        { tabIds: [item.tabId] },
        client,
        signal
      );
      const player = list.items.find(
        value => value.source?.mediaId === item.mediaId
      );
      requireValue(
        player,
        "pip_not_observed",
        "PiP open completed without an identifiable player; list players before retrying"
      );
      if (Object.keys(POSITION).some(key => args[key] !== undefined)) {
        return {
          ...(await this.pip(
            {
              ...args,
              action: "place",
              mediaId: undefined,
              playerId: player.playerId,
            },
            client,
            signal
          )),
          action: "open",
          openStatus: result.status,
        };
      }
      return {
        action: args.action,
        status: result.status,
        player,
        topologyRevision: list.topologyRevision,
      };
    }
    requireValue(
      args.playerId && !args.mediaId,
      "invalid_target",
      "Choose one playerId from zen_pip_windows"
    );
    const owned = this.players.get(args.playerId);
    const player = this.nativePlayers().find(
      value => value.playerId === args.playerId
    );
    requireValue(
      owned?.clients.has(client.id) && player,
      "stale_player",
      "The player is closed or was not listed by this client"
    );
    const inventory = await this.inventory(
      { tabIds: [this.service.tabId(player.tab)] },
      client,
      signal
    );
    const source = inventory.items.find(
      item => item.pipFrameId === player.pipFrameId
    );
    requireValue(
      source,
      "pip_source_unavailable",
      "This player's exact video could not be resolved; list media again"
    );
    if (args.action === "close") {
      await this.query(
        source,
        "control",
        {
          action: "pipClose",
          mediaId: source.mediaId,
          pipFrameId: player.pipFrameId,
        },
        client,
        signal
      );
      return {
        action: "close",
        playerId: args.playerId,
        closed: !!player.win.closed,
      };
    }
    if (args.action !== "place") {
      requireValue(
        MEDIA_ACTIONS.includes(args.action) &&
          !["restore", "pauseOthers", "duckOthers"].includes(args.action),
        "invalid_action",
        "Unknown PiP action"
      );
      this.validateControl(args);
      return {
        action: args.action,
        playerId: args.playerId,
        ...(await this.query(
          source,
          "control",
          { ...args, mediaId: source.mediaId },
          client,
          signal
        )),
      };
    }
    requireValue(
      !player.win.fullScreen,
      "pip_fullscreen",
      "Leave PiP fullscreen before changing its position"
    );
    const topology = this.screens();
    requireValue(
      !args.topologyRevision ||
        args.topologyRevision === topology.topologyRevision,
      "stale_monitor",
      "Display topology changed; list PiP windows again"
    );
    const current = desktopWindowRect(player.win);
    const monitor = args.monitorId
      ? topology.monitors.find(value => value.monitorId === args.monitorId)
      : this.monitorForRect(current, topology.monitors);
    requireValue(
      monitor,
      "stale_monitor",
      "Monitor ID is not in the current display topology"
    );
    const desired = pipPlacement(
      current,
      monitor,
      source.videoWidth / source.videoHeight,
      args
    );
    const assertTopology = () =>
      requireValue(
        this.screens().topologyRevision === topology.topologyRevision,
        "stale_monitor",
        "Display topology changed during placement; inspect the current player position"
      );
    abortCheck(signal);
    const scale = player.win.devicePixelRatio / player.win.desktopToDeviceScale;
    player.win.moveTo(desired.x / scale, desired.y / scale);
    // Native move and resize can update the window's per-monitor scale on the
    // next event-loop turn. Observe that scale before the second operation.
    await deadline(new Promise(resolve => setTimeout(resolve, 50)), signal);
    abortCheck(signal);
    assertTopology();
    player.win.resizeTo(
      desired.width / monitor.cssToDesktopScale,
      desired.height / monitor.cssToDesktopScale
    );
    await deadline(new Promise(resolve => setTimeout(resolve, 50)), signal);
    abortCheck(signal);
    assertTopology();
    const finalScale =
      player.win.devicePixelRatio / player.win.desktopToDeviceScale;
    player.win.moveTo(desired.x / finalScale, desired.y / finalScale);
    await deadline(new Promise(resolve => setTimeout(resolve, 50)), signal);
    const observed = desktopWindowRect(player.win);
    const observedMonitor = this.monitorForRect(observed, topology.monitors);
    return {
      action: "place",
      playerId: args.playerId,
      source,
      topologyRevision: topology.topologyRevision,
      monitorId: observedMonitor.monitorId,
      requested: desired,
      observed,
      constrained: Object.keys(desired).some(
        key => Math.abs(desired[key] - observed[key]) > 2
      ),
    };
  }

  cleanup(clientId) {
    this.clients.delete(clientId);
    for (const player of this.players.values()) {
      player.clients.delete(clientId);
    }
    for (const [id, operation] of this.operations) {
      if (operation.clientId === clientId) {
        this.operations.delete(id);
      }
    }
    for (const [id, reference] of this.actors) {
      const actor = reference.deref();
      if (!actor) {
        this.actors.delete(id);
        continue;
      }
      try {
        actor.sendAsyncMessage("ZenMcpMedia:Cleanup", { clientId });
      } catch {
        this.actors.delete(id);
      }
    }
  }

  destroy() {
    this.closed = true;
    for (const id of this.clients.keys()) {
      this.cleanup(id);
    }
    this.clients.clear();
    this.players.clear();
    this.operations.clear();
    this.actors.clear();
  }
}
