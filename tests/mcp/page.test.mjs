import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const mocks = {};
globalThis.ChromeUtils = {
  defineESModuleGetters(target, exports) {
    for (const name of Object.keys(exports)) {
      Object.defineProperty(target, name, {
        get: () => mocks[name],
        configurable: true,
      });
    }
  },
  generateQI: () =>
    function () {
      return this;
    },
};
globalThis.Services = { uuid: { generateUUID: () => `{${randomUUID()}}` } };
globalThis.JSWindowActorParent = class {};
globalThis.JSWindowActorChild = class {};
globalThis.Ci = {
  nsIWebNavigation: { LOAD_FLAGS_NONE: 0, STOP_ALL: 3 },
  nsIWebProgressListener: { STATE_IS_DOCUMENT: 1 },
};

// Import production modules with only Gecko's module resolver replaced. The
// provider/actor implementations, stores, validation and data flow stay intact.
const moduleURLs = new Map();
async function moduleURL(relative) {
  if (moduleURLs.has(relative)) {
    return moduleURLs.get(relative);
  }
  const source = await readFile(path.join(repo, relative), "utf8");
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)];
  let transformed = source;
  for (const match of imports) {
    const uri = match[1];
    let replacement;
    if (uri === "resource://gre/modules/Timer.sys.mjs") {
      replacement = "node:timers";
    } else if (uri.startsWith("resource:///modules/zen/mcp/")) {
      replacement = await moduleURL(`src/zen/mcp/${uri.split("/").at(-1)}`);
    } else if (uri.startsWith("resource:///actors/ZenMcp")) {
      replacement = await moduleURL(
        `src/zen/mcp/actors/${uri.split("/").at(-1)}`,
      );
    } else {
      throw new Error(`Unmocked Gecko dependency: ${uri}`);
    }
    transformed = transformed.replace(`from "${uri}"`, `from "${replacement}"`);
  }
  const url = `data:text/javascript;base64,${Buffer.from(transformed).toString("base64")}`;
  moduleURLs.set(relative, url);
  return url;
}
const load = async (relative) => import(await moduleURL(relative));
const { SnapshotStore, McpToolError } = await load(
  "src/zen/mcp/ZenMcpUtils.sys.mjs",
);
const { ZenMcpPageTools, findFrame, withDeadline, screenshotClip } = await load(
  "src/zen/mcp/ZenMcpPageTools.sys.mjs",
);
const { ZenMcpDevTools, consoleRecord } = await load(
  "src/zen/mcp/ZenMcpDevTools.sys.mjs",
);
const {
  snapshotDocument,
  takeElement,
  validateAction,
  performAction,
  boundedValue,
} = await load("src/zen/mcp/actors/ZenMcpInteraction.sys.mjs");
const { ZenMcpChild } = await load("src/zen/mcp/actors/ZenMcpChild.sys.mjs");
const { ZenMcpParent } = await load("src/zen/mcp/actors/ZenMcpParent.sys.mjs");

function documentFixture() {
  const win = {
    windowGlobalChild: { innerWindowId: 10 },
    Event,
    windowUtils: {
      setHandlingUserInput: () => ({ destruct() {} }),
      dispatchDOMEventViaPresShellForTesting() {},
    },
    innerWidth: 800,
    innerHeight: 600,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: (element) => ({
      display: element.hidden ? "none" : "block",
      visibility: "visible",
    }),
  };
  const doc = {
    nodeType: 9,
    documentURI: "https://fixture.invalid/",
    title: "Synthetic fixture",
    readyState: "complete",
    defaultView: win,
    children: [],
    nodePrincipal: { origin: "https://fixture.invalid" },
    querySelector(selector) {
      if (selector === "[") {
        throw Object.assign(new Error(), { name: "SyntaxError" });
      }
      return null;
    },
    getElementById(id) {
      return this.children.find((element) => element.id === id) || null;
    },
    createTreeWalker(root, mask) {
      const elements = [];
      const visit = (node) => {
        for (const child of node.children || []) {
          if ((mask & (child.nodeType === 3 ? 4 : 1)) !== 0) {
            elements.push(child);
          }
          visit(child);
        }
      };
      visit(root);
      let index = 0;
      return { nextNode: () => elements[index++] || null };
    },
    elementFromPoint() {
      return doc.body;
    },
  };
  win.document = doc;
  function element(tag, id, attributes = {}) {
    const item = {
      nodeType: 1,
      localName: tag,
      id,
      textContent: attributes.text || "",
      children: [],
      ownerDocument: doc,
      documentGlobal: win,
      isConnected: true,
      disabled: false,
      hidden: false,
      type: attributes.type || "",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      getAttribute: (key) => (key === "id" ? id : (attributes[key] ?? null)),
      getBoundingClientRect: () => ({
        x: 5,
        y: 5,
        left: 5,
        right: 105,
        top: 5,
        bottom: 25,
        width: 100,
        height: 20,
      }),
      matches: (selector) =>
        selector
          .split(",")
          .some((part) => part === tag || part === `#${id}` || part === "*"),
      closest: () => null,
      contains: (other) => other === item || item.children.includes(other),
      focus() {
        doc.activeElement = item;
      },
      scrollIntoView() {},
    };
    return item;
  }
  doc.body = element("body", "body");
  doc.children.push(doc.body);
  return { win, doc, element };
}

