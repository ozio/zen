// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { ZenMcpCredentials } from "./ZenMcpCredentials.sys.mjs";
import {
  ZenMcpProtocol,
  McpProtocolError,
  MCP_MODERN_VERSION,
  checkEndpoint,
  errorMessage,
  getHeader,
  parseMessage,
} from "./ZenMcpProtocol.sys.mjs";
import { McpToolError, makeTool, schema, uuid } from "./ZenMcpUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  HttpServer: "chrome://remote/content/server/httpd.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ZenMcpBrowserTools: "resource:///modules/zen/mcp/ZenMcpBrowserTools.sys.mjs",
  ZenMcpPageTools: "resource:///modules/zen/mcp/ZenMcpPageTools.sys.mjs",
});
const MAX_BODY = 4 * 1024 * 1024;
const ENABLED = "zen.mcp.enabled";
const PORT = "zen.mcp.port";
const EVENT_LIMIT = 1000;
const RESOURCE_NAMES = ["state", "events", "capabilities"];
const AUDIT_METHODS = new Set([
  "http",
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "subscriptions/listen",
]);

function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.init(Ci.nsICryptoHash.SHA256);
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function token() {
  return Array.from(
    Cc["@mozilla.org/security/random-generator;1"]
      .getService(Ci.nsIRandomGenerator)
      .generateRandomBytes(32),
    byte => byte.toString(16).padStart(2, "0")
  ).join("");
}

function headersFrom(request) {
  const headers = {};
  for (const name of [
    "host",
    "origin",
    "authorization",
    "accept",
    "content-type",
    "content-length",
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name",
    "mcp-session-id",
  ]) {
    if (request.hasHeader(name)) {
      headers[name] = request.getHeader(name);
    }
  }
  return headers;
}

function writeUtf8(response, value) {
  const bytes = new TextEncoder().encode(value);
  const output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(
    Ci.nsIBinaryOutputStream
  );
  output.setOutputStream(response.bodyOutputStream);
  output.writeByteArray(bytes);
}

function decodeBody(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes)
    );
  } catch {
    throw new McpProtocolError(-32700, "Request body must be UTF-8", 400);
  }
}

