// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Transport-independent protocol logic, also exercised by the Node contract tests.
export const MCP_VERSIONS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
];
export const MCP_MODERN_VERSION = MCP_VERSIONS[0];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

export class McpProtocolError extends Error {
  constructor(code, message, status = 400, data) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

export function errorMessage(id, error) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: typeof error.code === "number" ? error.code : -32603,
      message:
        typeof error.code === "number"
          ? error.message
          : "Internal server error",
      ...(error.data === undefined ? {} : { data: error.data }),
    },
  };
}

export function getHeader(headers, name) {
  return headers[name.toLowerCase()] ?? "";
}

export function checkEndpoint(headers, port) {
  if (getHeader(headers, "host") !== `127.0.0.1:${port}`) {
    throw new McpProtocolError(-32600, "Unrecognized Host", 403);
  }
  const origin = getHeader(headers, "origin");
  if (origin && origin !== `http://127.0.0.1:${port}`) {
    throw new McpProtocolError(-32600, "Untrusted Origin", 403);
  }
}

export function parseMessage(text, allowBatch = false) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new McpProtocolError(-32700, "Parse error");
  }
  if (allowBatch && Array.isArray(message)) {
    if (!message.length || message.length > 100) {
      throw new McpProtocolError(-32600, "Invalid JSON-RPC batch");
    }
    message.forEach(validateMessage);
  } else {
    validateMessage(message);
  }
  return message;
}