function tabFixture(id = 1) {
  const tab = new EventTarget();
  tab.linkedPanel = "panel";
  tab.hasAttribute = () => false;
  const top = {
    id,
    children: [],
    parent: null,
    isDiscarded: false,
    currentWindowGlobal: {
      innerWindowId: 10,
      osPid: 40,
      documentURI: { spec: "https://fixture.invalid/" },
    },
  };
  top.top = top;
  tab.linkedBrowser = { browsingContext: top };
  return { tab, top };
}

function serviceFixture(tabs = new Map()) {
  const notifications = [];
  return {
    instanceId: "epoch-1",
    notifications,
    getTab(id) {
      const tab = tabs.get(id);
      if (!tab) {
        throw new McpToolError("missing_tab", "missing");
      }
      return tab;
    },
    assertInstance(args) {
      assert.equal(args.instanceId, this.instanceId);
    },
    notify(kind, payload) {
      notifications.push({ kind, payload });
    },
    state: () => ({ instanceId: "epoch-1" }),
  };
}

test("all page/chrome tools describe inputs, output identifiers and mutation annotations", () => {
  const provider = new ZenMcpPageTools(serviceFixture(), {
    devtools: { cleanup() {}, destroy() {} },
  });
  const tools = provider.getTools();
  assert.equal(tools.length, 13);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith("zen_"));
    assert.ok(tool.inputSchema.required.includes("instanceId"));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema.required.includes("instanceId"));
  }
  assert.equal(
    tools.find((tool) => tool.name === "zen_javascript").annotations
      .readOnlyHint,
    false,
  );
  assert.match(
    tools.find((tool) => tool.name === "zen_javascript").description,
    /unrestricted system-principal/,
  );
});

test("foreign, discarded, reparented and unloaded frames are rejected before access", () => {
  const { tab, top } = tabFixture();
  const child = { id: 2, parent: top, top, children: [] };
  top.children.push(child);
  assert.equal(findFrame(tab, "2"), child);
  assert.throws(() => findFrame(tab, "3"), { code: "wrong_frame_target" });
  child.top = {};
  assert.throws(() => findFrame(tab, "2"), { code: "wrong_frame_target" });
  child.top = top;
  child.isDiscarded = true;
  assert.throws(() => findFrame(tab, "2"), { code: "wrong_frame_target" });
  const dormant = {
    linkedPanel: "",
    hasAttribute: () => false,
    get linkedBrowser() {
      throw new Error("dormant tab was woken");
    },
  };
  assert.throws(() => findFrame(dormant), { code: "tab_unloaded" });
});

test("frame listing does not read a dormant browser and is paginated without attachment", async () => {
  const dormant = {
    linkedPanel: "",
    hasAttribute: () => false,
    get linkedBrowser() {
      throw new Error("woken");
    },
  };
  const provider = new ZenMcpPageTools(
    serviceFixture(new Map([["tab-1", dormant]])),
    { devtools: { cleanup() {}, destroy() {} } },
  );
  assert.deepEqual(
    await provider.execute(
      "zen_page_frames",
      { instanceId: "epoch-1", tabId: "tab-1" },
      { id: "a" },
    ),
    {
      instanceId: "epoch-1",
      tabId: "tab-1",
      unloaded: true,
      items: [],
      total: 0,
    },
  );
});

