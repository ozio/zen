// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  SnapshotStore,
  makeTool,
  paginate,
  requireValue,
  schema,
  uuid,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import {
  ACTIONS,
  boundedValue,
  documentIdentity,
  performAction,
  snapshotDocument,
  takeElement,
  validateAction,
} from "resource:///actors/ZenMcpInteraction.sys.mjs";
import { ZenMcpDevTools } from "resource:///modules/zen/mcp/ZenMcpDevTools.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  capture: "chrome://remote/content/shared/Capture.sys.mjs",
  modal: "chrome://remote/content/shared/Prompt.sys.mjs",
});

const PAGE = { tabId: schema.string, frameId: schema.string };
const LIST = {
  cursor: schema.string,
  limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
};
const SNAPSHOT = {
  selector: schema.string,
  includeHidden: schema.boolean,
  ...LIST,
};
const ELEMENT = {
  snapshotId: schema.string,
  elementId: schema.string,
  documentId: schema.string,
  action: schema.enum(...ACTIONS),
  text: schema.string,
  replace: schema.boolean,
  key: schema.string,
  modifiers: {
    type: "array",
    items: schema.enum("shift", "ctrl", "alt", "meta"),
  },
  values: schema.strings,
  checked: schema.boolean,
  deltaX: schema.number,
  deltaY: schema.number,
  paths: schema.strings,
};
const ELEMENT_REQUIRED = ["snapshotId", "elementId", "documentId", "action"];

/**
 * Reject IDs outside the explicit tab, including stale/reparented contexts.
 *
 * @param {object} tab The explicitly selected native tab.
 * @param {string} [frameId] An observed browsing context identifier.
 */
export function findFrame(tab, frameId) {
  requireValue(
    tab.linkedPanel && !tab.hasAttribute("pending"),
    "tab_unloaded",
    "The tab is unloaded; navigate or select it explicitly before inspecting"
  );
  const top = tab.linkedBrowser?.browsingContext;
  requireValue(
    top && !top.isDiscarded,
    "tab_unloaded",
    "The tab has no live document; navigate or select it explicitly before inspecting"
  );
  if (frameId === undefined) {
    return top;
  }
  requireValue(
    typeof frameId === "string",
    "invalid_frame",
    "frameId must come from zen_page_frames"
  );
  const queue = [top];
  for (let index = 0; index < queue.length; index++) {
    const context = queue[index];
    if (!context.isDiscarded && String(context.id) === frameId) {
      requireValue(
        context.top === top,
        "wrong_frame_target",
        "Frame does not belong to the requested tab"
      );
      return context;
    }
    queue.push(...context.children);
  }
  throw new McpToolError(
    "wrong_frame_target",
    "Frame is missing or belongs to another tab"
  );
}

export function frameIdentity(frame) {
  const global = frame.currentWindowGlobal;
  return {
    frameId: String(frame.id),
    parentFrameId: frame.parent ? String(frame.parent.id) : null,
    documentId: global ? String(global.innerWindowId) : null,
    url: global?.documentURI?.spec || null,
    title: global?.documentTitle || "",
    loaded: !!global,
    discarded: frame.isDiscarded === true,
  };
}

export function withDeadline(promise, timeoutMs = 15000, signal, onCancel) {
  requireValue(
    Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000,
    "invalid_timeout",
    "timeoutMs must be from 0 to 60000"
  );
  if (signal?.aborted) {
    onCancel?.();
    return Promise.reject(
      new McpToolError("cancelled", "The request was cancelled")
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const cancel = (code, message) => {
      if (!settled) {
        onCancel?.();
        done(reject, new McpToolError(code, message));
      }
    };
    const abort = () =>
      cancel(
        "cancelled",
        "The request was cancelled; an action may already have completed"
      );
    const timer = setTimeout(
      () =>
        cancel(
          "operation_timeout",
          "The wait timed out; synchronous JavaScript or an action may still be running. Inspect current state before retrying"
        ),
      timeoutMs
    );
    signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      value => done(resolve, value),
      error => done(reject, error)
    );
  });
}