export function validateMessage(message) {
  if (
    !isObject(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    !message.method.length ||
    (message.id !== undefined &&
      typeof message.id !== "string" &&
      !Number.isSafeInteger(message.id)) ||
    (message.params !== undefined && !isObject(message.params))
  ) {
    throw new McpProtocolError(-32600, "Invalid JSON-RPC request");
  }
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message) {
  throw new McpProtocolError(-32602, message);
}

// The exported tools use only these JSON Schema constructs. Reject rather than
// silently accepting a future construct that this validator cannot enforce.
export function validateSchema(value, schema, path = "arguments") {
  if (schema.anyOf || schema.oneOf) {
    const schemas = schema.anyOf ?? schema.oneOf;
    let matches = 0;
    for (const option of schemas) {
      try {
        validateSchema(value, option, path);
        matches++;
      } catch (error) {
        if (!(error instanceof McpProtocolError)) {
          throw error;
        }
      }
    }
    if (!matches || (schema.oneOf && matches !== 1)) {
      invalid(`${path} has an unsupported value`);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    invalid(`${path} has an unsupported value`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    invalid(`${path} has an unsupported value`);
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (
    schema.type &&
    !types.some((type) => {
      switch (type) {
        case "object":
          return isObject(value);
        case "array":
          return Array.isArray(value);
        case "integer":
          return Number.isSafeInteger(value);
        case "number":
          return typeof value === "number" && Number.isFinite(value);
        case "null":
          return value === null;
        default:
          return typeof value === type;
      }
    })
  ) {
    invalid(`${path} must have type ${types.join(" or ")}`);
  }
  if (isObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) {
        invalid(`${path}.${key} is required`);
      }
    }
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties?.[key];
      if (property) {
        validateSchema(item, property, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        invalid(`${path} contains an unknown property`);
      } else if (isObject(schema.additionalProperties)) {
        validateSchema(item, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      invalid(`${path} contains duplicate items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      invalid(`${path} has too many items`);
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      invalid(`${path} has too few items`);
    }
    if (schema.items) {
      value.forEach((item) => validateSchema(item, schema.items, `${path}[]`));
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      invalid(`${path} is too short`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      invalid(`${path} is too long`);
    }
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
      invalid(`${path} has an invalid format`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      invalid(`${path} is below the minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      invalid(`${path} exceeds the maximum`);
    }
  }
}

export function decodeHeader(value) {
  if (!value || /[^\x20-\x7e\t]/.test(value)) {
    throw new McpProtocolError(-32020, "Malformed MCP header");
  }
  if (value.startsWith("=?base64?") && value.endsWith("?=")) {
    try {
      const raw = atob(value.slice(9, -2));
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      );
    } catch {
      throw new McpProtocolError(-32020, "Malformed MCP header encoding");
    }
  }
  return value;
}

export function modernHeaders(message, headers) {
  const meta = message.params?._meta;
  if (getHeader(headers, "mcp-protocol-version") !== meta?.[META_VERSION]) {
    throw new McpProtocolError(-32020, "MCP protocol header mismatch");
  }
  if (getHeader(headers, "mcp-method") !== message.method) {
    throw new McpProtocolError(-32020, "MCP method header mismatch");
  }
  const name = {
    "tools/call": message.params?.name,
    "resources/read": message.params?.uri,
    "prompts/get": message.params?.name,
  }[message.method];
  if (
    name !== undefined &&
    decodeHeader(getHeader(headers, "mcp-name")) !== name
  ) {
    throw new McpProtocolError(-32020, "MCP name header mismatch");
  }
  if (
    !isObject(meta?.[META_CLIENT]) ||
    typeof meta[META_CLIENT].name !== "string" ||
    typeof meta[META_CLIENT].version !== "string" ||
    !isObject(meta?.[META_CAPABILITIES])
  ) {
    invalid("Required client metadata is missing");
  }
}

export class ZenMcpProtocol {
  constructor(service, { id, now = () => Date.now() } = {}) {
    this.service = service;
    this.id = id;
    this.now = now;
    this.sessions = new Map();
    this.pending = new Map();
    this.streams = new Set();
    this.mutations = Promise.resolve();
  }

  get serverInfo() {
    return this.service.serverInfo;
  }

  capabilities(modern) {
    return {
      tools: { listChanged: true },
      resources: modern ? {} : { subscribe: true, listChanged: true },
    };
  }

  resolve(message, headers, client) {
    const requested = message.params?._meta?.[META_VERSION];
    const headerVersion = getHeader(headers, "mcp-protocol-version");
    if (requested || headerVersion === MCP_MODERN_VERSION) {
      if (!MCP_VERSIONS.includes(requested)) {
        throw new McpProtocolError(
          -32022,
          "Unsupported protocol version",
          400,
          {
            supported: MCP_VERSIONS,
            requested: requested ?? headerVersion,
          },
        );
      }
      if (requested === MCP_MODERN_VERSION) {
        modernHeaders(message, headers);
        return { version: requested, modern: true, client };
      }
      invalid("Legacy versions require initialize");
    }
    if (message.method === "initialize") {
      const version = message.params?.protocolVersion;
      if (
        typeof version !== "string" ||
        !isObject(message.params?.clientInfo)
      ) {
        invalid("Invalid initialize parameters");
      }
      const selected = MCP_VERSIONS.slice(1).includes(version)
        ? version
        : MCP_VERSIONS[1];
      if (this.sessions.size >= 128) {
        throw new McpProtocolError(-32000, "Too many sessions", 429);
      }
      const session = {
        id: this.id(),
        version: selected,
        clientId: client.id,
        initialized: false,
        resources: new Set(),
        lastUsed: this.now(),
      };
      this.sessions.set(session.id, session);
      return { version: selected, modern: false, client, session };
    }
    const session = this.sessions.get(getHeader(headers, "mcp-session-id"));
    if (!session || session.clientId !== client.id) {
      throw new McpProtocolError(-32000, "Session is missing or expired", 404);
    }
    if (headerVersion && headerVersion !== session.version) {
      throw new McpProtocolError(-32600, "Session protocol version mismatch");
    }
    session.lastUsed = this.now();
    return { version: session.version, modern: false, client, session };
  }

  complete(result, context) {
    return context.modern
      ? {
          ...result,
          resultType: "complete",
          _meta: { ...result._meta, [META_SERVER]: this.serverInfo },
        }
      : result;
  }

  async handle(message, headers, client, signal) {
    validateMessage(message);
    const context = this.resolve(message, headers, client);
    const { method, params = {}, id } = message;
    if (method === "initialize") {
      return {
        sessionId: context.session.id,
        body: {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: context.version,
            capabilities: this.capabilities(false),
            serverInfo: this.serverInfo,
            instructions: this.service.instructions,
          },
        },
      };
    }
    if (method === "notifications/initialized" && !context.modern) {
      context.session.initialized = true;
      return { status: 202 };
    }
    if (method === "notifications/cancelled" && !context.modern) {
      this.pending.get(`${client.id}:${params.requestId}`)?.abort();
      return { status: 202 };
    }
    if (id === undefined) {
      // Notifications never trigger a tool or other side effect.
      return { status: 202 };
    }
    if (!context.modern && !context.session.initialized && method !== "ping") {
      throw new McpProtocolError(-32000, "Session is not initialized");
    }
    let result;
    switch (method) {
      case "server/discover":
        if (!context.modern) {
          throw new McpProtocolError(-32601, "Method not found", 404);
        }
        result = {
          supportedVersions: MCP_VERSIONS,
          capabilities: this.capabilities(true),
          instructions: this.service.instructions,
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = this.list(this.service.tools, "tools", params);
        break;
      case "tools/call":
        result = await this.call(params, context, id, signal);
        break;
      case "resources/list":
        result = this.list(this.service.resources(client), "resources", params);
        break;
      case "resources/templates/list":
        result = { resourceTemplates: this.service.resourceTemplates };
        break;
      case "resources/read":
        if (typeof params.uri !== "string") {
          invalid("uri is required");
        }
        result = {
          contents: await this.service.readResource(params.uri, client),
        };
        break;
      case "resources/subscribe":
      case "resources/unsubscribe":
        if (context.modern) {
          throw new McpProtocolError(-32601, "Use subscriptions/listen", 404);
        }
        this.service.assertResource(params.uri, client);
        if (method === "resources/subscribe") {
          context.session.resources.add(params.uri);
        } else {
          context.session.resources.delete(params.uri);
        }
        result = {};
        break;
      case "subscriptions/listen": {
        if (!context.modern) {
          throw new McpProtocolError(-32601, "Use resources/subscribe", 404);
        }
        const requested = params.notifications;
        if (!isObject(requested)) {
          invalid("notifications is required");
        }
        const filter = {};
        for (const key of ["toolsListChanged", "resourcesListChanged"]) {
          if (
            requested[key] !== undefined &&
            typeof requested[key] !== "boolean"
          ) {
            invalid(`${key} must be a boolean`);
          }
          if (requested[key]) {
            filter[key] = true;
          }
        }
        if (requested.resourceSubscriptions !== undefined) {
          if (
            !Array.isArray(requested.resourceSubscriptions) ||
            requested.resourceSubscriptions.length > 100
          ) {
            invalid("Invalid resourceSubscriptions");
          }
          for (const uri of requested.resourceSubscriptions) {
            this.service.assertResource(uri, client);
          }
          filter.resourceSubscriptions = [
            ...new Set(requested.resourceSubscriptions),
          ];
        }
        return { stream: { context, id, filter } };
      }
      default:
        throw new McpProtocolError(-32601, "Method not found", 404);
    }
    return {
      body: { jsonrpc: "2.0", id, result: this.complete(result, context) },
    };
  }

  list(items, key, params) {
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (params.cursor !== undefined && String(offset) !== params.cursor)
    ) {
      invalid("Invalid cursor");
    }
    const end = offset + 100;
    return {
      [key]: items.slice(offset, end),
      ...(end < items.length ? { nextCursor: String(end) } : {}),
    };
  }

  async call(params, context, id, signal) {
    const tool = this.service.tools.find((item) => item.name === params.name);
    if (!tool) {
      invalid("Unknown tool");
    }
    const args = params.arguments ?? {};
    validateSchema(args, tool.inputSchema);
    const key = `${context.client.id}:${id}`;
    if (this.pending.has(key)) {
      invalid("Request ID is already in use for this client");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    this.pending.set(key, controller);
    const invoke = async () => {
      if (
        controller.signal.aborted ||
        !this.service.hasClient(context.client.id)
      ) {
        throw new McpProtocolError(-32800, "Request cancelled");
      }
      try {
        this.service.assertInstance(args, tool.name);
        const value = await this.service.executeTool(
          tool.name,
          args,
          context.client,
          controller.signal,
        );
        if (value?.__mcpResult) {
          const { content, structuredContent, isError } = value;
          return {
            content,
            ...(structuredContent
              ? {
                  structuredContent: {
                    instanceId: this.service.instanceId,
                    ...structuredContent,
                  },
                }
              : {}),
            ...(isError ? { isError } : {}),
          };
        }
        const data = { instanceId: this.service.instanceId, ...value };
        return {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        };
      } catch (error) {
        if (error instanceof McpProtocolError) {
          throw error;
        }
        // Provider error messages are returned to the authenticated requester,
        // but are never copied to the audit log.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: error.code ?? "operation_failed",
                message: error.code
                  ? error.message
                  : "Browser operation failed",
              }),
            },
          ],
          structuredContent: {
            instanceId: this.service.instanceId,
            error: {
              code: error.code ?? "operation_failed",
              message: error.code ? error.message : "Browser operation failed",
            },
          },
        };
      }
    };
    try {
      if (tool.annotations?.readOnlyHint) {
        return await invoke();
      }
      const operation = this.mutations.then(invoke, invoke);
      // Serialize all mutations conservatively, including cross-window changes.
      this.mutations = operation.catch(() => {});
      return await operation;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.pending.delete(key);
    }
  }

  openStream(spec, write, close) {
    if (
      [...this.streams].filter(
        (item) => item.context.client.id === spec.context.client.id,
      ).length >= 8
    ) {
      throw new McpProtocolError(-32000, "Too many subscription streams", 429);
    }
    const stream = { ...spec, write, close };
    this.streams.add(stream);
    if (spec.context.modern) {
      write({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: { [META_SUBSCRIPTION]: spec.id },
          notifications: spec.filter,
        },
      });
    }
    return stream;
  }

  removeStream(stream, graceful = false) {
    if (!this.streams.delete(stream)) {
      return;
    }
    if (graceful && stream.context.modern) {
      try {
        stream.write({
          jsonrpc: "2.0",
          id: stream.id,
          result: {
            resultType: "complete",
            _meta: { [META_SUBSCRIPTION]: stream.id },
          },
        });
      } catch {}
    }
    stream.close();
    if (
      ![...this.streams].some(
        (item) => item.context.client.id === stream.context.client.id,
      )
    ) {
      this.service.cleanup(stream.context.client.id);
    }
  }

  notify(method, params = {}) {
    const deliveredLegacy = new Set();
    for (const stream of [...this.streams]) {
      const { context, filter } = stream;
      if (context.modern) {
        const key = {
          "notifications/tools/list_changed": "toolsListChanged",
          "notifications/resources/list_changed": "resourcesListChanged",
        }[method];
        if (
          key
            ? !filter[key]
            : method !== "notifications/resources/updated" ||
              !filter.resourceSubscriptions?.includes(params.uri)
        ) {
          continue;
        }
      } else if (
        method === "notifications/resources/updated" &&
        !context.session.resources.has(params.uri)
      ) {
        continue;
      } else if (deliveredLegacy.has(context.client.id)) {
        continue;
      }
      try {
        stream.write({
          jsonrpc: "2.0",
          method,
          params: context.modern
            ? {
                ...params,
                _meta: { [META_SUBSCRIPTION]: stream.id },
              }
            : params,
        });
        if (!context.modern) {
          deliveredLegacy.add(context.client.id);
        }
      } catch {
        this.removeStream(stream);
      }
    }
  }

  session(headers, client) {
    const session = this.sessions.get(getHeader(headers, "mcp-session-id"));
    if (!session || session.clientId !== client.id) {
      throw new McpProtocolError(-32000, "Session is missing or expired", 404);
    }
    const version = getHeader(headers, "mcp-protocol-version");
    if (version && version !== session.version) {
      throw new McpProtocolError(-32600, "Session protocol version mismatch");
    }
    return { session, client, version: session.version, modern: false };
  }

  deleteSession(headers, client) {
    const context = this.session(headers, client);
    this.sessions.delete(context.session.id);
    for (const stream of [...this.streams]) {
      if (stream.context.session === context.session) {
        this.removeStream(stream, true);
      }
    }
    this.maybeCleanup(client.id);
  }

  async handleBatch(messages, headers, client, signal) {
    const context = this.session(headers, client);
    if (context.version !== "2025-03-26") {
      throw new McpProtocolError(
        -32600,
        "Batches are only supported in 2025-03-26",
      );
    }
    const body = [];
    for (const message of messages) {
      try {
        const result = await this.handle(message, headers, client, signal);
        if (result.body) {
          body.push(result.body);
        }
      } catch (error) {
        if (message.id !== undefined) {
          body.push(errorMessage(message.id, error));
        }
      }
    }
    return body.length ? { batch: body } : { status: 202 };
  }

  maybeCleanup(clientId) {
    if (
      ![...this.streams].some((item) => item.context.client.id === clientId) &&
      ![...this.sessions.values()].some((item) => item.clientId === clientId)
    ) {
      this.service.cleanup(clientId);
    }
  }

  disconnect(clientId) {
    for (const [key, controller] of this.pending) {
      if (key.startsWith(`${clientId}:`)) {
        controller.abort();
      }
    }
    for (const stream of [...this.streams]) {
      if (stream.context.client.id === clientId) {
        this.removeStream(stream, true);
      }
    }
    for (const [id, session] of this.sessions) {
      if (session.clientId === clientId) {
        this.sessions.delete(id);
      }
    }
    this.service.cleanup(clientId);
  }

  pruneSessions() {
    const cutoff = this.now() - 30 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (
        session.lastUsed < cutoff &&
        ![...this.streams].some((item) => item.context.session === session)
      ) {
        this.sessions.delete(id);
        this.maybeCleanup(session.clientId);
      }
    }
  }

  destroy() {
    const ids = new Set([
      ...[...this.sessions.values()].map((item) => item.clientId),
      ...[...this.streams].map((item) => item.context.client.id),
      ...this.service.clientIds(),
    ]);
    for (const id of ids) {
      this.disconnect(id);
    }
  }
}