test("snapshots are bound to client/document and consumed by one action", () => {
  const { win, doc, element } = documentFixture();
  const button = element("button", "save", { text: "Save" });
  doc.body.children.push(button);
  let now = 1000;
  const store = new SnapshotStore({ now: () => now, id: () => "snapshot" });
  const snapshot = snapshotDocument(win, store, "a", "tab-1", {
    selector: "button",
  });
  const args = { ...snapshot, elementId: "e1" };
  assert.throws(() => takeElement(win, store, "b", "tab-1", args), {
    code: "wrong_snapshot_target",
  });
  assert.equal(takeElement(win, store, "a", "tab-1", args), button);
  assert.throws(() => takeElement(win, store, "a", "tab-1", args), {
    code: "stale_snapshot",
  });
  const fresh = snapshotDocument(win, store, "a", "tab-1", {
    selector: "button",
  });
  now += 30001;
  assert.throws(
    () => takeElement(win, store, "a", "tab-1", { ...fresh, elementId: "e1" }),
    { code: "stale_snapshot" },
  );
  now = 1000;
  const old = snapshotDocument(win, store, "a", "tab-1", {
    selector: "button",
  });
  win.windowGlobalChild.innerWindowId++;
  assert.throws(
    () => takeElement(win, store, "a", "tab-1", { ...old, elementId: "e1" }),
    { code: "stale_document" },
  );
});

test("removed and repurposed elements cannot be acted on through fresh-looking IDs", () => {
  const { win, doc, element } = documentFixture();
  const button = element("button", "save", { text: "Save" });
  doc.body.children.push(button);
  const store = new SnapshotStore();
  const old = snapshotDocument(win, store, "a", "tab", { selector: "button" });
  button.textContent = "Delete all";
  assert.throws(
    () => takeElement(win, store, "a", "tab", { ...old, elementId: "e1" }),
    { code: "changed_element" },
  );
  const second = snapshotDocument(win, store, "a", "tab", {
    selector: "button",
  });
  button.isConnected = false;
  assert.throws(
    () => takeElement(win, store, "a", "tab", { ...second, elementId: "e1" }),
    { code: "stale_element" },
  );
});

test("open shadow roots and zero-rect native menu items remain inspectable", async () => {
  const { win, doc, element } = documentFixture();
  const host = element("div", "shadow-host");
  const inner = element("button", "shadow-button", {
    "aria-label": "Shadow button",
  });
  host.shadowRoot = { nodeType: 11, children: [inner] };
  doc.body.children.push(host);
  const menu = element("menuitem", "menu", { label: "Bookmark" });
  const popup = element("menupopup", "popup");
  popup.state = "open";
  menu.closest = (selector) => (selector === "menupopup" ? popup : null);
  menu.parentElement = popup;
  menu.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0 });
  let commands = 0;
  menu.doCommand = () => commands++;
  doc.body.children.push(menu);
  const snapshot = snapshotDocument(
    win,
    new SnapshotStore(),
    "a",
    "window",
    { selector: "button,menuitem" },
    true,
  );
  assert.equal(snapshot.elements.length, 2);
  assert.ok(snapshot.elements.some((item) => item.name === "Shadow button"));
  assert.ok(snapshot.elements.some((item) => item.nativeMenu === true));
  await performAction(win, menu, { action: "click", elementId: "e1" }, true);
  assert.equal(commands, 1);
});

test("invalid action arguments fail before trusted event dispatch", () => {
  assert.throws(() => validateAction({ action: "input", text: 7 }), {
    code: "invalid_text",
  });
  assert.throws(() => validateAction({ action: "scroll", deltaY: Infinity }), {
    code: "invalid_scroll",
  });
  assert.throws(
    () => validateAction({ action: "upload", paths: ["relative/file"] }),
    { code: "invalid_paths" },
  );
  assert.throws(
    () => validateAction({ action: "key", key: "Enter", modifiers: ["super"] }),
    { code: "invalid_modifiers" },
  );
  assert.throws(() => validateAction({ action: "select", values: [] }), {
    code: "invalid_values",
  });
  validateAction({
    action: "upload",
    paths: ["/tmp/fixture.txt", "C:\\fixture.txt"],
  });
});