export function screenshotClip(args, viewport) {
  const clip = args.clip || {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  };
  requireValue(
    [clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) &&
      clip.x >= 0 &&
      clip.y >= 0 &&
      clip.width > 0 &&
      clip.height > 0,
    "invalid_clip",
    "clip must contain nonnegative x/y and positive finite width/height"
  );
  requireValue(
    clip.width <= 16384 &&
      clip.height <= 16384 &&
      clip.width * clip.height <= 32000000,
    "invalid_clip",
    "Screenshot dimensions exceed the size limit"
  );
  requireValue(
    clip.x + clip.width <= viewport.width &&
      clip.y + clip.height <= viewport.height,
    "invalid_clip",
    "clip must fit inside the visible viewport"
  );
  return clip;
}

export class ZenMcpPageTools {
  constructor(service, { devtools, snapshots } = {}) {
    this.service = service;
    this.devtools = devtools || new ZenMcpDevTools(service);
    this.snapshots = snapshots || new SnapshotStore();
    this.actors = new Map();
    this.closed = false;
  }

  getTools() {
    const tools = [
      makeTool(
        "zen_page_frames",
        "List the live frame tree of one explicit non-private tab without loading dormant tabs. Omitted frameId means its top document.",
        { tabId: schema.string, ...LIST },
        ["tabId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_page_snapshot",
        "Inspect semantic DOM elements, including open shadow roots. Handles expire in 30 seconds and allow one action per snapshot; inspect frames separately.",
        { ...PAGE, ...SNAPSHOT },
        ["tabId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_page_text",
        "Read visible page text, including open shadow roots, from an explicit document or CSS selector.",
        {
          ...PAGE,
          selector: schema.string,
          maxChars: { type: "integer", minimum: 1, maximum: 1000000 },
        },
        ["tabId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_page_action",
        "Perform a trusted pointer, key, form, scroll or upload action on a fresh element handle and return observed state. Never retries actions.",
        { ...PAGE, ...ELEMENT },
        ["tabId", ...ELEMENT_REQUIRED]
      ),
      makeTool(
        "zen_page_navigate",
        "Navigate, go back/forward, reload or stop one explicit tab; optionally wait for DOMContentLoaded or load. A timeout does not undo navigation.",
        {
          tabId: schema.string,
          action: schema.enum("navigate", "back", "forward", "reload", "stop"),
          url: schema.string,
          waitUntil: schema.enum("none", "domcontentloaded", "load"),
          timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
        },
        ["tabId", "action"]
      ),
      makeTool(
        "zen_page_wait",
        "Wait in an explicit frame for a CSS selector or document readiness. A successful element wait returns fresh snapshot handles.",
        {
          ...PAGE,
          selector: schema.string,
          state: schema.enum("present", "visible", "hidden", "absent", "ready"),
          readyState: schema.enum("interactive", "complete"),
          timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
          ...LIST,
        },
        ["tabId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_chrome_snapshot",
        "Inspect the native Zen interface and visible native menu items in one explicit normal window, including open shadow roots.",
        { windowId: schema.string, ...SNAPSHOT },
        ["windowId"],
        { readOnly: true }
      ),
      makeTool(
        "zen_chrome_action",
        "Operate a native Zen control or menu using fresh snapshot handles and return actual state.",
        { windowId: schema.string, ...ELEMENT },
        ["windowId", ...ELEMENT_REQUIRED]
      ),
      makeTool(
        "zen_screenshot",
        "Capture a page frame or Zen chrome viewport, optionally a clipped region. Returns a PNG/JPEG MCP image without full-page stitching.",
        {
          scope: schema.enum("page", "chrome"),
          ...PAGE,
          windowId: schema.string,
          clip: {
            type: "object",
            properties: {
              x: schema.number,
              y: schema.number,
              width: schema.number,
              height: schema.number,
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
          format: schema.enum("png", "jpeg"),
          quality: { type: "number", minimum: 0, maximum: 1 },
        },
        ["scope"],
        { readOnly: true }
      ),
      makeTool(
        "zen_dialog",
        "Inspect, accept or dismiss a page prompt in an explicit tab. Use the inspected dialogId for actions; prompt text can be entered before accept.",
        {
          tabId: schema.string,
          action: schema.enum("inspect", "accept", "dismiss"),
          dialogId: schema.string,
          text: schema.string,
        },
        ["tabId", "action"]
      ),
      makeTool(
        "zen_javascript",
        "Evaluate arbitrary JavaScript in an explicit page frame or browser system context. Browser scope has unrestricted system-principal access, including password/private data. Source may be an async IIFE. Timeout limits waiting and cannot stop synchronous code.",
        {
          scope: schema.enum("page", "browser"),
          ...PAGE,
          windowId: schema.string,
          source: schema.string,
          timeoutMs: { type: "integer", minimum: 0, maximum: 60000 },
        },
        ["scope", "source"]
      ),
      makeTool(
        "zen_console",
        "Start, read, clear or stop a client-owned console/error collector for one tab. Start before the activity to capture; 2000 recent records are retained.",
        {
          tabId: schema.string,
          action: schema.enum("start", "read", "clear", "stop"),
          level: schema.string,
          ...LIST,
        },
        ["tabId", "action"]
      ),
      makeTool(
        "zen_network",
        "Start, read, inspect or stop a client-owned network collector for one tab. Details include headers and optional captured bodies; start before requests. Keeps 2000 recent requests.",
        {
          tabId: schema.string,
          action: schema.enum("start", "read", "details", "clear", "stop"),
          requestId: schema.string,
          includeBodies: schema.boolean,
          maxChars: { type: "integer", minimum: 1, maximum: 1000000 },
          ...LIST,
        },
        ["tabId", "action"]
      ),
    ];
    const nullableString = { type: ["string", "null"] };
    const element = {
      type: "object",
      properties: {
        elementId: schema.string,
        tag: schema.string,
        role: schema.string,
        name: schema.string,
        text: schema.string,
        visible: schema.boolean,
        disabled: schema.boolean,
        rect: schema.object,
      },
      required: [
        "elementId",
        "tag",
        "role",
        "name",
        "visible",
        "disabled",
        "rect",
      ],
    };
    const properties = {
      instanceId: schema.string,
      windowId: schema.string,
      tabId: schema.string,
      frameId: schema.string,
      documentId: nullableString,
      observed: schema.object,
      url: nullableString,
      title: schema.string,
      readyState: schema.string,
      snapshotId: schema.string,
      expiresInMs: schema.integer,
      elements: { type: "array", items: element },
      text: schema.string,
      items: { type: "array", items: schema.object },
      total: schema.integer,
      nextCursor: schema.string,
      truncated: schema.boolean,
      scanTruncated: schema.boolean,
      action: schema.string,
      collecting: schema.boolean,
      retainedLimit: schema.integer,
      value: {},
      exception: {},
      dialog: { type: ["object", "null"] },
      request: schema.object,
      width: schema.integer,
      height: schema.integer,
      mimeType: schema.string,
      clip: schema.object,
    };
    for (const tool of tools) {
      const required = ["instanceId"];
      if (
        tool.name.startsWith("zen_page_") ||
        ["zen_console", "zen_network", "zen_dialog"].includes(tool.name)
      ) {
        required.push("tabId");
      } else if (tool.name.startsWith("zen_chrome_")) {
        required.push("windowId");
      }
      if (tool.name.endsWith("_snapshot")) {
        required.push("documentId", "snapshotId", "elements");
      }
      tool.outputSchema = { type: "object", properties, required };
    }
    return tools;
  }

  async execute(name, args, client, signal) {
    this.service.assertInstance(args);
    requireValue(!this.closed, "server_stopped", "The MCP service stopped");
    requireValue(
      typeof client?.id === "string",
      "invalid_client",
      "An authenticated client is required"
    );
    requireValue(!signal?.aborted, "cancelled", "The request was cancelled");
    let result;
    switch (name) {
      case "zen_page_frames": {
        const tab = this.service.getTab(args.tabId);
        const unloaded = !tab.linkedPanel || tab.hasAttribute("pending");
        const top = unloaded ? null : tab.linkedBrowser?.browsingContext;
        const frames = top ? [top] : [];
        for (let index = 0; index < frames.length; index++) {
          frames.push(...frames[index].children);
        }
        result = {
          tabId: args.tabId,
          unloaded,
          ...paginate(frames.map(frameIdentity), args),
        };
        break;
      }
      case "zen_page_snapshot":
      case "zen_page_text":
      case "zen_page_action":
      case "zen_page_wait":
        result = await this.query(
          args.tabId,
          args.frameId,
          name.slice("zen_page_".length),
          args,
          client,
          signal
        );
        break;
      case "zen_page_navigate":
        result = await this.#navigate(args, client, signal);
        break;
      case "zen_chrome_snapshot": {
        const win = this.service.getWindow(args.windowId);
        result = {
          windowId: args.windowId,
          ...snapshotDocument(
            win,
            this.snapshots,
            client.id,
            args.windowId,
            args,
            true
          ),
        };
        break;
      }
      case "zen_chrome_action": {
        validateAction(args);
        const win = this.service.getWindow(args.windowId);
        const element = takeElement(
          win,
          this.snapshots,
          client.id,
          args.windowId,
          args
        );
        result = {
          windowId: args.windowId,
          ...(await withDeadline(
            performAction(win, element, args, true),
            15000,
            signal
          )),
          browser: this.service.state(),
        };
        break;
      }
      case "zen_screenshot":
        return this.#screenshot(args, client, signal);
      case "zen_dialog":
        result = await this.#dialog(args, signal);
        break;
      case "zen_javascript":
        result = await this.#javascript(args, client, signal);
        break;
      case "zen_console":
        requireValue(
          ["start", "read", "clear", "stop"].includes(args.action),
          "invalid_action",
          "Unknown console action"
        );
        result = await withDeadline(
          this.devtools.console(args, client),
          15000,
          signal
        );
        break;
      case "zen_network":
        requireValue(
          ["start", "read", "details", "clear", "stop"].includes(args.action),
          "invalid_action",
          "Unknown network action"
        );
        result = await withDeadline(
          this.devtools.network(args, client),
          15000,
          signal
        );
        break;
      default:
        throw new McpToolError(
          "unknown_tool",
          "The page tool is not supported"
        );
    }
    return { instanceId: this.service.instanceId, ...result };
  }

  async query(tabId, frameId, command, args, client, signal) {
    requireValue(!this.closed, "server_stopped", "The MCP service stopped");
    requireValue(
      typeof client?.id === "string",
      "invalid_client",
      "An authenticated client is required"
    );
    requireValue(!signal?.aborted, "cancelled", "The request was cancelled");
    const tab = this.service.getTab(tabId);
    const frame = findFrame(tab, frameId);
    const global = frame.currentWindowGlobal;
    requireValue(
      global && !global.isClosed && global.isCurrentGlobal !== false,
      "document_unavailable",
      "The frame has no live document yet"
    );
    const actor = global.getActor("ZenMcp");
    let owned = this.actors.get(client.id);
    if (!owned) {
      this.actors.set(client.id, (owned = new Set()));
    }
    // Weak references avoid retaining old WindowGlobals across navigation.
    if (![...owned].some(reference => reference.deref() === actor)) {
      for (const reference of owned) {
        if (!reference.deref()) {
          owned.delete(reference);
        }
      }
      owned.add(new WeakRef(actor));
    }
    const requestId = uuid();
    const cancelled = () => {
      try {
        actor.sendAsyncMessage("ZenMcp:Cancel", {
          clientId: client.id,
          requestId,
        });
      } catch {}
    };
    let response;
    try {
      response = await withDeadline(
        actor.sendQuery("ZenMcp:Query", {
          clientId: client.id,
          requestId,
          command,
          args,
        }),
        command === "wait"
          ? Math.min(60000, (args.timeoutMs ?? 15000) + 1000)
          : 15000,
        signal,
        cancelled
      );
    } catch (error) {
      if (error instanceof McpToolError) {
        throw error;
      }
      throw new McpToolError(
        "target_changed",
        "The page target changed or closed during this command. An action may have completed; inspect current state before retrying"
      );
    }
    requireValue(
      response && typeof response.ok === "boolean",
      "invalid_actor_reply",
      "The page returned an invalid response"
    );
    if (!response.ok) {
      throw new McpToolError(
        response.error?.code || "page_operation_failed",
        response.error?.message || "The page operation failed"
      );
    }
    const current = findFrame(this.service.getTab(tabId), frameId);
    const documentChanged =
      current.currentWindowGlobal !== global ||
      String(current.currentWindowGlobal?.innerWindowId) !==
        String(response.value?.documentId);
    requireValue(
      command === "action" || !documentChanged,
      "stale_document",
      "The document changed during the command; inspect it again"
    );
    return {
      instanceId: this.service.instanceId,
      tabId,
      ...response.value,
      ...(documentChanged ? { documentChanged: true } : {}),
      observed: frameIdentity(current),
    };
  }

  async #navigate(args, client, signal) {
    requireValue(
      ["navigate", "back", "forward", "reload", "stop"].includes(args.action),
      "invalid_action",
      "Unknown navigation action"
    );
    const waitUntil = args.waitUntil ?? "load";
    requireValue(
      ["none", "domcontentloaded", "load"].includes(waitUntil),
      "invalid_wait",
      "waitUntil must be none, domcontentloaded or load"
    );
    const timeoutMs = args.timeoutMs ?? 15000;
    requireValue(
      Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000,
      "invalid_timeout",
      "timeoutMs must be from 0 to 60000"
    );
    const tab = this.service.getTab(args.tabId);
    const browser = tab.linkedBrowser;
    const previousDocumentId =
      browser.browsingContext?.currentWindowGlobal?.innerWindowId;
    const flags = Ci.nsIWebNavigation;
    let progressed = false;
    const progress = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onStateChange() {},
      onLocationChange(webProgress) {
        if (webProgress.isTopLevel) {
          progressed = true;
        }
      },
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    browser.addProgressListener(progress);
    try {
      if (args.action === "navigate") {
        requireValue(
          typeof args.url === "string" && !!args.url.length,
          "invalid_url",
          "url is required for navigation"
        );
        let uri;
        try {
          uri = Services.io.newURI(args.url);
        } catch {
          throw new McpToolError(
            "invalid_url",
            "url must be an absolute supported URL"
          );
        }
        requireValue(
          !["javascript", "vbscript"].includes(uri.scheme),
          "invalid_url",
          "Use zen_javascript for script execution"
        );
        browser.loadURI(uri, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
      } else if (args.action === "back") {
        requireValue(
          browser.canGoBack,
          "history_boundary",
          "This tab cannot go back"
        );
        browser.goBack();
      } else if (args.action === "forward") {
        requireValue(
          browser.canGoForward,
          "history_boundary",
          "This tab cannot go forward"
        );
        browser.goForward();
      } else if (args.action === "reload") {
        browser.reloadWithFlags(flags.LOAD_FLAGS_NONE);
      } else {
        browser.stop(flags.STOP_ALL);
      }
      if (waitUntil !== "none" && args.action !== "stop") {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          requireValue(
            !signal?.aborted,
            "cancelled",
            "Navigation may have completed; inspect the tab"
          );
          const currentTab = this.service.getTab(args.tabId);
          const frame = currentTab.linkedBrowser.browsingContext;
          const changed =
            frame?.currentWindowGlobal?.innerWindowId !== previousDocumentId;
          if ((changed || progressed) && frame?.currentWindowGlobal) {
            const identity = await this.query(
              args.tabId,
              undefined,
              "identity",
              {},
              client,
              signal
            );
            if (
              (waitUntil === "domcontentloaded" &&
                identity.readyState !== "loading") ||
              identity.readyState === "complete"
            ) {
              return {
                tabId: args.tabId,
                action: args.action,
                ...identity,
                loading: currentTab.linkedBrowser.webProgress.isLoadingDocument,
              };
            }
          }
          requireValue(
            Date.now() < deadline,
            "navigation_timeout",
            "Navigation did not reach the requested state; inspect the tab before retrying"
          );
          await withDeadline(
            new Promise(resolve => setTimeout(resolve, 50)),
            Math.max(0, Math.min(1000, deadline - Date.now())),
            signal
          );
        }
      }
      return {
        tabId: args.tabId,
        action: args.action,
        ...frameIdentity(browser.browsingContext),
        loading: browser.webProgress.isLoadingDocument,
      };
    } finally {
      browser.removeProgressListener(progress);
    }
  }

  async #screenshot(args, client, signal) {
    requireValue(
      ["page", "chrome"].includes(args.scope),
      "invalid_scope",
      "scope must be page or chrome"
    );
    requireValue(
      args.format === undefined || ["png", "jpeg"].includes(args.format),
      "invalid_format",
      "format must be png or jpeg"
    );
    requireValue(
      args.quality === undefined ||
        (Number.isFinite(args.quality) &&
          args.quality >= 0 &&
          args.quality <= 1),
      "invalid_quality",
      "quality must be from 0 to 1"
    );
    let win, frame, viewport, identity;
    if (args.scope === "chrome") {
      win = this.service.getWindow(args.windowId);
      frame = win.browsingContext;
      viewport = { width: win.innerWidth, height: win.innerHeight };
      identity = { windowId: args.windowId, documentId: documentIdentity(win) };
    } else {
      const tab = this.service.getTab(args.tabId);
      frame = findFrame(tab, args.frameId);
      win = tab.ownerGlobal ?? tab.documentGlobal;
      const page = await this.query(
        args.tabId,
        args.frameId,
        "identity",
        {},
        client,
        signal
      );
      viewport = page.viewport;
      identity = {
        tabId: args.tabId,
        frameId: page.frameId,
        documentId: page.documentId,
      };
    }
    const clip = screenshotClip(args, viewport);
    requireValue(
      String(frame.currentWindowGlobal?.innerWindowId) === identity.documentId,
      "stale_document",
      "The document changed before capture; inspect it again"
    );
    const canvas = await withDeadline(
      lazy.capture.canvas(win, frame, clip.x, clip.y, clip.width, clip.height, {
        drawView: true,
      }),
      15000,
      signal
    );
    requireValue(
      String(frame.currentWindowGlobal?.innerWindowId) === identity.documentId,
      "stale_document",
      "The document changed during capture; inspect it again"
    );
    const mimeType = args.format === "jpeg" ? "image/jpeg" : "image/png";
    const data = lazy.capture.toBase64(canvas, mimeType, args.quality ?? 0.9);
    const structuredContent = {
      instanceId: this.service.instanceId,
      scope: args.scope,
      ...identity,
      clip,
      width: canvas.width,
      height: canvas.height,
      mimeType,
    };
    return {
      __mcpResult: true,
      content: [
        { type: "image", mimeType, data },
        { type: "text", text: JSON.stringify(structuredContent) },
      ],
      structuredContent,
    };
  }

  #prompt(tab) {
    // findPrompt also looks for window-modal prompts. Passing no window keeps
    // a window-level dialog from being attributed to an arbitrary tab.
    return lazy.modal.findPrompt({
      window: null,
      contentBrowser: tab.linkedBrowser,
    });
  }

  async #dialog(args, signal) {
    requireValue(
      ["inspect", "accept", "dismiss"].includes(args.action),
      "invalid_action",
      "Unknown dialog action"
    );
    const tab = this.service.getTab(args.tabId);
    const prompt = this.#prompt(tab);
    if (args.action === "inspect") {
      return {
        tabId: args.tabId,
        dialog: prompt?.isOpen
          ? {
              dialogId: documentIdentity(prompt.window),
              type: prompt.promptType,
              text: await prompt.getText(),
              acceptsText: prompt.promptType === "prompt",
            }
          : null,
      };
    }
    requireValue(
      prompt?.isOpen,
      "missing_dialog",
      "This tab has no open page dialog"
    );
    requireValue(
      args.dialogId === documentIdentity(prompt.window),
      "stale_dialog",
      "The dialog changed; inspect it again"
    );
    requireValue(!signal?.aborted, "cancelled", "The request was cancelled");
    if (args.text !== undefined) {
      requireValue(
        prompt.promptType === "prompt" && typeof args.text === "string",
        "wrong_dialog",
        "Only a text prompt accepts text"
      );
      prompt.text = args.text;
    }
    if (args.action === "accept") {
      prompt.accept();
    } else {
      prompt.dismiss();
    }
    return {
      tabId: args.tabId,
      action: args.action,
      dialogId: args.dialogId,
      stillOpen: prompt.isOpen,
    };
  }

  async #javascript(args, client, signal) {
    requireValue(
      ["page", "browser"].includes(args.scope),
      "invalid_scope",
      "scope must be page or browser"
    );
    requireValue(
      typeof args.source === "string" && args.source.length <= 1000000,
      "invalid_source",
      "source must be a string of at most 1000000 characters"
    );
    const timeoutMs = args.timeoutMs ?? 15000;
    requireValue(
      Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000,
      "invalid_timeout",
      "timeoutMs must be from 0 to 60000"
    );
    if (args.scope === "browser") {
      const win = this.service.getWindow(args.windowId);
      // Browser chrome forbids window.eval through CSP. A system-principal
      // sandbox exposes the explicitly selected window without changing CSP
      // or enabling a remote debugging listener.
      const sandbox = Cu.Sandbox(
        Services.scriptSecurityManager.getSystemPrincipal(),
        {
          sandboxPrototype: win,
          wantXrays: false,
          // System modules share Gecko's privileged compartment. Keep this
          // sandbox separate so nukeSandbox receives a cross-compartment
          // wrapper and can release the evaluator on every exit path.
          freshCompartment: true,
          sandboxName: "Zen MCP browser JavaScript",
        }
      );
      const bindings = {
        window: win,
        Services,
        ChromeUtils,
        Components,
        Cc,
        Ci,
        Cu,
        Cr,
        IOUtils,
        PathUtils,
        setTimeout: win.setTimeout.bind(win),
        clearTimeout: win.clearTimeout.bind(win),
      };
      try {
        for (const [name, value] of Object.entries(bindings)) {
          if (
            Object.getOwnPropertyDescriptor(sandbox, name)?.configurable ===
            false
          ) {
            continue;
          }
          Object.defineProperty(sandbox, name, {
            value,
            configurable: true,
            writable: true,
          });
        }
        const value = await withDeadline(
          Promise.resolve(
            Cu.evalInSandbox(args.source, sandbox, "1.8", import.meta.url, 1)
          ),
          timeoutMs,
          signal
        );
        return {
          windowId: args.windowId,
          scope: "browser",
          ...boundedValue(value),
        };
      } catch (error) {
        if (error instanceof McpToolError) {
          throw error;
        }
        return {
          windowId: args.windowId,
          scope: "browser",
          exception: boundedValue(error?.message || String(error)).value,
        };
      } finally {
        Cu.nukeSandbox(sandbox);
      }
    }
    const tab = this.service.getTab(args.tabId);
    const frame = findFrame(tab, args.frameId);
    requireValue(
      frame.currentWindowGlobal,
      "document_unavailable",
      "This frame has no live document yet"
    );
    const documentId = String(frame.currentWindowGlobal.innerWindowId);
    const result = await withDeadline(
      this.devtools.evaluate(args.tabId, frame, args.source, client),
      timeoutMs,
      signal
    );
    return {
      tabId: args.tabId,
      frameId: String(frame.id),
      documentId,
      scope: "page",
      ...result,
      observed: frameIdentity(
        findFrame(this.service.getTab(args.tabId), args.frameId)
      ),
    };
  }

  cleanup(clientId) {
    this.snapshots.clearClient(clientId);
    for (const reference of this.actors.get(clientId) || []) {
      try {
        reference.deref()?.sendAsyncMessage("ZenMcp:Cleanup", { clientId });
      } catch {}
    }
    this.actors.delete(clientId);
    return this.devtools.cleanup(clientId);
  }

  destroy() {
    this.closed = true;
    for (const clientId of this.actors.keys()) {
      this.cleanup(clientId);
    }
    this.snapshots.clear();
    return this.devtools.destroy();
  }
}
