import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentConnection } from "../../src/zen/mcp/ZenMcpAgentConfig.sys.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const prefRoot = "src/browser/components/preferences/";
const source = readFileSync(join(root, prefRoot, "zen-mcp.js"), "utf8");
const markup = readFileSync(join(root, prefRoot, "zenMcp.inc.xhtml"), "utf8");
const locale = (language) =>
  readFileSync(
    join(root, `locales/${language}/browser/browser/preferences/zen-mcp.ftl`),
    "utf8",
  );
const messageIds = (text) =>
  new Set(
    Array.from(text.matchAll(/^([a-z][a-z0-9-]*)\s*=/gm), (match) => match[1]),
  );
const messages = messageIds(locale("en-US"));
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

class Element {
  constructor(tag = "div", id = "") {
    this.localName = tag;
    this.id = id;
    this.value = "";
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.validity = { badInput: false };
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) {
    this.listeners.get(type)?.delete(callback);
  }
  dispatch(type, detail = {}) {
    const event = { target: this, preventDefault() {}, ...detail };
    for (const callback of [...(this.listeners.get(type) || [])])
      callback(event);
    if (type === "command" && this.parentNode)
      this.parentNode.dispatch(type, event);
  }
  setAttribute(name, value) {
    assert.notEqual(name, "persist", "UI must never persist fields");
    this.attributes.set(name, String(value));
    if (name === "value") this.value = String(value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  appendChild(element) {
    if (element.localName === "fragment") {
      for (const child of [...element.children]) this.appendChild(child);
      element.children = [];
    } else {
      element.parentNode = this;
      this.children.push(element);
    }
    return element;
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  contains(element) {
    return (
      this === element || this.children.some((child) => child.contains(element))
    );
  }
  closest(selector) {
    const attr = /^\[([^\]]+)\]$/.exec(selector)?.[1];
    if (attr && this.attributes.has(attr)) return this;
    return this.parentNode?.closest(selector) || null;
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.localName === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  focus() {
    this.focused = true;
  }
}

function harness({ kind = "main", category = "paneZenMcp" } = {}) {
  const elements = new Map(
    Array.from(
      markup.matchAll(/<([\w:]+)([^>]*\sid="([^"]+)"[^>]*)>/g),
      (match) => {
        const element = new Element(match[1].replace("html:", ""), match[3]);
        element.hidden = /\shidden="true"/.test(match[2]);
        element.disabled = /\sdisabled="true"/.test(match[2]);
        return [match[3], element];
      },
    ),
  );
  const document = new Element("document");
  document.getElementById = (id) => elements.get(id) || null;
  document.createXULElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element("fragment");
  document.l10n = {
    setAttributes(element, id, args) {
      assert.ok(messages.has(id), `Missing localization: ${id}`);
      element.setAttribute("data-l10n-id", id);
      if (args) element.setAttribute("data-l10n-args", JSON.stringify(args));
      else element.removeAttribute("data-l10n-args");
    },
  };
  const window = new Element("window");
  const denyStorage = new Proxy(
    {},
    {
      get() {
        throw new Error("UI storage is forbidden");
      },
    },
  );
  window.localStorage = denyStorage;
  window.sessionStorage = denyStorage;
  const observers = new Set();
  const status = {
    enabled: false,
    running: false,
    port: kind === "main" ? 3923 : 3924,
    defaultPort: kind === "main" ? 3923 : 3924,
    error: null,
    endpoint: `http://127.0.0.1:${kind === "main" ? 3923 : 3924}/mcp`,
    kind,
    instanceId: "synthetic-instance",
    clients: [],
  };
  const calls = [];
  const clipboard = [];
  const logs = [];
  let grants = 0;
  const notify = (data) => {
    for (const observer of observers)
      observer.observe(null, "zen-mcp-state-changed", JSON.stringify(data));
  };
  const makeGrant = (client) => {
    const token = `synthetic-token-${++grants}`;
    const config = {
      mcpServers: {
        zen: {
          url: status.endpoint,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    };
    return {
      client: structuredClone(client),
      token,
      endpoint: status.endpoint,
      config,
      configText: JSON.stringify(config, null, 2),
    };
  };
  const service = {
    async init() {
      calls.push(["init"]);
    },
    async getStatus() {
      calls.push(["getStatus"]);
      return structuredClone(status);
    },
    async setEnabled(enabled) {
      calls.push(["setEnabled", enabled]);
      status.enabled = status.running = enabled;
      notify({ kind: "server:state" });
    },
    async setPort(port) {
      calls.push(["setPort", port]);
      status.port = port || status.defaultPort;
      status.endpoint = `http://127.0.0.1:${status.port}/mcp`;
      notify({ kind: "server:state" });
    },
    async addClient(name) {
      calls.push(["addClient", name]);
      const client = {
        id: `client-${status.clients.length + 1}`,
        name,
        createdAt: Date.UTC(2026, 9, 9),
        lastUsedAt: null,
      };
      status.clients.push(client);
      notify({ kind: "clients:create", clientId: client.id });
      return makeGrant(client);
    },
    async rotateClient(id) {
      calls.push(["rotateClient", id]);
      const client = status.clients.find((value) => value.id === id);
      assert.ok(client, "Client must exist");
      notify({ kind: "clients:rotate", clientId: id });
      return makeGrant(client);
    },
    async revokeClient(id) {
      calls.push(["revokeClient", id]);
      status.clients = status.clients.filter((client) => client.id !== id);
      notify({ kind: "clients:revoke", clientId: id });
    },
    async connectAgent(agent) {
      calls.push(["connectAgent", agent]);
      return { ...await service.addClient(agent), installedPath: "/synthetic/client-config" };
    },
    async installAgentSkill(agent) {
      calls.push(["installAgentSkill", agent]);
      return { installedPath: "/synthetic/skills/SKILL.md" };
    },
  };
  const context = vm.createContext({
    document,
    window,
    gLastCategory: { category },
    ChromeUtils: {
      importESModule(url) {
        if (url === "resource:///modules/zen/mcp/ZenMcpAgentConfig.sys.mjs") {
          return { agentConnection };
        }
        assert.equal(url, "resource:///modules/zen/mcp/ZenMcpService.sys.mjs");
        return { ZenMcpService: service };
      },
    },
    Services: {
      prefs: denyStorage,
      obs: {
        addObserver(observer, topic) {
          assert.equal(topic, "zen-mcp-state-changed");
          observers.add(observer);
        },
        removeObserver(observer, topic) {
          assert.equal(topic, "zen-mcp-state-changed");
          observers.delete(observer);
        },
      },
    },
    Cc: {
      "@mozilla.org/widget/clipboardhelper;1": {
        getService() {
          return {
            copyString(text) {
              clipboard.push(text);
            },
          };
        },
      },
    },
    Ci: { nsIClipboardHelper: "clipboard-helper" },
    console: {
      log(...args) {
        logs.push(args);
      },
      error(...args) {
        logs.push(args);
      },
      warn(...args) {
        logs.push(args);
      },
    },
  });
  context.gotoPref = async (next) => {
    context.gLastCategory.category = next;
    document.dispatch("paneshown", { detail: { category: next } });
  };
  vm.runInContext(source, context, { filename: "zen-mcp.js" });
  const pane = context.gZenMcpSettings;
  const element = (id) => {
    assert.ok(elements.has(id), `Element ${id} must exist`);
    return elements.get(id);
  };
  const command = async (id) => {
    element(id).dispatch("command");
    await flush();
  };
  const create = async (name = " Synthetic Codex ") => {
    element("zenMcpClientName").value = name;
    await command("zenMcpAddClient");
  };
  const rowButton = (action) =>
    element("zenMcpClientsList")
      .querySelectorAll("button")
      .find(
        (button) => button.getAttribute("data-mcp-client-action") === action,
      );
  const assertCleared = () => {
    assert.equal(pane._grant, null);
    assert.equal(element("zenMcpGrant").hidden, true);
    for (const id of ["zenMcpToken", "zenMcpJsonConfig", "zenMcpCodexConfig", "zenMcpCodexCommand", "zenMcpClaudeCommand"])
      assert.equal(element(id).value, "");
    for (const id of ["zenMcpCopyToken", "zenMcpCopyJson", "zenMcpCopyCodex", "zenMcpCopyCodexCommand", "zenMcpCopyClaudeCommand"])
      assert.equal(element(id).disabled, true);
  };
  return {
    pane,
    document,
    window,
    service,
    status,
    calls,
    clipboard,
    logs,
    observers,
    notify,
    makeGrant,
    element,
    command,
    create,
    rowButton,
    assertCleared,
    context,
  };
}

test("native category, module, include and script package patch apply to Firefox's base", () => {
  const directory = mkdtempSync(join(tmpdir(), "zen-mcp-settings-"));
  try {
    for (const [target, patch] of [
      ["preferences.xhtml", "preferences-xhtml.patch"],
      ["preferences.js", "preferences-js.patch"],
      ["jar.mn", "jar-mn.patch"],
    ]) {
      const path = `browser/components/preferences/${target}`;
      mkdirSync(join(directory, dirname(path)), { recursive: true });
      writeFileSync(
        join(directory, path),
        execFileSync("git", ["show", `HEAD:${path}`], {
          cwd: join(root, "engine"),
        }),
      );
      execFileSync("git", ["apply", "--"], {
        cwd: directory,
        input: readFileSync(join(root, prefRoot, patch)),
      });
    }
    const xhtml = readFileSync(
      join(directory, "browser/components/preferences/preferences.xhtml"),
      "utf8",
    );
    const js = readFileSync(
      join(directory, "browser/components/preferences/preferences.js"),
      "utf8",
    );
    const jar = readFileSync(
      join(directory, "browser/components/preferences/jar.mn"),
      "utf8",
    );
    assert.match(xhtml, /id="category-zen-mcp"[\s\S]*?view="paneZenMcp"/);
    assert.match(xhtml, /#include zenMcp\.inc\.xhtml/);
    assert.match(js, /register_module\("paneZenMcp", gZenMcpSettings\)/);
    assert.match(jar, /content\/browser\/preferences\/zen-mcp\.js/);
    assert.match(
      markup,
      /src="chrome:\/\/browser\/content\/preferences\/zen-mcp\.js"/,
    );
    assert.match(
      readFileSync(join(root, prefRoot, "zen-preferences-links.xhtml"), "utf8"),
      /href="browser\/preferences\/zen-mcp\.ftl"/,
    );
    // The existing Zen registrations remain present after exporting the patch.
    for (const pane of [
      "paneZenLooks",
      "paneZenTabManagement",
      "paneZenCKS",
      "paneZenMarketplace",
    ])
      assert.ok(js.includes(`register_module("${pane}"`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("both locales cover markup, runtime messages, and unrestricted browser JavaScript disclosure", () => {
  const ru = messageIds(locale("ru"));
  assert.deepEqual(ru, messages);
  for (const [, id] of markup.matchAll(/data-l10n-id="([^"]+)"/g))
    assert.ok(messages.has(id), id);
  for (const [, id] of source.matchAll(/"(zen-mcp-[a-z-]+)"/g)) {
    if (id !== "zen-mcp-state-changed") assert.ok(messages.has(id), id);
  }
  assert.match(locale("en-US"), /private browsing data and saved passwords/);
  assert.match(locale("ru"), /данным приватных окон и сохранённым паролям/);
  const ids = Array.from(
    markup.matchAll(/\sid="([^"]+)"/g),
    (match) => match[1],
  );
  assert.equal(
    new Set(ids).size,
    ids.length,
    "Native control IDs must be unique",
  );
  assert.doesNotMatch(markup, /\bpersist=|\bpreference=|on(?:click|command)=/);
  for (const id of ["zenMcpToken", "zenMcpJsonConfig", "zenMcpCodexConfig"]) {
    const tag = new RegExp(`<html:textarea id="${id}"[^>]+>`).exec(markup)?.[0];
    assert.ok(tag);
    assert.match(tag, /autocomplete="off"/);
    assert.match(tag, /readonly="readonly"/);
  }
});

test("opening settings is idempotent, starts disabled, and has no credential side effect", async () => {
  const h = harness();
  await Promise.all([h.pane.init(), h.pane.init()]);
  assert.equal(h.calls.filter(([method]) => method === "init").length, 1);
  assert.equal(h.observers.size, 1);
  assert.equal(h.element("zenMcpEnabled").checked, false);
  assert.equal(h.element("zenMcpEnabled").disabled, false);
  assert.equal(
    h.element("zenMcpStatus").getAttribute("data-l10n-id"),
    "zen-mcp-status-disabled",
  );
  assert.equal(
    h.calls.filter(
      ([method]) => method === "setEnabled" || method === "addClient",
    ).length,
    0,
  );
  h.assertCleared();
  assert.deepEqual(h.clipboard, []);
});

test("enabled state and server failure come from the service; Playground gets its own endpoint", async () => {
  const h = harness({ kind: "playground" });
  await h.pane.init();
  assert.equal(h.element("zenMcpPort").value, "3924");
  assert.equal(h.element("zenMcpEndpoint").value, "http://127.0.0.1:3924/mcp");
  h.element("zenMcpEnabled").checked = true;
  await h.command("zenMcpEnabled");
  assert.ok(
    h.calls.some(
      ([method, value]) => method === "setEnabled" && value === true,
    ),
  );
  assert.equal(
    h.element("zenMcpStatus").getAttribute("data-l10n-id"),
    "zen-mcp-status-running",
  );
  h.status.running = false;
  h.status.error = "The local port is already in use";
  h.notify({ kind: "server:state" });
  await flush();
  assert.equal(
    h.element("zenMcpStatus").getAttribute("data-l10n-id"),
    "zen-mcp-status-stopped",
  );
  assert.equal(h.element("zenMcpServerError").hidden, false);
  assert.equal(
    JSON.parse(h.element("zenMcpServerError").getAttribute("data-l10n-args"))
      .error,
    h.status.error,
  );
  await h.command("zenMcpCopyEndpoint");
  assert.equal(h.clipboard[0], h.status.endpoint);
});

test("port edits survive status refresh and only valid or empty ports reach the service", async () => {
  const h = harness();
  await h.pane.init();
  const input = h.element("zenMcpPort");
  for (const value of ["0", "65536", "-1", "1.5", "1e3", "not-a-port"]) {
    input.value = value;
    input.dispatch("input");
    await h.command("zenMcpApplyPort");
    assert.equal(
      h.element("zenMcpOperationError").getAttribute("data-l10n-id"),
      "zen-mcp-error-port",
    );
  }
  input.value = "";
  input.validity.badInput = true;
  await h.command("zenMcpApplyPort");
  assert.equal(h.calls.filter(([method]) => method === "setPort").length, 0);
  input.validity.badInput = false;
  input.value = "49123";
  input.dispatch("input");
  h.notify({ kind: "clients:create", clientId: "another-client" });
  await flush();
  assert.equal(input.value, "49123");
  await h.command("zenMcpApplyPort");
  assert.equal(h.status.port, 49123);
  input.value = "";
  input.dispatch("input");
  await h.command("zenMcpApplyPort");
  assert.equal(h.status.port, 3923);
  assert.deepEqual(
    h.calls.filter(([method]) => method === "setPort"),
    [
      ["setPort", 49123],
      ["setPort", 0],
    ],
  );
});

test("client creation shows a one-time token and copies exact JSON and Codex TOML", async () => {
  const h = harness({ kind: "playground" });
  await h.pane.init();
  for (const name of ["  ", "x".repeat(101), "client\u0000name"]) {
    await h.create(name);
    assert.equal(
      h.element("zenMcpOperationError").getAttribute("data-l10n-id"),
      "zen-mcp-error-name",
    );
  }
  assert.equal(h.calls.filter(([method]) => method === "addClient").length, 0);
  await h.create();
  assert.equal(h.status.clients[0].name, "Synthetic Codex");
  assert.equal(h.element("zenMcpGrant").hidden, false);
  assert.equal(h.element("zenMcpToken").value, "synthetic-token-1");
  assert.doesNotMatch(JSON.stringify(h.pane._status), /synthetic-token/);
  assert.deepEqual(
    h.clipboard,
    [],
    "Issuing a token must not write the clipboard automatically",
  );
  await h.command("zenMcpCopyJson");
  assert.equal(
    JSON.parse(h.clipboard[0]).mcpServers.zen_playground.headers.Authorization,
    "Bearer synthetic-token-1",
  );
  await h.command("zenMcpCopyCodex");
  assert.equal(
    h.clipboard[1],
    '[mcp_servers.zen_playground]\nurl = "http://127.0.0.1:3924/mcp"\n\n[mcp_servers.zen_playground.http_headers]\nAuthorization = "Bearer synthetic-token-1"\n',
  );
  await h.command("zenMcpCopyToken");
  assert.equal(h.clipboard[2], "synthetic-token-1");
  await h.command("zenMcpDismissGrant");
  h.assertCleared();
  await h.command("zenMcpCopyToken");
  assert.equal(h.clipboard.length, 3);
  assert.deepEqual(h.logs, []);
});

test("agent buttons install separate connections and token-free skills without enabling the server", async () => {
  const h = harness();
  await h.pane.init();
  await h.command("zenMcpConnectCodex");
  assert.equal(h.pane._grant.clientId, h.status.clients[0].id);
  await h.command("zenMcpCopyCodexCommand");
  assert.match(h.clipboard[0], /--bearer-token-env-var ZEN_MCP_TOKEN/);
  await h.command("zenMcpConnectClaude");
  assert.equal(h.status.clients.length, 2);
  assert.equal(h.pane._grant.clientId, h.status.clients[1].id);
  await h.command("zenMcpCopyClaudeCommand");
  assert.match(h.clipboard[1], /claude mcp add --transport http --scope user zen /);
  await h.command("zenMcpInstallCodexSkill");
  await h.command("zenMcpInstallClaudeSkill");
  assert.deepEqual(h.calls.filter(([method]) => method === "installAgentSkill"), [["installAgentSkill", "codex"], ["installAgentSkill", "claude"]]);
  assert.equal(h.status.enabled, false);
  assert.equal(h.element("zenMcpEnabled").checked, false);
  await h.command("zenMcpDismissGrant");
  h.assertCleared();
  assert.deepEqual(h.logs, []);
});

test("leaving and returning during agent installation does not redisplay the one-time token", async () => {
  const h = harness();
  const pending = deferred();
  h.service.connectAgent = () => pending.promise;
  await h.pane.init();
  await h.command("zenMcpConnectCodex");
  h.document.dispatch("paneshown", { detail: { category: "paneGeneral" } });
  h.document.dispatch("paneshown", { detail: { category: "paneZenMcp" } });
  pending.resolve({ ...await h.service.addClient("Codex"), installedPath: "/synthetic/config" });
  await flush();
  h.assertCleared();
});

test("configuration strings escape tokens and the UI never retains extra credential status fields", async () => {
  const h = harness();
  h.service.getStatus = () => ({
    ...structuredClone(h.status),
    token: "unexpected-status-secret",
  });
  const original = h.service.addClient;
  const token = 'synthetic"token\\line\'[injected]';
  h.service.addClient = async (name) => {
    const result = await original(name);
    result.token = token;
    result.config.mcpServers.zen.headers.Authorization = `Bearer ${token}`;
    result.configText = JSON.stringify(result.config, null, 2);
    return result;
  };
  await h.pane.init();
  await h.create();
  assert.doesNotMatch(
    JSON.stringify(h.pane._status),
    /unexpected-status-secret/,
  );
  await h.command("zenMcpCopyCodex");
  const copied = h.clipboard[0];
  assert.equal(
    JSON.parse(/^Authorization = (.+)$/m.exec(copied)[1]),
    `Bearer ${token}`,
  );
  assert.deepEqual(
    copied.split("\n").filter((line) => line.startsWith("[")),
    ["[mcp_servers.zen]", "[mcp_servers.zen.http_headers]"],
  );
  await h.command("zenMcpCopyJson");
  assert.equal(
    JSON.parse(h.clipboard[1]).mcpServers.zen.headers.Authorization,
    `Bearer ${token}`,
  );
  h.notify({});
  h.assertCleared();
});

test("client row actions replace and revoke tokens; external revocation clears all secret fields", async () => {
  const h = harness();
  await h.pane.init();
  await h.create();
  h.rowButton("rotate").dispatch("command");
  await flush();
  assert.equal(h.element("zenMcpToken").value, "synthetic-token-2");
  h.status.clients[0].lastUsedAt = "2026-10-09T03:12:00.000Z";
  await h.command("zenMcpRefresh");
  const metadata = h
    .element("zenMcpClientsList")
    .querySelectorAll("description");
  assert.equal(
    metadata[1].getAttribute("data-l10n-id"),
    "zen-mcp-client-last-used",
  );
  assert.equal(
    JSON.parse(metadata[1].getAttribute("data-l10n-args")).lastUsedAt,
    Date.parse(h.status.clients[0].lastUsedAt),
  );
  h.rowButton("revoke").dispatch("command");
  await flush();
  h.assertCleared();
  assert.equal(h.status.clients.length, 0);
  assert.equal(h.element("zenMcpClientsEmpty").hidden, false);
  await h.create("Another synthetic client");
  h.status.clients = [];
  h.notify({ kind: "clients:revoke", clientId: h.pane._grant.clientId });
  h.assertCleared();
  await flush();
  assert.equal(h.element("zenMcpClientsList").children.length, 0);
});

test("navigation, pagehide, and unload clear grants and prevent late asynchronous grants from returning", async () => {
  for (const event of ["paneshown", "pagehide", "unload"]) {
    const h = harness();
    await h.pane.init();
    await h.create();
    if (event === "paneshown")
      h.document.dispatch(event, { detail: { category: "paneGeneral" } });
    else h.window.dispatch(event);
    h.assertCleared();
    if (event === "unload") {
      assert.equal(h.observers.size, 0);
      assert.equal(h.pane._listeners.length, 0);
    }
  }
  const h = harness();
  await h.pane.init();
  const held = deferred();
  h.service.addClient = async (name) => {
    h.calls.push(["addClient", name]);
    const client = {
      id: "held-client",
      name,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    h.status.clients.push(client);
    await held.promise;
    return h.makeGrant(client);
  };
  h.element("zenMcpClientName").value = "Held client";
  const creation = h.pane._createClient();
  await flush();
  await h.pane._createClient();
  assert.equal(h.calls.filter(([method]) => method === "addClient").length, 1);
  assert.equal(h.element("zenMcpAddClient").disabled, true);
  h.window.dispatch("unload");
  held.resolve();
  await creation;
  h.assertCleared();
  assert.equal(h.observers.size, 0);
});

test("creation from search selects the MCP pane before issuing access", async () => {
  const h = harness({ category: "paneSearchResults" });
  await h.pane.init();
  await h.create();
  assert.equal(h.context.gLastCategory.category, "paneZenMcp");
  assert.equal(h.element("zenMcpToken").value, "synthetic-token-1");
});

test("two immediate creates issue one grant, and a changed endpoint invalidates copied configurations", async () => {
  const h = harness();
  await h.pane.init();
  h.element("zenMcpClientName").value = "Fast client";
  await Promise.all([h.pane._createClient(), h.pane._createClient()]);
  assert.equal(h.calls.filter(([method]) => method === "addClient").length, 1);
  assert.equal(h.element("zenMcpToken").value, "synthetic-token-1");
  h.status.endpoint = "http://127.0.0.1:50123/mcp";
  await h.pane._refresh();
  h.assertCleared();
  assert.equal(h.element("zenMcpEndpoint").value, h.status.endpoint);
});

test("out-of-order status replies cannot replace newer state and refresh does not grow listeners", async () => {
  const h = harness();
  await h.pane.init();
  const older = deferred();
  let reads = 0;
  h.service.getStatus = () =>
    ++reads === 1
      ? older.promise
      : structuredClone({ ...h.status, enabled: true, running: true });
  const previousRefresh = h.pane._refresh();
  await h.pane._refresh();
  older.resolve(structuredClone(h.status));
  await previousRefresh;
  assert.equal(h.element("zenMcpEnabled").checked, true);
  const listeners = h.pane._listeners.length;
  for (let i = 0; i < 100; i++)
    h.notify({ kind: "clients:create", clientId: `synthetic-${i}` });
  await flush();
  assert.equal(h.pane._listeners.length, listeners);
  assert.equal(h.observers.size, 1);
});

test("failed operations are never retried or logged with exception secrets; initialization can recover", async () => {
  const h = harness();
  let attempts = 0;
  h.service.init = async () => {
    if (++attempts === 1) throw new Error("synthetic-secret-in-error");
  };
  await h.pane.init();
  assert.equal(h.element("zenMcpEnabled").disabled, true);
  assert.equal(h.element("zenMcpRefresh").disabled, false);
  assert.equal(
    h.element("zenMcpOperationError").getAttribute("data-l10n-id"),
    "zen-mcp-error-initialize",
  );
  await h.command("zenMcpRefresh");
  assert.equal(h.element("zenMcpEnabled").disabled, false);
  let creations = 0;
  h.service.addClient = async () => {
    ++creations;
    throw new Error("synthetic-secret-in-error");
  };
  await h.create();
  assert.equal(creations, 1);
  assert.equal(
    h.element("zenMcpOperationError").getAttribute("data-l10n-id"),
    "zen-mcp-error-create",
  );
  h.assertCleared();
  assert.doesNotMatch(
    JSON.stringify([...h.element("zenMcpOperationError").attributes]),
    /synthetic-secret-in-error/,
  );
  assert.deepEqual(h.logs, []);
});
