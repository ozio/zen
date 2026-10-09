import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { randomBytes, createHash, randomUUID } from "node:crypto";

let source = await fs.readFile(
  new URL("../../src/zen/mcp/ZenMcpService.sys.mjs", import.meta.url),
  "utf8",
);
source = source.replaceAll(
  /from "(\.\/[^"\n]+)"/g,
  (_, relative) =>
    `from "${new URL(`../../src/zen/mcp/${relative.slice(2)}`, import.meta.url).href}"`,
);

async function fixture() {
  const prefValues = new Map();
  const observers = new Map();
  const files = new Map();
  const events = [];
  const instances = [];
  let occupied = false;
  let uuidCounter = 0;
  const windows = [];
  class Provider {
    constructor() {
      this.cleaned = [];
      instances.push(this);
    }
    getTools() {
      return [];
    }
    cleanup(id) {
      this.cleaned.push(id);
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class HttpServer {
    registerPathHandler(path, fn) {
      this.path = path;
      this.handler = fn;
    }
    _start(port, host) {
      if (occupied) {
        throw new Error("occupied");
      }
      this.port = port;
      this.host = host;
    }
    stop(callback) {
      this.stopped = true;
      callback();
    }
  }
  globalThis.Services = {
    uuid: { generateUUID: () => `{${randomUUID()}}` },
    prefs: {
      getBoolPref: (name, fallback) => prefValues.get(name) ?? fallback,
      getIntPref: (name, fallback) => prefValues.get(name) ?? fallback,
      setBoolPref: (name, value) => {
        prefValues.set(name, value);
      },
      setIntPref: (name, value) => {
        prefValues.set(name, value);
      },
      addObserver: (name, obj) => observers.set(name, obj),
    },
    obs: {
      addObserver() {},
      notifyObservers: (subject, topic, data) => events.push({ topic, data }),
    },
    tm: { dispatchToMainThread: (fn) => queueMicrotask(fn) },
    wm: { getEnumerator: () => windows },
    appinfo: {
      version: "test",
      appBuildID: "build-test",
      sourceURL: "https://example.test/rev/test",
      platformVersion: "test",
      OS: "test",
      XPCOMABI: "test",
    },
  };
  globalThis.PathUtils = {
    profileDir: "/synthetic/profile",
    join: (...parts) => parts.join("/"),
  };
  globalThis.IOUtils = {
    exists: async (path) => files.has(path),
    readJSON: async (path) => structuredClone(files.get(path)),
    writeJSON: async (path, value) => {
      files.set(path, structuredClone(value));
    },
    writeUTF8: async (path, value) => {
      files.set(path, value);
    },
    setPermissions: async () => {},
    stat: async () => ({ size: 0 }),
    remove: async (path) => files.delete(path),
  };
  globalThis.ChromeUtils = {
    defineESModuleGetters(target) {
      Object.assign(target, {
        HttpServer,
        PrivateBrowsingUtils: {
          isWindowPrivate: (win) => win.private === true,
        },
        ZenMcpBrowserTools: Provider,
        ZenMcpPageTools: Provider,
      });
    },
  };
  globalThis.Ci = {
    nsICryptoHash: { SHA256: 4 },
    nsITimer: { TYPE_REPEATING_SLACK: 1 },
  };
  globalThis.Cc = {
    "@mozilla.org/security/random-generator;1": {
      getService: () => ({
        generateRandomBytes: (count) => [...randomBytes(count)],
      }),
    },
    "@mozilla.org/security/hash;1": {
      createInstance: () => {
        const hash = createHash("sha256");
        return {
          init() {},
          update(bytes) {
            hash.update(bytes);
          },
          finish: () => hash.digest("latin1"),
        };
      },
    },
    "@mozilla.org/timer;1": {
      createInstance: () => ({ initWithCallback() {}, cancel() {} }),
    },
  };
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source + `\n// fixture ${randomUUID()}`).toString("base64")}`
  );
  return {
    service: module.ZenMcpService,
    prefValues,
    observers,
    files,
    events,
    instances,
    windows,
    setOccupied: (value) => {
      occupied = value;
    },
  };
}

test("service initializes disabled without creating a listener, tools or grants", async () => {
  const state = await fixture();
  await state.service.init();
  assert.equal(state.service.getStatus().running, false);
  assert.equal(state.service.getStatus().enabled, false);
  assert.equal(state.service.getStatus().port, 3923);
  assert.equal(state.instances.length, 0);
  assert.equal(state.files.size, 0);
  assert.ok(state.observers.has("zen.mcp.enabled"));
});

test("Playground is profile-scoped and starts only on numeric loopback with its own default port", async () => {
  const state = await fixture();
  state.files.set("/synthetic/profile/zen-playground.json", {});
  await state.service.init();
  await state.service.setEnabled(true);
  assert.equal(state.service.kind, "playground");
  assert.equal(state.service.server.host, "127.0.0.1");
  assert.equal(state.service.server.port, 3924);
  const registry = await state.service.addClient("Synthetic test");
  assert.equal(registry.endpoint, "http://127.0.0.1:3924/mcp");
  assert.ok(
    !JSON.stringify(
      state.files.get("/synthetic/profile/zen-mcp-clients.json"),
    ).includes(registry.token),
  );
  await state.service.stop();
});

test("occupied port is reported and changing the port recovers the service without resetting grants", async () => {
  const state = await fixture();
  await state.service.init();
  const grant = await state.service.addClient("Retained client");
  state.setOccupied(true);
  await state.service.setEnabled(true);
  assert.equal(state.service.getStatus().running, false);
  assert.match(state.service.getStatus().error, /occupied/);
  state.setOccupied(false);
  await state.service.setPort(5001);
  assert.equal(state.service.getStatus().running, true);
  assert.equal(state.service.server.port, 5001);
  assert.equal(
    state.service.credentials.authenticate(`Bearer ${grant.token}`).id,
    grant.client.id,
  );
  await state.service.setPort(0);
  assert.equal(state.service.port, 3923);
  await state.service.stop();
});

test("each restart invalidates instance/target IDs, retains grants and closes collectors", async () => {
  const state = await fixture();
  await state.service.init();
  const grant = await state.service.addClient("Retained client");
  await state.service.setEnabled(true);
  const first = state.service.instanceId;
  const provider = state.service.pageTools;
  await state.service.setEnabled(false);
  assert.equal(provider.destroyed, true);
  await state.service.setEnabled(true);
  assert.notEqual(state.service.instanceId, first);
  assert.ok(state.service.credentials.authenticate(`Bearer ${grant.token}`));
  assert.throws(
    () => state.service.assertInstance({ instanceId: first }),
    (error) => error.code === "stale_instance",
  );
  await state.service.revokeClient(grant.client.id);
  assert.ok(state.service.pageTools.cleaned.includes(grant.client.id));
  assert.equal(
    state.service.credentials.authenticate(`Bearer ${grant.token}`),
    null,
  );
  await state.service.stop();
});

test("window enumeration excludes private and unready windows and preserves inactive Space tabs", async () => {
  const state = await fixture();
  await state.service.init();
  const win = {
    gZenStartup: { isReady: true },
    gBrowser: { tabs: ["only-active"] },
    gZenWorkspaces: { allStoredTabs: ["active", "inactive", "discarded"] },
  };
  state.windows.push(
    win,
    { ...win, private: true },
    { ...win, gZenStartup: { isReady: false } },
  );
  assert.deepEqual(state.service.getWindows(), [win]);
  assert.deepEqual(state.service.listTabs(win), [
    "active",
    "inactive",
    "discarded",
  ]);
});

test("audit and change resources never persist page contents, argument values, scripts or tokens", async () => {
  const state = await fixture();
  await state.service.init();
  state.service.audit(
    "tools/call",
    {
      instanceId: "instance-test",
      tabId: "tab-test",
      source: "SECRET SCRIPT",
      token: "SECRET TOKEN",
      text: "SECRET PAGE",
    },
    "ok",
    Date.now(),
  );
  await state.service.flushAudit();
  const audit = state.files.get("/synthetic/profile/zen-mcp-audit.jsonl");
  assert.ok(!audit.includes("SECRET"));
  state.service.notify("browser", {
    tabId: "tab-test",
    text: "SECRET PAGE",
    url: "SECRET URL",
    token: "SECRET TOKEN",
  });
  assert.ok(!JSON.stringify(state.service.events).includes("SECRET"));
});
