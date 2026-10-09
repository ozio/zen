import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  ZenMcpProtocol,
  MCP_VERSIONS,
  McpProtocolError,
  checkEndpoint,
  decodeHeader,
  parseMessage,
  validateSchema,
} from "../../src/zen/mcp/ZenMcpProtocol.sys.mjs";
import { ZenMcpCredentials } from "../../src/zen/mcp/ZenMcpCredentials.sys.mjs";
import {
  SnapshotStore,
  makeTool,
  McpToolError,
  paginate,
} from "../../src/zen/mcp/ZenMcpUtils.sys.mjs";

const client = { id: "client-a", name: "Synthetic client" };
const other = { id: "client-b", name: "Other client" };
const meta = {
  "io.modelcontextprotocol/protocolVersion": MCP_VERSIONS[0],
  "io.modelcontextprotocol/clientInfo": {
    name: "Contract tests",
    version: "1",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};
function modern(method, params = {}, id = 1) {
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: meta },
  };
  const headers = {
    "mcp-protocol-version": MCP_VERSIONS[0],
    "mcp-method": method,
  };
  if (method === "tools/call") {
    headers["mcp-name"] = params.name;
  }
  if (method === "resources/read") {
    headers["mcp-name"] = params.uri;
  }
  return [message, headers];
}
function fixture(
  executeTool = async (name, args) => ({ name, value: args.value }),
) {
  const cleanup = [];
  const service = {
    instanceId: "instance-test",
    serverInfo: { name: "Zen", version: "test" },
    instructions: "test",
    tools: [
      makeTool("zen_browser_state", "state", {}, [], { readOnly: true }),
      makeTool("zen_change", "change", { value: { type: "integer" } }, [
        "value",
      ]),
      makeTool("zen_read", "read", {}, [], { readOnly: true }),
    ],
    resources: () => [{ uri: "zen://instance-test/state", name: "state" }],
    resourceTemplates: [],
    assertResource: (uri) => {
      if (uri !== "zen://instance-test/state") {
        throw new McpProtocolError(-32002, "Resource not found", 404);
      }
    },
    readResource: async (uri) => [{ uri, text: "{}" }],
    assertInstance: (args, name) => {
      if (
        name !== "zen_browser_state" &&
        args.instanceId !== service.instanceId
      ) {
        throw new McpToolError("stale_instance", "Instance changed");
      }
    },
    hasClient: (id) => [client.id, other.id].includes(id),
    clientIds: () => [client.id, other.id],
    executeTool,
    cleanup: (id) => cleanup.push(id),
  };
  return {
    service,
    cleanup,
    protocol: new ZenMcpProtocol(service, { id: randomUUID }),
  };
}
async function legacy(protocol, version, owner = client) {
  const initialized = await protocol.handle(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    {},
    owner,
  );
  const headers = {
    "mcp-session-id": initialized.sessionId,
    "mcp-protocol-version": version,
  };
  await protocol.handle(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    headers,
    owner,
  );
  return { initialized, headers };
}

test("HTTP boundary accepts only the configured numeric loopback authority and trusted origin", () => {
  checkEndpoint({ host: "127.0.0.1:3923" }, 3923);
  checkEndpoint(
    { host: "127.0.0.1:3923", origin: "http://127.0.0.1:3923" },
    3923,
  );
  for (const headers of [
    { host: "evil.test:3923" },
    { host: "localhost:3923" },
    { host: "127.0.0.1:3924" },
    { host: "127.0.0.1:3923", origin: "null" },
    { host: "127.0.0.1:3923", origin: "https://evil.test" },
  ]) {
    assert.throws(
      () => checkEndpoint(headers, 3923),
      (error) => error.status === 403,
    );
  }
});

test("invalid JSON, responses, empty batches and malformed IDs are rejected", () => {
  assert.throws(
    () => parseMessage("{"),
    (error) => error.code === -32700,
  );
  for (const data of [
    [],
    {},
    { jsonrpc: "2.0", id: null, method: "ping" },
    { jsonrpc: "2.0", id: 1, result: {} },
  ]) {
    assert.throws(
      () => parseMessage(JSON.stringify(data)),
      (error) => error.code === -32600,
    );
  }
  assert.throws(() => parseMessage("[]", true));
});