test("actor fixed commands include scoped storage but never parent authorization", async () => {
  const { win } = documentFixture();
  const values = new Map([
    ["first", "1"],
    ["second", "2"],
  ]);
  win.localStorage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index],
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
  };
  const actor = new ZenMcpChild();
  actor.contentWindow = win;
  actor.browsingContext = { id: 42 };
  actor.manager = { isCurrentGlobal: true, isClosed: false };
  const call = (command, args) =>
    actor.receiveMessage({
      name: "ZenMcp:Query",
      data: { clientId: "a", requestId: randomUUID(), command, args },
    });
  const list = await call("storage", {
    area: "local",
    action: "list",
    limit: 1,
  });
  assert.equal(list.ok, true);
  assert.equal(list.value.origin, "https://fixture.invalid");
  assert.equal(list.value.documentId, "10");
  assert.equal(list.value.nextCursor, "1");
  assert.equal(
    (await call("storage", { area: "local", action: "get", key: "second" }))
      .value.value,
    "2",
  );
  assert.equal(
    (
      await call("storage", {
        area: "local",
        action: "set",
        key: "first",
        value: 4,
      })
    ).error.code,
    "invalid_value",
  );
  assert.equal(
    (await call("executeParent", { source: "privileged" })).error.code,
    "unknown_page_command",
  );
  actor.manager.isCurrentGlobal = false;
  assert.equal((await call("identity", {})).error.code, "stale_document");
  assert.throws(
    () =>
      new ZenMcpParent().receiveMessage({
        name: "evaluate",
        data: { source: "privileged" },
      }),
    /does not accept/,
  );
  actor.didDestroy();
});

test("provider sends only client/target scoped queries and cleanup reaches the actor", async () => {
  const { tab, top } = tabFixture();
  const messages = [];
  top.currentWindowGlobal.getActor = () => ({
    sendQuery: async (name, data) => {
      messages.push({ name, data });
      return {
        ok: true,
        value: { frameId: "1", documentId: "10", text: "Synthetic" },
      };
    },
    sendAsyncMessage: (name, data) => messages.push({ name, data }),
  });
  const provider = new ZenMcpPageTools(
    serviceFixture(new Map([["tab", tab]])),
    { devtools: { cleanup() {}, destroy() {} } },
  );
  const result = await provider.execute(
    "zen_page_text",
    { instanceId: "epoch-1", tabId: "tab" },
    { id: "client-a", name: "A" },
  );
  assert.equal(result.instanceId, "epoch-1");
  assert.equal(result.observed.documentId, "10");
  assert.equal(messages[0].data.clientId, "client-a");
  assert.equal(messages[0].data.command, "text");
  assert.equal("token" in messages[0].data, false);
  provider.cleanup("client-a");
  assert.equal(messages.at(-1).name, "ZenMcp:Cleanup");
  assert.equal(provider.actors.size, 0);
});

test("waiting timeout/cancellation does not retry and removes abort handlers", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const pending = withDeadline(
    new Promise(() => {}),
    1000,
    controller.signal,
    () => cancelled++,
  );
  controller.abort();
  await assert.rejects(pending, { code: "cancelled" });
  assert.equal(cancelled, 1);
  await assert.rejects(withDeadline(new Promise(() => {}), 1), {
    code: "operation_timeout",
  });
  assert.equal(await withDeadline(Promise.resolve("ready"), 1000), "ready");
});

test("screenshots default to viewport and reject unbounded/outside clips", () => {
  assert.deepEqual(screenshotClip({}, { width: 800, height: 600 }), {
    x: 0,
    y: 0,
    width: 800,
    height: 600,
  });
  assert.throws(
    () =>
      screenshotClip(
        { clip: { x: 0, y: 0, width: Infinity, height: 5 } },
        { width: 800, height: 600 },
      ),
    { code: "invalid_clip" },
  );
  assert.throws(
    () =>
      screenshotClip(
        { clip: { x: 799, y: 0, width: 2, height: 5 } },
        { width: 800, height: 600 },
      ),
    { code: "invalid_clip" },
  );
});

