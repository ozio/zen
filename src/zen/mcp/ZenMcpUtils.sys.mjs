// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

export class McpToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export const schema = {
  string: { type: "string" },
  boolean: { type: "boolean" },
  integer: { type: "integer" },
  number: { type: "number" },
  object: { type: "object" },
  strings: { type: "array", items: { type: "string" } },
  enum: (...values) => ({ type: "string", enum: values }),
};

export function makeTool(
  name,
  description,
  properties = {},
  required = [],
  options = {}
) {
  const identity =
    name === "zen_browser_state" ? {} : { instanceId: schema.string };
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...identity, ...properties },
      required: [
        ...(name === "zen_browser_state" ? [] : ["instanceId"]),
        ...required,
      ],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      description:
        "Observed browser result with the current instance identity; tool failures include an error object.",
      ...options.outputSchema,
      properties: {
        instanceId: {
          type: "string",
          description: "Identity of the running server epoch",
        },
        error: {
          type: "object",
          properties: { code: schema.string, message: schema.string },
          required: ["code", "message"],
        },
        ...options.outputSchema?.properties,
      },
      required: ["instanceId", ...(options.outputSchema?.required ?? [])],
    },
    annotations: {
      readOnlyHint: options.readOnly === true,
      destructiveHint: options.readOnly !== true,
      idempotentHint: options.readOnly === true,
      openWorldHint: options.openWorld !== false,
    },
  };
}

export function requireValue(condition, code, message) {
  if (!condition) {
    throw new McpToolError(code, message);
  }
}

export function paginate(items, { cursor, limit = 100 } = {}) {
  requireValue(
    Number.isInteger(limit) && limit > 0 && limit <= 500,
    "invalid_limit",
    "limit must be an integer from 1 to 500"
  );
  const offset = cursor === undefined ? 0 : Number(cursor);
  requireValue(
    Number.isSafeInteger(offset) &&
      offset >= 0 &&
      (cursor === undefined || String(offset) === cursor),
    "invalid_cursor",
    "cursor must come from a previous list result"
  );
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    ...(offset + limit < items.length
      ? { nextCursor: String(offset + limit) }
      : {}),
  };
}

export function uuid() {
  return Services.uuid.generateUUID().toString().slice(1, -1);
}

/** Client/document-scoped, bounded, one-action handles; independent of HTTP sessions. */
export class SnapshotStore {
  constructor({ now = () => Date.now(), id = uuid, maxPerClient = 32 } = {}) {
    this.now = now;
    this.id = id;
    this.maxPerClient = maxPerClient;
    this.snapshots = new Map();
  }

  create(clientId, targetId, documentId, data) {
    this.prune();
    const owned = [...this.snapshots.entries()].filter(
      ([, value]) => value.clientId === clientId
    );
    while (owned.length >= this.maxPerClient) {
      this.snapshots.delete(owned.shift()[0]);
    }
    const snapshotId = this.id();
    this.snapshots.set(snapshotId, {
      clientId,
      targetId,
      documentId,
      data,
      expiresAt: this.now() + 30000,
    });
    return snapshotId;
  }

  take(snapshotId, clientId, targetId, documentId) {
    const value = this.snapshots.get(snapshotId);
    requireValue(
      value && value.expiresAt > this.now(),
      "stale_snapshot",
      "Snapshot is missing, expired or already consumed; inspect the target again"
    );
    requireValue(
      value.clientId === clientId && value.targetId === targetId,
      "wrong_snapshot_target",
      "Snapshot belongs to another client or target"
    );
    this.snapshots.delete(snapshotId);
    requireValue(
      value.documentId === documentId,
      "stale_document",
      "The document changed; inspect it again"
    );
    return value.data;
  }

  clearClient(clientId) {
    for (const [id, value] of this.snapshots) {
      if (value.clientId === clientId) {
        this.snapshots.delete(id);
      }
    }
  }

  prune() {
    for (const [id, value] of this.snapshots) {
      if (value.expiresAt <= this.now()) {
        this.snapshots.delete(id);
      }
    }
  }

  clear() {
    this.snapshots.clear();
  }
}