test("modern discovery is stateless and declares all supported revisions", async () => {
  const { protocol } = fixture();
  const [message, headers] = modern("server/discover");
  const result = await protocol.handle(message, headers, client);
  assert.deepEqual(result.body.result.supportedVersions, MCP_VERSIONS);
  assert.equal(result.body.result.resultType, "complete");
  assert.equal(
    result.body.result._meta["io.modelcontextprotocol/serverInfo"].name,
    "Zen",
  );
  assert.equal(result.sessionId, undefined);
  assert.equal(protocol.sessions.size, 0);
});

for (const version of MCP_VERSIONS.slice(1)) {
  test(`legacy ${version} initializes, lists, reads resources and terminates its own session`, async () => {
    const { protocol, cleanup } = fixture();
    const { initialized, headers } = await legacy(protocol, version);
    assert.equal(initialized.body.result.protocolVersion, version);
    assert.equal(initialized.body.result.resultType, undefined);
    const request = (method, params = {}) =>
      protocol.handle(
        { jsonrpc: "2.0", id: 2, method, params },
        headers,
        client,
      );
    assert.equal((await request("tools/list")).body.result.tools.length, 3);
    assert.equal(
      (await request("resources/list")).body.result.resources.length,
      1,
    );
    assert.equal(
      (await request("resources/read", { uri: "zen://instance-test/state" }))
        .body.result.contents[0].text,
      "{}",
    );
    assert.throws(
      () => protocol.deleteSession(headers, other),
      (error) => error.status === 404,
    );
    protocol.deleteSession(headers, client);
    assert.ok(cleanup.includes(client.id));
    await assert.rejects(request("ping"), (error) => error.status === 404);
  });
}

test("modern header/body mismatch and missing metadata produce precise protocol errors", async () => {
  const { protocol } = fixture();
  const [message, headers] = modern("tools/call", {
    name: "zen_browser_state",
  });
  for (const changed of [
    { ...headers, "mcp-method": "resources/list" },
    { ...headers, "mcp-name": "zen_read" },
    { ...headers, "mcp-protocol-version": "2025-11-25" },
  ]) {
    await assert.rejects(
      protocol.handle(message, changed, client),
      (error) => error.code === -32020 && error.status === 400,
    );
  }
  const noMeta = { ...message, params: { name: "zen_browser_state" } };
  await assert.rejects(
    protocol.handle(noMeta, headers, client),
    (error) => error.code === -32022,
  );
  const unsupported = {
    ...message,
    params: {
      ...message.params,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      },
    },
  };
  await assert.rejects(
    protocol.handle(unsupported, headers, client),
    (error) => error.code === -32022 && error.data.supported.length === 4,
  );
});

test("encoded MCP headers decode UTF-8 and preserve sentinel literals", () => {
  for (const value of ["日本語", " padded ", "=?base64?literal?="]) {
    assert.equal(
      decodeHeader(`=?base64?${Buffer.from(value).toString("base64")}?=`),
      value,
    );
  }
  assert.throws(
    () => decodeHeader("=?base64?!!!?="),
    (error) => error.code === -32020,
  );
});

test("tool arguments enforce types, bounds, required fields and unknown property rejection", async () => {
  const { protocol } = fixture();
  for (const args of [
    { value: 2 },
    { instanceId: "instance-test", value: "2" },
    { instanceId: "instance-test", value: 2, token: "not accepted" },
  ]) {
    const [message, headers] = modern("tools/call", {
      name: "zen_change",
      arguments: args,
    });
    await assert.rejects(
      protocol.handle(message, headers, client),
      (error) => error.code === -32602,
    );
  }
  const [message, headers] = modern("tools/call", {
    name: "zen_change",
    arguments: { instanceId: "old-instance", value: 2 },
  });
  const result = await protocol.handle(message, headers, client);
  assert.equal(result.body.result.isError, true);
  assert.equal(
    result.body.result.structuredContent.error.code,
    "stale_instance",
  );
  validateSchema(
    result.body.result.structuredContent,
    fixture().service.tools[1].outputSchema,
  );
});

test("schema validator rejects duplicate IDs and constrains structured preference types", () => {
  assert.throws(() =>
    validateSchema(["tab-a", "tab-a"], { type: "array", uniqueItems: true }),
  );
  assert.throws(() =>
    validateSchema(0.5, { type: ["boolean", "integer", "string"] }),
  );
  validateSchema("ok", { type: ["boolean", "integer", "string"] });
});