class ZenMcpServiceImpl {
  constructor() {
    this.instanceId = uuid();
    this.kind = "main";
    this.error = null;
    this.server = null;
    this.protocol = null;
    this.initialized = null;
    this.reconfiguration = Promise.resolve();
    this.windows = new WeakMap();
    this.tabs = new WeakMap();
    this.events = [];
    this.sequence = 0;
    this.auditEntries = [];
    this.windowListeners = new Map();
    this.transports = new Set();
    this.resourcesNotificationQueued = false;
    this.changedTabs = new Set();
    this.clientActivity = new Map();
    this.rootTools = [
      makeTool(
        "zen_browser_state",
        "Read the explicit instance/build identity, windows and capability names. Does not load discarded tabs.",
        {},
        [],
        {
          readOnly: true,
          outputSchema: {
            properties: {
              kind: schema.enum("main", "playground"),
              processId: { type: ["integer", "null"] },
              build: {
                type: "object",
                properties: {
                  version: schema.string,
                  buildId: schema.string,
                  sourceURL: schema.string,
                  os: schema.string,
                  architecture: schema.string,
                },
              },
              windows: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    windowId: schema.string,
                    tabCount: schema.integer,
                    activeTabId: { type: ["string", "null"] },
                    activeSpaceId: schema.string,
                    activeDocumentId: { type: ["string", "null"] },
                    activeFrameId: { type: ["string", "null"] },
                  },
                },
              },
              capabilities: schema.strings,
            },
          },
        }
      ),
      makeTool(
        "zen_events",
        "Read a bounded change journal after a sequence number. Events contain opaque identifiers only.",
        { after: schema.integer, limit: schema.integer },
        [],
        { readOnly: true }
      ),
      makeTool(
        "zen_client_disconnect",
        "Release this client's subscriptions, element handles and DevTools observers. The saved access grant remains valid.",
        {},
        []
      ),
    ];
  }

  init() {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  async initialize() {
    this.kind = (await IOUtils.exists(
      PathUtils.join(PathUtils.profileDir, "zen-playground.json")
    ))
      ? "playground"
      : "main";
    const file = PathUtils.join(PathUtils.profileDir, "zen-mcp-clients.json");
    this.credentials = new ZenMcpCredentials({
      read: async () =>
        (await IOUtils.exists(file)) ? IOUtils.readJSON(file) : null,
      write: async data => {
        await IOUtils.writeJSON(file, data, {
          tmpPath: `${file}.tmp`,
          flush: true,
        });
        await IOUtils.setPermissions(file, 0o600, false);
      },
      hash: sha256,
      random: token,
      id: uuid,
      revoked: id => this.protocol?.disconnect(id),
    });
    try {
      await this.credentials.load();
    } catch {
      this.error =
        "MCP client registry could not be read. Restore the profile registry before starting MCP.";
    }
    Services.prefs.addObserver(ENABLED, this);
    Services.prefs.addObserver(PORT, this);
    Services.obs.addObserver(this, "quit-application-granted");
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    if (!this.error && Services.prefs.getBoolPref(ENABLED, false)) {
      await this.configure();
    }
    this.changed("server:state");
    return this.getStatus();
  }

  get defaultPort() {
    return this.kind === "playground" ? 3924 : 3923;
  }

  get port() {
    return Services.prefs.getIntPref(PORT, 0) || this.defaultPort;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get serverInfo() {
    return {
      name: "Zen",
      version: Services.appinfo.version,
      title: "Zen built-in MCP",
    };
  }

  get instructions() {
    return "Begin with zen_browser_state. Use its instanceId and explicit window/tab/document identifiers. Element snapshots expire after 30 seconds and one action. Mutations are serialized and never retried automatically. The granted client can execute unrestricted browser-principal JavaScript; synchronous JavaScript cannot be interrupted by an asynchronous timeout. Normal APIs omit private windows and saved passwords. Keep a subscription stream open while using continuous DevTools observers, and disconnect when finished.";
  }

  get tools() {
    return this.toolList ?? this.rootTools;
  }

  getStatus() {
    return {
      enabled: Services.prefs.getBoolPref(ENABLED, false),
      running: !!this.server,
      endpoint: this.endpoint,
      port: this.port,
      defaultPort: this.defaultPort,
      error: this.error,
      instanceId: this.instanceId,
      kind: this.kind,
      clients: this.credentials?.list() ?? [],
    };
  }

  changed(kind, clientId) {
    Services.obs.notifyObservers(
      null,
      "zen-mcp-state-changed",
      JSON.stringify({ kind, ...(clientId ? { clientId } : {}) })
    );
  }

  async setEnabled(enabled) {
    await this.init();
    if (typeof enabled !== "boolean") {
      throw new McpToolError("invalid_enabled", "enabled must be a boolean");
    }
    Services.prefs.setBoolPref(ENABLED, enabled);
    await this.configure();
    return this.getStatus();
  }

  async setPort(port) {
    await this.init();
    if (
      !Number.isInteger(port) ||
      (port !== 0 && (port < 1024 || port > 65535))
    ) {
      throw new McpToolError(
        "invalid_port",
        "Port must be 0 (default) or an integer from 1024 to 65535"
      );
    }
    Services.prefs.setIntPref(PORT, port);
    await this.configure();
    return this.getStatus();
  }

  grant(result) {
    const config = {
      mcpServers: {
        zen: {
          type: "streamable-http",
          url: this.endpoint,
          headers: { Authorization: `Bearer ${result.token}` },
        },
      },
    };
    return {
      ...result,
      endpoint: this.endpoint,
      config,
      configText: JSON.stringify(config, null, 2),
    };
  }

  async addClient(name) {
    await this.init();
    if (this.error?.includes("registry")) {
      throw new McpToolError("invalid_credentials", this.error);
    }
    const result = await this.credentials.add(name);
    this.changed("clients:create", result.client.id);
    return this.grant(result);
  }

  async rotateClient(id) {
    await this.init();
    const result = await this.credentials.rotate(id);
    this.changed("clients:rotate", id);
    return this.grant(result);
  }

  async revokeClient(id) {
    await this.init();
    await this.credentials.revoke(id);
    this.changed("clients:revoke", id);
    return this.getStatus();
  }

  hasClient(id) {
    return this.credentials.clients.has(id);
  }

  clientIds() {
    return [...this.credentials.clients.keys()];
  }

  observe(subject, topic) {
    if (topic === "nsPref:changed") {
      this.configure();
    } else if (topic === "quit-application-granted") {
      this.stop();
    } else if (topic === "browser-delayed-startup-finished" && this.server) {
      subject.gZenStartup?.promiseInitialized.then(() =>
        this.attachWindow(subject)
      );
    }
  }

  configure() {
    const operation = this.reconfiguration.then(async () => {
      const enabled = Services.prefs.getBoolPref(ENABLED, false);
      const port = this.port;
      if (this.server && enabled && this.listeningPort === port) {
        return;
      }
      await this.stop();
      if (!enabled) {
        this.changed("server:state");
        return;
      }
      if (this.error?.includes("registry")) {
        this.changed("server:state");
        return;
      }
      this.error = null;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        this.error = "MCP port must be an integer from 1024 to 65535.";
        this.changed("server:state");
        return;
      }
      this.instanceId = uuid();
      this.windows = new WeakMap();
      this.tabs = new WeakMap();
      this.events = [];
      this.sequence = 0;
      this.browserTools = new lazy.ZenMcpBrowserTools(this);
      this.pageTools = new lazy.ZenMcpPageTools(this);
      this.toolList = [
        ...this.rootTools,
        ...this.browserTools
          .getTools()
          .filter(tool => tool.name !== "zen_browser_state"),
        ...this.pageTools.getTools(),
      ];
      this.protocol = new ZenMcpProtocol(this, { id: uuid });
      const server = new lazy.HttpServer();
      server.registerPathHandler("/mcp", (request, response) =>
        this.handleHttp(request, response)
      );
      try {
        // Bind the numeric IPv4 loopback explicitly, without hostname resolution.
        server._start(port, "127.0.0.1");
        // httpd assigns localhost as its initial primary authority, even when
        // the socket is bound to a numeric address. Register our exact Host.
        server.identity.setPrimary("http", "127.0.0.1", port);
        server.identity.remove("http", "localhost", port);
        this.server = server;
        this.listeningPort = port;
        for (const win of this.getWindows()) {
          this.attachWindow(win);
        }
        this.timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        this.timer.initWithCallback(
          () => this.maintenance(),
          1000,
          Ci.nsITimer.TYPE_REPEATING_SLACK
        );
      } catch {
        this.error = `MCP could not listen on 127.0.0.1:${port}. The port may be occupied; choose another port.`;
        this.protocol.destroy();
        await this.browserTools.destroy();
        await this.pageTools.destroy();
        this.protocol = this.browserTools = this.pageTools = null;
        this.toolList = null;
      }
      this.changed("server:state");
    });
    this.reconfiguration = operation.catch(() => {
      this.error = "MCP server could not start.";
      this.changed("server:state");
    });
    return this.reconfiguration;
  }

  async stop() {
    this.timer?.cancel();
    this.timer = null;
    this.protocol?.destroy();
    for (const transport of [...this.transports]) {
      transport.controller.abort();
      try {
        transport.response.finish();
      } catch {}
    }
    this.transports.clear();
    for (const remove of this.windowListeners.values()) {
      remove();
    }
    this.windowListeners.clear();
    await this.browserTools?.destroy();
    await this.pageTools?.destroy();
    this.protocol = this.browserTools = this.pageTools = null;
    this.toolList = null;
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise(resolve => server.stop(resolve));
    }
  }

  getWindows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(
      win =>
        !win.closed &&
        win.gBrowser &&
        win.gZenStartup?.isReady &&
        !lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    );
  }

  listTabs(win) {
    return Array.from(win.gZenWorkspaces?.allStoredTabs ?? win.gBrowser.tabs);
  }

  windowId(win) {
    let id = this.windows.get(win);
    if (!id) {
      id = `window-${uuid()}`;
      this.windows.set(win, id);
    }
    return id;
  }

  tabId(tab) {
    let id = this.tabs.get(tab);
    if (!id) {
      id = `tab-${uuid()}`;
      this.tabs.set(tab, id);
    }
    return id;
  }

  getWindow(id) {
    const win = this.getWindows().find(item => this.windowId(item) === id);
    if (!win) {
      throw new McpToolError(
        "closed_window",
        "Window is closed or belongs to another instance"
      );
    }
    return win;
  }

  getTab(id) {
    for (const win of this.getWindows()) {
      const tab = this.listTabs(win).find(
        item => this.tabId(item) === id && !item.closing
      );
      if (tab) {
        return tab;
      }
    }
    throw new McpToolError(
      "closed_tab",
      "Tab is closed or belongs to another instance"
    );
  }

  assertInstance(args, toolName) {
    if (
      toolName !== "zen_browser_state" &&
      args.instanceId !== this.instanceId
    ) {
      throw new McpToolError(
        "stale_instance",
        "Read zen_browser_state again: this instance identity has changed"
      );
    }
  }

  state() {
    return {
      instanceId: this.instanceId,
      kind: this.kind,
      processId: Services.appinfo.processID ?? null,
      build: {
        version: Services.appinfo.version,
        buildId: Services.appinfo.appBuildID,
        sourceURL: Services.appinfo.sourceURL,
        platformVersion: Services.appinfo.platformVersion,
        os: Services.appinfo.OS,
        architecture: Services.appinfo.XPCOMABI,
      },
      windows: this.getWindows().map(win => {
        const selected = win.gBrowser.selectedTab;
        const context = selected?.linkedPanel
          ? selected.linkedBrowser.browsingContext
          : null;
        return {
          windowId: this.windowId(win),
          tabCount: this.listTabs(win).length,
          activeTabId: selected ? this.tabId(selected) : null,
          activeSpaceId: win.gZenWorkspaces.activeWorkspace,
          activeDocumentId: context?.currentWindowGlobal
            ? String(context.currentWindowGlobal.innerWindowId)
            : null,
          activeFrameId: context ? String(context.id) : null,
        };
      }),
      capabilities: this.tools.map(tool => tool.name),
    };
  }

  attachWindow(win) {
    if (this.windowListeners.has(win) || !this.getWindows().includes(win)) {
      return;
    }
    const types = [
      "TabOpen",
      "TabClose",
      "TabSelect",
      "TabMove",
      "TabPinned",
      "TabUnpinned",
      "TabAttrModified",
      "TabBrowserDiscarded",
      "TabGroupCreate",
      "TabGroupRemoved",
      "ZenWorkspaceChanged",
    ];
    const listener = event => {
      const tab = event.target?.localName === "tab" ? event.target : null;
      this.notify("browser", {
        windowId: this.windowId(win),
        ...(tab ? { tabId: this.tabId(tab) } : {}),
        event: event.type,
      });
    };
    types.forEach(type => win.addEventListener(type, listener, true));
    const progress = {
      onLocationChange: browser => {
        const tab = win.gBrowser.getTabForBrowser(browser);
        if (tab && !tab.closing) {
          const context = browser.browsingContext;
          this.notify("browser", {
            windowId: this.windowId(win),
            tabId: this.tabId(tab),
            frameId: context ? String(context.id) : undefined,
            documentId: context?.currentWindowGlobal
              ? String(context.currentWindowGlobal.innerWindowId)
              : undefined,
          });
        }
      },
    };
    win.gBrowser.addTabsProgressListener?.(progress);
    const unload = () => {
      this.windowListeners.get(win)?.();
      this.windowListeners.delete(win);
      this.notify("browser", {
        windowId: this.windowId(win),
        event: "window-closed",
      });
    };
    win.addEventListener("unload", unload, { once: true });
    this.windowListeners.set(win, () => {
      types.forEach(type => win.removeEventListener(type, listener, true));
      win.removeEventListener("unload", unload);
      win.gBrowser.removeTabsProgressListener?.(progress);
    });
    this.notify("browser", {
      windowId: this.windowId(win),
      event: "window-ready",
    });
  }

  notify(kind, payload = {}) {
    // Event data is deliberately restricted even if a provider passes more.
    const target = {};
    for (const key of [
      "windowId",
      "tabId",
      "documentId",
      "frameId",
      "spaceId",
      "clientId",
    ]) {
      if (typeof payload[key] === "string") {
        target[key] = payload[key];
      }
    }
    const event = {
      sequence: ++this.sequence,
      time: Date.now(),
      kind,
      ...target,
    };
    this.events.push(event);
    if (target.tabId) {
      this.changedTabs.add(target.tabId);
    }
    if (this.events.length > EVENT_LIMIT) {
      this.events.shift();
    }
    if (!this.resourcesNotificationQueued) {
      this.resourcesNotificationQueued = true;
      Services.tm.dispatchToMainThread(() => {
        this.resourcesNotificationQueued = false;
        this.protocol?.notify("notifications/resources/updated", {
          uri: this.resourceUri("events"),
        });
        this.protocol?.notify("notifications/resources/updated", {
          uri: this.resourceUri("state"),
        });
        this.protocol?.notify("notifications/resources/list_changed");
        for (const tabId of this.changedTabs) {
          this.protocol?.notify("notifications/resources/updated", {
            uri: this.resourceUri(`tabs/${tabId}`),
          });
        }
        this.changedTabs.clear();
      });
    }
  }

  resourceUri(name) {
    return `zen://${this.instanceId}/${name}`;
  }

  resources() {
    return RESOURCE_NAMES.map(name => ({
      uri: this.resourceUri(name),
      name: `zen_${name}`,
      mimeType: "application/json",
      description: {
        state: "Current browser instance, build, windows and active targets",
        events: "Bounded browser changes containing opaque identifiers",
        capabilities: "Available tools and input/output schemas",
      }[name],
    }));
  }

  get resourceTemplates() {
    return [
      {
        uriTemplate: `zen://${this.instanceId}/tabs/{tabId}`,
        name: "zen_tab",
        mimeType: "application/json",
        description:
          "Read an explicit normal tab without loading a discarded tab",
      },
    ];
  }

  assertResource(uri) {
    const prefix = `zen://${this.instanceId}/`;
    if (typeof uri !== "string" || !uri.startsWith(prefix)) {
      throw new McpProtocolError(-32002, "Resource not found", 404);
    }
    const name = uri.slice(prefix.length);
    if (RESOURCE_NAMES.includes(name)) {
      return name;
    }
    if (name.startsWith("tabs/") && name.length > 5) {
      try {
        this.getTab(name.slice(5));
      } catch {
        throw new McpProtocolError(-32002, "Resource not found", 404);
      }
      return name;
    }
    throw new McpProtocolError(-32002, "Resource not found", 404);
  }

  async readResource(uri, _client) {
    const name = this.assertResource(uri);
    let value;
    if (name === "state") {
      value = this.state();
    } else if (name === "events") {
      value = {
        instanceId: this.instanceId,
        sequence: this.sequence,
        events: this.events,
      };
    } else if (name === "capabilities") {
      value = { instanceId: this.instanceId, tools: this.tools };
    } else {
      const tab = this.getTab(name.slice(5));
      value = {
        instanceId: this.instanceId,
        windowId: this.windowId(tab.ownerGlobal ?? tab.documentGlobal),
        tabId: this.tabId(tab),
        title: tab.label,
        discarded: tab.hasAttribute("pending"),
        selected: tab.selected,
      };
    }
    return [{ uri, mimeType: "application/json", text: JSON.stringify(value) }];
  }

  async executeTool(name, args, client, signal) {
    if (name === "zen_browser_state") {
      return this.state();
    }
    if (name === "zen_events") {
      const after = args.after ?? 0;
      const limit = args.limit ?? 100;
      if (after < 0 || limit < 1 || limit > 500) {
        throw new McpToolError(
          "invalid_pagination",
          "after must be nonnegative and limit from 1 to 500"
        );
      }
      const events = this.events
        .filter(item => item.sequence > after)
        .slice(0, limit);
      return {
        instanceId: this.instanceId,
        events,
        sequence: this.sequence,
        oldestSequence: this.events[0]?.sequence ?? this.sequence,
        nextSequence: events.at(-1)?.sequence ?? after,
      };
    }
    if (name === "zen_client_disconnect") {
      this.protocol.disconnect(client.id);
      return { instanceId: this.instanceId, disconnected: true };
    }
    const provider = this.browserTools
      .getTools()
      .some(tool => tool.name === name)
      ? this.browserTools
      : this.pageTools;
    return provider.execute(name, args, client, signal);
  }

  cleanup(clientId) {
    this.clientActivity.delete(clientId);
    return Promise.all([
      this.browserTools?.cleanup(clientId),
      this.pageTools?.cleanup(clientId),
    ]).catch(() => {});
  }

  maintenance() {
    this.protocol?.pruneSessions();
    for (const transport of [...this.transports]) {
      if (transport.response._connection._closed || transport.response._ended) {
        this.transports.delete(transport);
        transport.controller.abort();
        if (transport.stream) {
          this.protocol?.removeStream(transport.stream);
        }
      } else if (transport.stream && Date.now() - transport.lastPing > 15000) {
        try {
          writeUtf8(transport.response, ": keep-alive\n\n");
          transport.lastPing = Date.now();
        } catch {
          this.protocol?.removeStream(transport.stream);
        }
      }
    }
    for (const [clientId, lastUsed] of this.clientActivity) {
      if (
        Date.now() - lastUsed > 30000 &&
        ![...this.transports].some(item => item.client.id === clientId)
      ) {
        this.cleanup(clientId);
      }
    }
    this.flushAudit();
  }

  async flushAudit() {
    if (this.auditWriting || !this.auditEntries.length) {
      return;
    }
    this.auditWriting = true;
    const entries = this.auditEntries.splice(0);
    try {
      const file = PathUtils.join(PathUtils.profileDir, "zen-mcp-audit.jsonl");
      const stat = await IOUtils.stat(file).catch(() => null);
      if (stat?.size > 1024 * 1024) {
        await IOUtils.remove(file, { ignoreAbsent: true });
      }
      await IOUtils.writeUTF8(
        file,
        entries.map(entry => JSON.stringify(entry)).join("\n") + "\n",
        { mode: "append" }
      );
      await IOUtils.setPermissions(file, 0o600, false);
    } catch {
      // Audit write failure does not leak request arguments through console output.
    } finally {
      this.auditWriting = false;
    }
  }

  audit(method, args, result, start) {
    const entry = {
      time: Date.now(),
      method: AUDIT_METHODS.has(method) ? method : "unknown",
      result,
      durationMs: Date.now() - start,
    };
    for (const key of [
      "instanceId",
      "windowId",
      "tabId",
      "documentId",
      "frameId",
    ]) {
      if (
        typeof args?.[key] === "string" &&
        /^[a-zA-Z0-9-]{1,100}$/.test(args[key])
      ) {
        entry[key] = args[key];
      }
    }
    this.auditEntries.push(entry);
    if (this.auditEntries.length > EVENT_LIMIT) {
      this.auditEntries.shift();
    }
  }

  respond(response, status, body, extra = {}) {
    response.setStatusLine(
      "1.1",
      status,
      {
        200: "OK",
        202: "Accepted",
        400: "Bad Request",
        401: "Unauthorized",
        403: "Forbidden",
        404: "Not Found",
        405: "Method Not Allowed",
        406: "Not Acceptable",
        413: "Content Too Large",
        415: "Unsupported Media Type",
        429: "Too Many Requests",
        500: "Internal Server Error",
      }[status] ?? "Error"
    );
    response.setHeader("Cache-Control", "no-store", false);
    response.setHeader("X-Content-Type-Options", "nosniff", false);
    for (const [name, value] of Object.entries(extra)) {
      response.setHeader(name, value, false);
    }
    if (body !== undefined) {
      response.setHeader(
        "Content-Type",
        "application/json; charset=utf-8",
        false
      );
      writeUtf8(response, JSON.stringify(body));
    }
    response.finish();
  }

  async handleHttp(request, response) {
    response.processAsync();
    const start = Date.now();
    let message;
    let client;
    let transport;
    let handedToStream = false;
    const headers = headersFrom(request);
    try {
      checkEndpoint(headers, this.listeningPort);
      client = this.credentials.authenticate(
        getHeader(headers, "authorization")
      );
      if (!client) {
        this.respond(
          response,
          401,
          errorMessage(
            null,
            new McpProtocolError(-32000, "Bearer authorization required")
          ),
          { "WWW-Authenticate": 'Bearer realm="Zen MCP"' }
        );
        return;
      }
      this.clientActivity.set(client.id, Date.now());
      if (
        [...this.transports].filter(item => item.client.id === client.id)
          .length >= 16
      ) {
        throw new McpProtocolError(-32000, "Too many concurrent requests", 429);
      }
      transport = { client, response, controller: new AbortController() };
      this.transports.add(transport);
      if (request.method === "DELETE") {
        if (getHeader(headers, "mcp-protocol-version") === MCP_MODERN_VERSION) {
          throw new McpProtocolError(-32600, "Method not allowed", 405);
        }
        this.protocol.deleteSession(headers, client);
        this.respond(response, 200);
        return;
      }
      if (request.method === "GET") {
        if (getHeader(headers, "mcp-protocol-version") === MCP_MODERN_VERSION) {
          throw new McpProtocolError(-32600, "Method not allowed", 405);
        }
        if (!getHeader(headers, "accept").includes("text/event-stream")) {
          throw new McpProtocolError(
            -32600,
            "Accept must include text/event-stream",
            406
          );
        }
        const context = this.protocol.session(headers, client);
        this.beginStream({ context, filter: {} }, transport);
        handedToStream = true;
        return;
      }
      if (request.method !== "POST") {
        throw new McpProtocolError(-32600, "Method not allowed", 405);
      }
      const accept = getHeader(headers, "accept");
      if (
        !accept.includes("application/json") ||
        !accept.includes("text/event-stream")
      ) {
        throw new McpProtocolError(
          -32600,
          "Accept must include application/json and text/event-stream",
          406
        );
      }
      if (
        getHeader(headers, "content-type").split(";")[0].trim() !==
        "application/json"
      ) {
        throw new McpProtocolError(
          -32600,
          "Content-Type must be application/json",
          415
        );
      }
      if (
        Number(getHeader(headers, "content-length")) > MAX_BODY ||
        request.bodyInputStream.available() > MAX_BODY
      ) {
        throw new McpProtocolError(-32600, "Request body too large", 413);
      }
      const input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
        Ci.nsIBinaryInputStream
      );
      input.setInputStream(request.bodyInputStream);
      const bytes = input.readByteArray(input.available());
      message = parseMessage(decodeBody(bytes), true);
      const result = Array.isArray(message)
        ? await this.protocol.handleBatch(
            message,
            headers,
            client,
            transport.controller.signal
          )
        : await this.protocol.handle(
            message,
            headers,
            client,
            transport.controller.signal
          );
      if (result.stream) {
        this.beginStream(result.stream, transport);
        handedToStream = true;
      } else if (result.batch) {
        response.setStatusLine("1.1", 200, "OK");
        response.setHeader(
          "Content-Type",
          "text/event-stream; charset=utf-8",
          false
        );
        response.setHeader("Cache-Control", "no-store", false);
        for (const item of result.batch) {
          writeUtf8(
            response,
            `event: message\ndata: ${JSON.stringify(item)}\n\n`
          );
        }
        response.finish();
      } else {
        this.respond(
          response,
          result.status ?? 200,
          result.body,
          result.sessionId ? { "Mcp-Session-Id": result.sessionId } : {}
        );
      }
      this.audit(
        message.method,
        message.params?.arguments,
        result.body?.result?.isError ? "tool_error" : "ok",
        start
      );
    } catch (error) {
      this.audit(
        message?.method ?? "http",
        message?.params?.arguments,
        "error",
        start
      );
      try {
        this.respond(
          response,
          error.status ?? 500,
          errorMessage(message?.id, error)
        );
      } catch {}
    } finally {
      if (transport && !handedToStream) {
        this.transports.delete(transport);
      }
    }
  }

  beginStream(spec, transport) {
    const { response } = transport;
    transport.lastPing = Date.now();
    response.setStatusLine("1.1", 200, "OK");
    response.setHeader(
      "Content-Type",
      "text/event-stream; charset=utf-8",
      false
    );
    response.setHeader("Cache-Control", "no-store", false);
    response.setHeader("X-Content-Type-Options", "nosniff", false);
    const write = value =>
      writeUtf8(response, `event: message\ndata: ${JSON.stringify(value)}\n\n`);
    transport.stream = this.protocol.openStream(spec, write, () => {
      this.transports.delete(transport);
      transport.controller.abort();
      try {
        response.finish();
      } catch {}
    });
    if (!spec.context.modern) {
      writeUtf8(response, ": Zen MCP subscription stream\n\n");
    }
  }
}

export const ZenMcpService = new ZenMcpServiceImpl();
