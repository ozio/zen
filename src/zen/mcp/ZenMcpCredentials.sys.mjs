// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { McpToolError } from "./ZenMcpUtils.sys.mjs";

function sameHash(a, b) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < 64; i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export class ZenMcpCredentials {
  constructor({
    read,
    write,
    hash,
    random,
    id,
    now = () => new Date().toISOString(),
    revoked,
  }) {
    Object.assign(this, { read, write, hash, random, id, now, revoked });
    this.clients = new Map();
    this.queue = Promise.resolve();
  }

  async load() {
    const data = await this.read();
    if (!data) {
      return;
    }
    if (
      data.version !== 1 ||
      !Array.isArray(data.clients) ||
      data.clients.length > 128
    ) {
      throw new McpToolError(
        "invalid_credentials",
        "MCP client registry is invalid",
      );
    }
    const clients = new Map();
    for (const client of data.clients) {
      if (
        typeof client.id !== "string" ||
        !client.id ||
        clients.has(client.id) ||
        typeof client.name !== "string" ||
        !client.name.trim() ||
        client.name.length > 100 ||
        !/^[a-f0-9]{64}$/.test(client.hash) ||
        typeof client.createdAt !== "string"
      ) {
        throw new McpToolError(
          "invalid_credentials",
          "MCP client registry is invalid",
        );
      }
      clients.set(client.id, {
        id: client.id,
        name: client.name,
        hash: client.hash,
        createdAt: client.createdAt,
        lastUsedAt: client.lastUsedAt ?? null,
      });
    }
    this.clients = clients;
  }

  list() {
    return [...this.clients.values()].map(({ hash, ...client }) => client);
  }

  authenticate(authorization) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    if (!match) {
      return null;
    }
    const hash = this.hash(match[1]);
    let found;
    for (const client of this.clients.values()) {
      if (sameHash(client.hash, hash)) {
        found = client;
      }
    }
    if (!found) {
      return null;
    }
    found.lastUsedAt = this.now();
    return { id: found.id, name: found.name };
  }

  mutate(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async save(clients) {
    await this.write({ version: 1, clients: [...clients.values()] });
    this.clients = clients;
  }

  add(name) {
    return this.mutate(async () => {
      if (
        typeof name !== "string" ||
        !(name = name.trim()) ||
        name.length > 100
      ) {
        throw new McpToolError(
          "invalid_name",
          "Client name must contain 1–100 characters",
        );
      }
      if (this.clients.size >= 128) {
        throw new McpToolError("client_limit", "The MCP client limit is 128");
      }
      if ([...this.clients.values()].some((client) => client.name === name)) {
        throw new McpToolError(
          "duplicate_name",
          "A client with this name already exists",
        );
      }
      const token = this.random();
      const client = {
        id: this.id(),
        name,
        createdAt: this.now(),
        lastUsedAt: null,
        hash: this.hash(token),
      };
      const clients = new Map(this.clients);
      clients.set(client.id, client);
      await this.save(clients);
      const { hash, ...publicClient } = client;
      return { client: publicClient, token };
    });
  }

  rotate(clientId) {
    return this.mutate(async () => {
      const previous = this.clients.get(clientId);
      if (!previous) {
        throw new McpToolError(
          "unknown_client",
          "The MCP client no longer exists",
        );
      }
      const token = this.random();
      const client = { ...previous, hash: this.hash(token), lastUsedAt: null };
      const clients = new Map(this.clients);
      clients.set(clientId, client);
      await this.save(clients);
      this.revoked?.(clientId);
      const { hash, ...publicClient } = client;
      return { client: publicClient, token };
    });
  }

  revoke(clientId) {
    return this.mutate(async () => {
      if (!this.clients.has(clientId)) {
        throw new McpToolError(
          "unknown_client",
          "The MCP client no longer exists",
        );
      }
      const clients = new Map(this.clients);
      clients.delete(clientId);
      await this.save(clients);
      this.revoked?.(clientId);
    });
  }
}