test("two clients serialize mutations of a shared target while reads proceed independently", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { protocol } = fixture(async (name, args) => {
    if (name === "zen_read") {
      order.push("read");
      return { read: true };
    }
    order.push(`start:${args.value}`);
    if (args.value === 1) {
      await gate;
    }
    order.push(`end:${args.value}`);
    return { value: args.value };
  });
  const invoke = (value, owner, id) => {
    const [message, headers] = modern(
      "tools/call",
      { name: "zen_change", arguments: { instanceId: "instance-test", value } },
      id,
    );
    return protocol.handle(message, headers, owner);
  };
  const first = invoke(1, client, 10);
  const second = invoke(2, other, 11);
  const [read, headers] = modern(
    "tools/call",
    { name: "zen_read", arguments: { instanceId: "instance-test" } },
    12,
  );
  await protocol.handle(read, headers, other);
  assert.ok(order.includes("read"));
  assert.ok(!order.includes("start:2"));
  release();
  await Promise.all([first, second]);
  assert.ok(order.indexOf("end:1") < order.indexOf("start:2"));
});

test("revoked client queued mutation is cancelled before browser dispatch", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const seen = [];
  const { protocol } = fixture(async (name, args) => {
    seen.push(args.value);
    if (args.value === 1) {
      await gate;
    }
    return {};
  });
  const invoke = (value, owner, id) => {
    const [message, headers] = modern(
      "tools/call",
      { name: "zen_change", arguments: { instanceId: "instance-test", value } },
      id,
    );
    return protocol.handle(message, headers, owner);
  };
  const first = invoke(1, client, 20);
  const second = invoke(2, other, 21);
  protocol.disconnect(other.id);
  const rejected = assert.rejects(second, (error) => error.code === -32800);
  release();
  await Promise.all([first, rejected]);
  assert.deepEqual(seen, [1]);
});

test("modern subscription acknowledges first, filters notifications and closes gracefully", async () => {
  const { protocol, cleanup } = fixture();
  const [message, headers] = modern(
    "subscriptions/listen",
    {
      notifications: {
        resourceSubscriptions: ["zen://instance-test/state"],
        toolsListChanged: true,
      },
    },
    "subscription-a",
  );
  const result = await protocol.handle(message, headers, client);
  const messages = [];
  let closed = false;
  const stream = protocol.openStream(
    result.stream,
    (value) => messages.push(value),
    () => {
      closed = true;
    },
  );
  protocol.notify("notifications/resources/list_changed");
  protocol.notify("notifications/resources/updated", {
    uri: "zen://instance-test/other",
  });
  protocol.notify("notifications/resources/updated", {
    uri: "zen://instance-test/state",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].method, "notifications/subscriptions/acknowledged");
  assert.equal(
    messages[1].params._meta["io.modelcontextprotocol/subscriptionId"],
    "subscription-a",
  );
  protocol.disconnect(client.id);
  assert.equal(closed, true);
  assert.equal(messages.at(-1).result.resultType, "complete");
  assert.equal(protocol.streams.size, 0);
  assert.ok(cleanup.includes(client.id));
});

test("legacy resource notifications are delivered once across simultaneous SSE streams", async () => {
  const { protocol } = fixture();
  const { headers } = await legacy(protocol, "2025-03-26");
  await protocol.handle(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/subscribe",
      params: { uri: "zen://instance-test/state" },
    },
    headers,
    client,
  );
  const received = [];
  const context = protocol.session(headers, client);
  protocol.openStream(
    { context, filter: {} },
    (value) => received.push(value),
    () => {},
  );
  protocol.openStream(
    { context, filter: {} },
    (value) => received.push(value),
    () => {},
  );
  protocol.notify("notifications/resources/updated", {
    uri: "zen://instance-test/state",
  });
  assert.equal(received.length, 1);
  protocol.destroy();
});

test("03-26 batch requests execute once; newer revisions reject batching", async () => {
  const { protocol } = fixture();
  const { headers } = await legacy(protocol, "2025-03-26");
  const batch = parseMessage(
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
    true,
  );
  assert.equal(
    (await protocol.handleBatch(batch, headers, client)).batch.length,
    2,
  );
  const newer = await legacy(protocol, "2025-06-18");
  await assert.rejects(
    protocol.handleBatch(batch, newer.headers, client),
    (error) => error.code === -32600,
  );
});