function commandsFixture(top) {
  const watchers = [],
    requests = [];
  let destroyed = 0;
  const commands = {
    descriptorFront: {},
    targetCommand: {
      TYPES: { FRAME: "frame" },
      targetFront: { browsingContextID: top.id },
      async startListening() {},
      getAllTargets() {
        return [this.targetFront];
      },
    },
    resourceCommand: {
      async watchResources(types, callbacks) {
        watchers.push({ types, callbacks });
      },
      unwatchResources(types, callbacks) {
        for (const watcher of watchers) {
          if (watcher.callbacks.onAvailable === callbacks.onAvailable) {
            watcher.types = watcher.types.filter(
              (type) => !types.includes(type),
            );
          }
        }
      },
    },
    client: {
      async request(packet) {
        requests.push(packet);
        return (
          {
            getRequestHeaders: { headers: [{ name: "test", value: "yes" }] },
            getResponseHeaders: {
              headers: [{ name: "content-type", value: "text/plain" }],
            },
            getRequestPostData: { postData: { text: "synthetic post" } },
            getResponseContent: { content: { text: "synthetic response" } },
          }[packet.type] || {}
        );
      },
    },
    scriptCommand: {
      async execute(expression, options) {
        commands.evaluation = { expression, options };
        return { result: '{"value":42,"truncated":false}' };
      },
    },
    async destroy() {
      destroyed++;
    },
  };
  return {
    commands,
    watchers,
    requests,
    get destroyed() {
      return destroyed;
    },
  };
}

test("DevTools lazily attaches independent clients and disconnect releases only their collectors", async () => {
  const { tab, top } = tabFixture();
  const service = serviceFixture(new Map([["tab", tab]]));
  const created = [];
  const provider = new ZenMcpDevTools(service, {
    factory: () => ({
      forTab: async () => {
        const item = commandsFixture(top);
        created.push(item);
        return item.commands;
      },
    }),
  });
  assert.equal(created.length, 0);
  await provider.console({ tabId: "tab", action: "start" }, { id: "a" });
  await provider.console({ tabId: "tab", action: "start" }, { id: "b" });
  assert.equal(created.length, 2);
  assert.equal(
    created[0].commands.descriptorFront.doNotAttachThreadActor,
    true,
  );
  created[0].watchers[0].callbacks.onAvailable([
    {
      resourceType: "console-message",
      message: { timeStamp: 1, arguments: ["synthetic-a"], level: "log" },
    },
  ]);
  assert.equal(
    (await provider.console({ tabId: "tab", action: "read" }, { id: "a" }))
      .items.length,
    1,
  );
  assert.equal(
    (await provider.console({ tabId: "tab", action: "read" }, { id: "b" }))
      .items.length,
    0,
  );
  assert.deepEqual(Object.keys(service.notifications[0].payload).sort(), [
    "clientId",
    "sequence",
    "tabId",
  ]);
  await provider.cleanup("a");
  assert.equal(created[0].destroyed, 1);
  assert.equal(created[0].watchers[0].types.length, 0);
  assert.equal(created[1].destroyed, 0);
  await provider.destroy();
  assert.equal(created[1].destroyed, 1);
  assert.equal(provider.entries.size, 0);
});

test("network details use captured request IDs, real actor headers/bodies, and client isolation", async () => {
  const { tab, top } = tabFixture();
  const fixture = commandsFixture(top);
  const provider = new ZenMcpDevTools(serviceFixture(new Map([["tab", tab]])), {
    factory: () => ({ forTab: async () => fixture.commands }),
  });
  await provider.network({ tabId: "tab", action: "start" }, { id: "a" });
  const callbacks = fixture.watchers[0].callbacks;
  callbacks.onAvailable([
    {
      resourceType: "network-event",
      resourceId: 12,
      actor: "net-actor-12",
      url: "https://fixture.invalid/api",
      method: "POST",
      browsingContextID: 1,
      innerWindowId: 10,
    },
  ]);
  callbacks.onUpdated([
    {
      resource: {
        resourceId: 12,
        url: "https://fixture.invalid/api",
        method: "POST",
        status: 200,
      },
      update: {},
    },
  ]);
  const details = await provider.network(
    { tabId: "tab", action: "details", requestId: "12", includeBodies: true },
    { id: "a" },
  );
  assert.equal(details.request.status, 200);
  assert.equal(details.request.requestBody, "synthetic post");
  assert.equal(details.request.responseBody, "synthetic response");
  assert.equal(details.request.requestHeaders[0].value, "yes");
  assert.ok(fixture.requests.every((request) => request.to === "net-actor-12"));
  assert.equal("actorId" in details.request, false);
  await assert.rejects(
    provider.network(
      { tabId: "tab", action: "details", requestId: "wrong" },
      { id: "a" },
    ),
    { code: "missing_request" },
  );
  await provider.destroy();
});

test("revoke during asynchronous DevTools attachment cannot leave a late collector", async () => {
  const { tab, top } = tabFixture();
  const fixture = commandsFixture(top);
  let attached;
  const provider = new ZenMcpDevTools(serviceFixture(new Map([["tab", tab]])), {
    factory: () => ({
      forTab: () =>
        new Promise((resolve) => {
          attached = resolve;
        }),
    }),
  });
  const pending = provider.console(
    { tabId: "tab", action: "start" },
    { id: "a" },
  );
  await provider.cleanup("a");
  attached(fixture.commands);
  await assert.rejects(pending, { code: "client_disconnected" });
  assert.equal(fixture.destroyed, 1);
  assert.equal(fixture.watchers.length, 0);
  assert.equal(provider.entries.size, 0);
});

test("evaluation uses an explicit same-process ancestor frame, not the selected UI target", async () => {
  const { tab, top } = tabFixture();
  const middle = {
    id: 2,
    parent: top,
    top,
    currentWindowGlobal: { osPid: 40, innerWindowId: 20 },
  };
  const frame = {
    id: 3,
    parent: middle,
    top,
    currentWindowGlobal: { osPid: 40, innerWindowId: 30 },
  };
  const fixture = commandsFixture(top);
  const provider = new ZenMcpDevTools(serviceFixture(new Map([["tab", tab]])), {
    factory: () => ({ forTab: async () => fixture.commands }),
  });
  assert.equal(
    (await provider.evaluate("tab", frame, "40 + 2", { id: "a" })).value,
    42,
  );
  assert.equal(fixture.commands.evaluation.options.innerWindowID, 30);
  assert.equal(
    fixture.commands.evaluation.options.selectedTargetFront.browsingContextID,
    1,
  );
  frame.currentWindowGlobal.osPid = 41;
  await assert.rejects(provider.evaluate("tab", frame, "42", { id: "a" }), {
    code: "target_unavailable",
  });
  await provider.destroy();
});

test("bounded values serialize cycles/bigints safely and cap text/entry growth", () => {
  const cyclic = { value: 1n, text: "abcdefghij" };
  cyclic.self = cyclic;
  const value = boundedValue(cyclic);
  assert.deepEqual(value.value.value, { type: "bigint", value: "1" });
  assert.deepEqual(value.value.self, { type: "circular" });
  assert.equal(boundedValue("123456", { maxChars: 3 }).truncated, true);
  assert.equal(
    boundedValue(
      Array.from({ length: 5000 }, (_, id) => id),
      { maxEntries: 10 },
    ).value.length,
    9,
  );
  assert.deepEqual(
    boundedValue(
      new Proxy(
        {},
        {
          get() {
            throw new Error("inaccessible");
          },
        },
      ),
    ).value,
    { type: "unreadable" },
  );
});

test("trusted double/context click sequences contain actual pointer actions", async () => {
  const { win, doc, element } = documentFixture();
  const button = element("button", "target");
  doc.elementFromPoint = () => button;
  const events = [];
  mocks.event = {
    async synthesizeMouseAtPoint(x, y, options) {
      events.push(options);
    },
  };
  await performAction(win, button, { action: "double_click" });
  assert.deepEqual(
    events.map((event) => event.clickCount),
    [1, 2],
  );
  events.length = 0;
  await performAction(win, button, { action: "context_click" });
  assert.deepEqual(
    events.map((event) => event.type),
    ["mousedown", "contextmenu", "mouseup"],
  );
  assert.ok(events.every((event) => event.button === 2));
});