test("1500-item pagination returns all items in 100-item pages without evaluating item properties", () => {
  const items = Array.from({ length: 1500 }, (_, i) => ({
    id: `tab-${i}`,
    get linkedBrowser() {
      throw new Error("lazy browser awakened");
    },
  }));
  let cursor;
  const seen = [];
  do {
    const result = paginate(items, { cursor });
    assert.equal(result.total, 1500);
    seen.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  assert.equal(new Set(seen).size, 1500);
});

test("handles enforce client/target/document ownership, consume once and expire after 30 seconds", () => {
  let now = 0;
  const store = new SnapshotStore({ now: () => now, id: randomUUID });
  const id = store.create(client.id, "tab-a", "document-a", {
    target: "button",
  });
  assert.throws(() => store.take(id, other.id, "tab-a", "document-a"));
  assert.equal(
    store.take(id, client.id, "tab-a", "document-a").target,
    "button",
  );
  assert.throws(() => store.take(id, client.id, "tab-a", "document-a"));
  const stale = store.create(client.id, "tab-a", "document-a", {});
  assert.throws(() => store.take(stale, client.id, "tab-a", "document-b"));
  const expired = store.create(client.id, "tab-a", "document-a", {});
  now = 30001;
  assert.throws(() => store.take(expired, client.id, "tab-a", "document-a"));
});

function credentialsFixture() {
  let persisted;
  const revoked = [];
  const options = {
    read: async () => persisted,
    write: async (data) => {
      persisted = structuredClone(data);
    },
    hash: (value) => createHash("sha256").update(value).digest("hex"),
    random: () => randomBytes(32).toString("hex"),
    id: randomUUID,
    revoked: (id) => revoked.push(id),
  };
  return {
    credentials: new ZenMcpCredentials(options),
    options,
    get persisted() {
      return persisted;
    },
    revoked,
  };
}

test("profile registry persists only hashes, restores grants and rotation/revocation are immediate", async () => {
  const state = credentialsFixture();
  const grant = await state.credentials.add(" Synthetic client ");
  assert.equal(grant.client.name, "Synthetic client");
  assert.equal(grant.token.length, 64);
  assert.ok(!JSON.stringify(state.persisted).includes(grant.token));
  assert.equal(
    state.credentials.authenticate(`Bearer ${grant.token}`).id,
    grant.client.id,
  );
  const restarted = new ZenMcpCredentials(state.options);
  await restarted.load();
  assert.equal(
    restarted.authenticate(`Bearer ${grant.token}`).id,
    grant.client.id,
  );
  assert.equal(restarted.list()[0].hash, undefined);
  const rotated = await restarted.rotate(grant.client.id);
  assert.equal(restarted.authenticate(`Bearer ${grant.token}`), null);
  assert.ok(restarted.authenticate(`Bearer ${rotated.token}`));
  assert.deepEqual(state.revoked, [grant.client.id]);
  await restarted.revoke(grant.client.id);
  assert.equal(restarted.authenticate(`Bearer ${rotated.token}`), null);
  assert.equal(state.persisted.clients.length, 0);
});

test("separate profile registries never accept each other's credentials", async () => {
  const main = credentialsFixture();
  const playground = credentialsFixture();
  const grant = await main.credentials.add("Main");
  assert.equal(
    playground.credentials.authenticate(`Bearer ${grant.token}`),
    null,
  );
  assert.equal(main.credentials.authenticate(`Basic ${grant.token}`), null);
  assert.equal(main.credentials.authenticate("Bearer invalid"), null);
});

test("client creation is serialized, duplicate names rejected and failed persistence leaves no grant", async () => {
  const state = credentialsFixture();
  const first = state.credentials.add("same");
  const second = assert.rejects(
    state.credentials.add("same"),
    (error) => error.code === "duplicate_name",
  );
  await Promise.all([first, second]);
  state.credentials.write = async () => {
    throw new Error("disk error");
  };
  await assert.rejects(state.credentials.add("failed"));
  assert.equal(state.credentials.list().length, 1);
});

test("modern cacheable responses declare private zero TTL while legacy wire results stay unchanged", async () => {
  const { protocol } = fixture();
  for (const method of ["server/discover", "tools/list", "resources/list", "resources/templates/list", "resources/read"]) {
    const params = method === "resources/read" ? { uri: "zen://instance-test/state" } : {};
    const [request, headers] = modern(method, params);
    const response = await protocol.handle(request, headers, client);
    assert.equal(response.body.result.ttlMs, 0);
    assert.equal(response.body.result.cacheScope, "private");
  }
  const { headers } = await legacy(protocol, "2025-11-25");
  const response = await protocol.handle({ jsonrpc: "2.0", id: 10, method: "tools/list" }, headers, client);
  assert.equal("ttlMs" in response.body.result, false);
  assert.equal("cacheScope" in response.body.result, false);
});