test("native pointer checks accept the control's shadow child and reject unrelated covers", async () => {
  const { win, doc, element } = documentFixture();
  const button = element("toolbarbutton", "target");
  button.namespaceURI = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const inner = element("toolbarbutton", "inner");
  inner.getRootNode = () => ({ host: button });
  doc.elementFromPoint = () => inner;
  let events = 0;
  mocks.event = { async synthesizeMouseAtPoint() { events++; } };
  await performAction(win, button, { action: "click" }, true);
  assert.equal(events, 1);
  const cover = element("div", "cover");
  cover.getRootNode = () => doc;
  doc.elementFromPoint = () => cover;
  await assert.rejects(performAction(win, button, { action: "click" }, true), { code: "click_intercepted" });
  assert.equal(events, 1);
});

test("navigation cannot report the previous ready document while the new load is starting", async () => {
  const { tab, top } = tabFixture();
  let progress;
  let readOldDocument = 0;
  top.currentWindowGlobal.getActor = () => ({
    async sendQuery() {
      if (top.currentWindowGlobal.innerWindowId === 10) {
        readOldDocument++;
      }
      return {
        ok: true,
        value: {
          documentId: String(top.currentWindowGlobal.innerWindowId),
          readyState: "complete",
        },
      };
    },
    sendAsyncMessage() {},
  });
  tab.linkedBrowser.webProgress = { isLoadingDocument: false };
  tab.linkedBrowser.addProgressListener = (listener) => (progress = listener);
  tab.linkedBrowser.removeProgressListener = () => {};
  tab.linkedBrowser.reloadWithFlags = () => {
    progress.onStateChange({ isTopLevel: true }, null, 1);
    setTimeout(() => {
      top.currentWindowGlobal.innerWindowId = 11;
    }, 10);
  };
  const provider = new ZenMcpPageTools(
    serviceFixture(new Map([["tab", tab]])),
    { devtools: { cleanup() {}, destroy() {} } },
  );
  const result = await provider.execute(
    "zen_page_navigate",
    { instanceId: "epoch-1", tabId: "tab", action: "reload", timeoutMs: 1000 },
    { id: "a" },
  );
  assert.equal(result.documentId, "11");
  assert.equal(readOldDocument, 0);
});

test("revocation during target startListening destroys commands only once", async () => {
  const { tab, top } = tabFixture();
  const fixture = commandsFixture(top);
  let startResolved;
  fixture.commands.targetCommand.startListening = () =>
    new Promise((resolve) => (startResolved = resolve));
  const provider = new ZenMcpDevTools(serviceFixture(new Map([["tab", tab]])), {
    factory: () => ({ forTab: async () => fixture.commands }),
  });
  const pending = provider.console(
    { tabId: "tab", action: "start" },
    { id: "a" },
  );
  await Promise.resolve();
  await provider.cleanup("a");
  startResolved();
  await assert.rejects(pending, { code: "client_disconnected" });
  assert.equal(fixture.destroyed, 1);
});

test("IndexedDB lists stay scoped to frame origin and never create a missing database", async () => {
  const { win } = documentFixture();
  let opens = 0;
  win.indexedDB = {
    async databases() {
      return [
        { name: "one", version: 1 },
        { name: "two", version: 3 },
      ];
    },
    open() {
      opens++;
      throw new Error("Unexpected create");
    },
  };
  const actor = new ZenMcpChild();
  actor.contentWindow = win;
  actor.browsingContext = { id: 1 };
  actor.manager = { isCurrentGlobal: true, isClosed: false };
  const call = (args) =>
    actor.receiveMessage({
      name: "ZenMcp:Query",
      data: {
        clientId: "a",
        requestId: randomUUID(),
        command: "storage",
        args: { area: "indexedDB", ...args },
      },
    });
  const list = await call({ action: "list", limit: 1 });
  assert.equal(list.value.items[0].name, "one");
  assert.equal(list.value.origin, "https://fixture.invalid");
  assert.equal(list.value.nextCursor, "1");
  assert.equal(
    (
      await call({
        action: "get",
        database: "foreign",
        store: "records",
        key: "secret",
      })
    ).error.code,
    "missing_database",
  );
  assert.equal(opens, 0);
  actor.didDestroy();
});

test("an IndexedDB connection opening after a blocked reply is closed immediately", async () => {
  const { win } = documentFixture();
  let request,
    closed = 0;
  win.indexedDB = {
    async databases() {
      return [{ name: "one", version: 1 }];
    },
    open() {
      request = {};
      return request;
    },
  };
  const actor = new ZenMcpChild();
  actor.contentWindow = win;
  actor.browsingContext = { id: 1 };
  actor.manager = { isCurrentGlobal: true, isClosed: false };
  const pending = actor.receiveMessage({
    name: "ZenMcp:Query",
    data: {
      clientId: "a",
      requestId: "blocked",
      command: "storage",
      args: { area: "indexedDB", action: "list", database: "one" },
    },
  });
  await Promise.resolve();
  request.onblocked();
  assert.equal((await pending).error.code, "storage_blocked");
  request.result = {
    close() {
      closed++;
    },
  };
  request.onsuccess();
  assert.equal(closed, 1);
  actor.didDestroy();
});

test("form selection dispatches through privileged PresShell rather than page dispatchEvent", async () => {
  const { win, element } = documentFixture();
  const select = element("select", "choice");
  select.options = [
    { value: "one", selected: true },
    { value: "two", selected: false },
  ];
  const events = [];
  win.windowUtils.dispatchDOMEventViaPresShellForTesting = (target, event) =>
    events.push({ target, type: event.type });
  await performAction(win, select, { action: "select", values: ["two"] });
  assert.equal(select.options[0].selected, false);
  assert.equal(select.options[1].selected, true);
  assert.deepEqual(
    events.map((event) => event.type),
    ["input", "change"],
  );
  assert.ok(events.every((event) => event.target === select));
});

test("console document identity uses Gecko message.innerWindowID and does not guess a different frame", () => {
  const resource = {
    resourceType: "console-message",
    message: { innerWindowID: 50, arguments: ["synthetic"] },
    targetFront: { innerWindowId: 50, browsingContextID: 7 },
  };
  assert.equal(consoleRecord(resource).documentId, "50");
  assert.equal(consoleRecord(resource).frameId, "7");
  resource.message.innerWindowID = 51;
  assert.equal(consoleRecord(resource).documentId, "51");
  assert.equal(consoleRecord(resource).frameId, null);
});


test("browser JavaScript uses a system sandbox despite chrome CSP and releases it after async evaluation", async () => {
  const saved = Object.fromEntries(["Services", "Components", "Cu", "Cr", "Cc", "IOUtils", "PathUtils"].map(name => [name, globalThis[name]]));
  const principal = { system: true };
  const win = { document: { nodePrincipal: { isSystemPrincipal: true } }, setTimeout, clearTimeout,
    eval() { throw new Error("call to eval() blocked by CSP"); } };
  Object.defineProperty(win, "window", { get: () => win });
  let released = 0;
  globalThis.Services = { ...Services, testValue: 42, scriptSecurityManager: { getSystemPrincipal: () => principal } };
  globalThis.Cc = {}; globalThis.IOUtils = {}; globalThis.PathUtils = {};
  globalThis.Components = { results: {}, utils: {
    Sandbox(actualPrincipal, options) {
      assert.equal(actualPrincipal, principal);
      assert.equal(options.sandboxPrototype, win);
      assert.equal(options.wantXrays, false);
      assert.equal(options.freshCompartment, true);
      const sandbox = Object.create(win);
      Object.defineProperty(sandbox, "Components", { value: Components, configurable: false });
      return sandbox;
    },
    evalInSandbox(source, sandbox) { return vm.runInNewContext(source, sandbox); },
    nukeSandbox() { released++; },
  } };
  globalThis.Cu = Components.utils; globalThis.Cr = Components.results;
  try {
    const service = serviceFixture();service.getWindow = id => { assert.equal(id, "window");return win; };
    const provider = new ZenMcpPageTools(service, { devtools: { cleanup() {}, destroy() {} } });
    const result = await provider.execute("zen_javascript", {
      instanceId: "epoch-1", scope: "browser", windowId: "window",
      source: "(async()=>{await new Promise(r=>setTimeout(r,1));window.synthetic=Services.testValue;return {system:document.nodePrincipal.isSystemPrincipal,value:window.synthetic}})()",
    }, { id: "client" });
    assert.deepEqual(result.value, { system: true, value: 42 });
    assert.equal(win.synthetic, 42);
    assert.equal(released, 1);
    const failed = await provider.execute("zen_javascript", { instanceId: "epoch-1", scope: "browser", windowId: "window", source: "throw new Error('synthetic failure')" }, { id: "client" });
    assert.equal(failed.exception, "synthetic failure");assert.equal(released, 2);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});
