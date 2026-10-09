// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  SnapshotStore,
  paginate,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import {
  boundedValue,
  documentIdentity,
  performAction,
  scanElements,
  snapshotDocument,
  takeElement,
  validateAction,
  visibleElement,
} from "resource:///actors/ZenMcpInteraction.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

export class ZenMcpChild extends JSWindowActorChild {
  #snapshots = new SnapshotStore();
  #requests = new Map();

  didDestroy() {
    for (const controller of this.#requests.values()) {
      controller.abort();
    }
    this.#requests.clear();
    this.#snapshots.clear();
  }

  async receiveMessage(message) {
    const { clientId, requestId, command, args = {} } = message.data || {};
    if (message.name === "ZenMcp:Cleanup") {
      this.#snapshots.clearClient(clientId);
      for (const [key, controller] of this.#requests) {
        if (key.startsWith(`${clientId}:`)) {
          controller.abort();
        }
      }
      return undefined;
    }
    if (message.name === "ZenMcp:Cancel") {
      this.#requests.get(`${clientId}:${requestId}`)?.abort();
      return undefined;
    }
    if (message.name !== "ZenMcp:Query") {
      throw new Error("Unknown ZenMcp actor message");
    }
    const controller = new AbortController();
    const requestKey = `${clientId}:${requestId}`;
    try {
      requireValue(
        typeof clientId === "string" && typeof requestId === "string",
        "invalid_client",
        "An identified parent request is required",
      );
      requireValue(
        !this.#requests.has(requestKey),
        "duplicate_request",
        "Request identifier is already in use",
      );
      this.#requests.set(requestKey, controller);
      requireValue(
        this.manager.isCurrentGlobal && !this.manager.isClosed,
        "stale_document",
        "The actor's document is no longer current; inspect the tab",
      );
      if (args.documentId !== undefined) {
        requireValue(
          args.documentId === documentIdentity(this.contentWindow),
          "stale_document",
          "The document changed; inspect it again",
        );
      }
      const value = await this.#query(
        command,
        args,
        clientId,
        controller.signal,
      );
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof McpToolError
              ? error.code
              : controller.signal.aborted
                ? "cancelled"
                : "page_operation_failed",
          message:
            error instanceof McpToolError
              ? error.message
              : controller.signal.aborted
                ? "The request was cancelled"
                : "The page operation failed; inspect its current state before retrying",
        },
      };
    } finally {
      this.#requests.delete(requestKey);
    }
  }

  #identity() {
    const win = this.contentWindow;
    return {
      frameId: String(this.browsingContext.id),
      documentId: documentIdentity(win),
      url: win.document.documentURI,
      origin: win.document.nodePrincipal.origin,
      title: win.document.title,
      readyState: win.document.readyState,
      viewport: {
        width: win.innerWidth,
        height: win.innerHeight,
        x: win.scrollX,
        y: win.scrollY,
      },
    };
  }

  async #query(command, args, clientId, signal) {
    requireValue(!signal.aborted, "cancelled", "The request was cancelled");
    const win = this.contentWindow;
    const targetId = String(this.browsingContext.id);
    switch (command) {
      case "identity":
        return this.#identity();
      case "snapshot":
        return {
          ...this.#identity(),
          ...snapshotDocument(win, this.#snapshots, clientId, targetId, args),
        };
      case "text":
        return this.#text(args);
      case "action": {
        validateAction(args);
        const element = takeElement(
          win,
          this.#snapshots,
          clientId,
          targetId,
          args,
        );
        return {
          ...this.#identity(),
          ...(await performAction(win, element, args)),
        };
      }
      case "wait":
        return this.#wait(args, clientId, signal);
      case "storage":
        return this.#storage(args, signal);
      default:
        throw new McpToolError(
          "unknown_page_command",
          "The page command is not supported",
        );
    }
  }

  #text(args) {
    const maxChars = args.maxChars ?? 50000;
    requireValue(
      Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 1000000,
      "invalid_limit",
      "maxChars must be from 1 to 1000000",
    );
    const doc = this.contentWindow.document;
    const selected = args.selector
      ? scanElements(doc, args.selector, false).elements
      : [doc.body || doc.documentElement];
    const roots = selected.filter(Boolean);
    const visited = new WeakSet();
    const segments = [];
    let length = 0,
      scanned = 0,
      truncated = false;
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      const root = roots[rootIndex];
      if (visited.has(root)) {
        continue;
      }
      const walker = doc.createTreeWalker(root, 5);
      // Starting at the root discovers a shadow root on a selected host too.
      for (let node = root; node; node = walker.nextNode()) {
        if (visited.has(node)) {
          continue;
        }
        visited.add(node);
        if (++scanned > 50000) {
          truncated = true;
          break;
        }
        if (node.nodeType === 1 && node.shadowRoot) {
          roots.push(node.shadowRoot);
        }
        if (
          node.nodeType !== 3 ||
          !node.parentElement ||
          node.parentElement.closest("script,style,noscript,template") ||
          !visibleElement(node.parentElement)
        ) {
          continue;
        }
        const value = node.nodeValue.replace(/\s+/g, " ").trim();
        if (!value) {
          continue;
        }
        const available = maxChars - length;
        if (available <= 0) {
          truncated = true;
          break;
        }
        segments.push(value.slice(0, available));
        length += Math.min(value.length, available) + 1;
        if (value.length > available) {
          truncated = true;
          break;
        }
      }
      if (truncated) {
        break;
      }
    }
    return {
      ...this.#identity(),
      text: segments.join("\n").slice(0, maxChars),
      truncated,
      scanned,
    };
  }

  async #wait(args, clientId, signal) {
    const timeoutMs = args.timeoutMs ?? 15000;
    const state = args.state ?? (args.selector ? "visible" : "ready");
    requireValue(
      Number.isInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000,
      "invalid_timeout",
      "timeoutMs must be from 0 to 60000",
    );
    requireValue(
      ["present", "visible", "hidden", "absent", "ready"].includes(state),
      "invalid_state",
      "Unknown wait state",
    );
    requireValue(
      state === "ready" || typeof args.selector === "string",
      "missing_selector",
      "selector is required for this wait state",
    );
    const deadline = Date.now() + timeoutMs;
    while (true) {
      requireValue(!signal.aborted, "cancelled", "The request was cancelled");
      requireValue(
        this.manager.isCurrentGlobal && !this.manager.isClosed,
        "stale_document",
        "The document changed while waiting; inspect the tab",
      );
      let matched;
      if (state === "ready") {
        requireValue(
          args.readyState === undefined ||
            ["interactive", "complete"].includes(args.readyState),
          "invalid_state",
          "readyState must be interactive or complete",
        );
        matched =
          args.readyState === "interactive"
            ? this.contentWindow.document.readyState !== "loading"
            : this.contentWindow.document.readyState === "complete";
      } else {
        const inventory = scanElements(
          this.contentWindow.document,
          args.selector,
          true,
        );
        const visible = inventory.elements.some(visibleElement);
        matched =
          state === "present"
            ? inventory.elements.length > 0
            : state === "visible"
              ? visible
              : state === "hidden"
                ? !visible
                : inventory.elements.length === 0;
        requireValue(
          !inventory.scanTruncated ||
            (["present", "visible"].includes(state) && matched),
          "scan_limit",
          "The document exceeds the scan limit; use a more specific document or selector",
        );
      }
      if (matched) {
        return {
          ...this.#identity(),
          state,
          matched: true,
          ...(args.selector && ["present", "visible"].includes(state)
            ? snapshotDocument(
                this.contentWindow,
                this.#snapshots,
                clientId,
                String(this.browsingContext.id),
                { ...args, includeHidden: state === "present" },
              )
            : {}),
        };
      }
      requireValue(
        Date.now() < deadline,
        "wait_timeout",
        "The condition did not become true before timeout; inspect the page",
      );
      await new Promise((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(new McpToolError("cancelled", "The request was cancelled"));
        };
        const timer = setTimeout(
          () => {
            signal.removeEventListener("abort", aborted);
            resolve();
          },
          Math.min(100, Math.max(0, deadline - Date.now())),
        );
        signal.addEventListener("abort", aborted, { once: true });
      });
    }
  }

  async #storage(args, signal) {
    const { action, area, key, value } = args;
    requireValue(
      ["list", "get", "set", "remove", "clear"].includes(action),
      "invalid_action",
      "Unknown storage action",
    );
    requireValue(
      ["local", "session", "indexedDB"].includes(area),
      "invalid_area",
      "area must be local, session or indexedDB",
    );
    if (area === "indexedDB") {
      return this.#indexedDB(args, signal);
    }
    const storage =
      area === "local"
        ? this.contentWindow.localStorage
        : this.contentWindow.sessionStorage;
    const result = { ...this.#identity(), area, action };
    if (action === "list") {
      const keys = [];
      for (let index = 0; index < storage.length; index++) {
        keys.push(storage.key(index));
      }
      return {
        ...result,
        ...paginate(
          keys.map((item) => ({ key: item, value: storage.getItem(item) })),
          args,
        ),
      };
    }
    if (["get", "set", "remove"].includes(action)) {
      requireValue(
        typeof key === "string",
        "invalid_key",
        "key must be a string",
      );
    }
    if (action === "get") {
      return { ...result, key, value: storage.getItem(key) };
    }
    if (action === "set") {
      requireValue(
        typeof value === "string",
        "invalid_value",
        "Web Storage values must be strings",
      );
      storage.setItem(key, value);
      return { ...result, key, value: storage.getItem(key) };
    }
    if (action === "remove") {
      storage.removeItem(key);
      return { ...result, key, removed: storage.getItem(key) === null };
    }
    storage.clear();
    return { ...result, length: storage.length };
  }

  async #indexedDB(args, signal) {
    const factory = this.contentWindow.indexedDB;
    const identity = {
      ...this.#identity(),
      area: "indexedDB",
      action: args.action,
    };
    const databases = await factory.databases();
    if (!args.database) {
      requireValue(
        args.action === "list",
        "missing_database",
        "database and store are required for this IndexedDB operation",
      );
      return { ...identity, ...paginate(databases, args) };
    }
    requireValue(
      databases.some((database) => database.name === args.database),
      "missing_database",
      "The database does not exist in this frame's origin",
    );
    const database = await new Promise((resolve, reject) => {
      const request = factory.open(args.database);
      let settled = false;
      const fail = (code, message) => {
        if (!settled) {
          settled = true;
          signal.removeEventListener("abort", abort);
          reject(new McpToolError(code, message));
        }
      };
      const abort = () =>
        fail("cancelled", "The storage request was cancelled");
      signal.addEventListener("abort", abort, { once: true });
      request.onsuccess = () => {
        if (settled || signal.aborted) {
          request.result.close();
        } else {
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve(request.result);
        }
      };
      request.onerror = () =>
        fail("storage_failed", "IndexedDB could not open the database");
      // A database disappearing between databases() and open() must not create it.
      request.onupgradeneeded = () => {
        request.transaction.abort();
      };
      request.onblocked = () =>
        fail("storage_blocked", "IndexedDB is blocked by another connection");
    });
    try {
      requireValue(!signal.aborted, "cancelled", "The request was cancelled");
      requireValue(
        this.manager.isCurrentGlobal && !this.manager.isClosed,
        "stale_document",
        "The document changed during the storage request",
      );
      if (!args.store) {
        requireValue(
          args.action === "list",
          "missing_store",
          "store is required for this IndexedDB operation",
        );
        return {
          ...identity,
          database: args.database,
          version: database.version,
          ...paginate([...database.objectStoreNames], args),
        };
      }
      requireValue(
        database.objectStoreNames.contains(args.store),
        "missing_store",
        "The object store does not exist",
      );
      const writable = ["set", "remove", "clear"].includes(args.action);
      const transaction = database.transaction(
        args.store,
        writable ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore(args.store);
      const done = new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onabort = transaction.onerror = () =>
          reject(
            new McpToolError("storage_failed", "IndexedDB transaction failed"),
          );
      });
      // Prevent an unhandled rejection before the request's promise settles.
      done.catch(() => {});
      const abort = () => {
        try {
          transaction.abort();
        } catch {}
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        let request;
        if (args.action === "list") {
          const limit = args.limit ?? 100;
          paginate([], args);
          const offset = args.cursor === undefined ? 0 : Number(args.cursor);
          const total = await this.#idbRequest(store.count());
          const items = await new Promise((resolve, reject) => {
            const records = [];
            const cursorRequest = store.openCursor();
            let advanced = false;
            cursorRequest.onerror = () =>
              reject(
                new McpToolError("storage_failed", "IndexedDB cursor failed"),
              );
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (cursor && !advanced && offset) {
                advanced = true;
                cursor.advance(offset);
                return;
              }
              advanced = true;
              if (!cursor || records.length >= limit) {
                resolve(records);
                return;
              }
              records.push({
                key: boundedValue(cursor.key).value,
                ...boundedValue(cursor.value),
              });
              cursor.continue();
            };
          });
          await done;
          return {
            ...identity,
            database: args.database,
            store: args.store,
            items,
            total,
            ...(offset + items.length < total
              ? { nextCursor: String(offset + items.length) }
              : {}),
          };
        }
        if (["get", "remove"].includes(args.action)) {
          requireValue(
            args.key !== undefined,
            "invalid_key",
            "key is required",
          );
          request =
            args.action === "get"
              ? store.get(args.key)
              : store.delete(args.key);
        } else if (args.action === "set") {
          requireValue(
            args.value !== undefined,
            "invalid_value",
            "value is required",
          );
          request =
            args.key === undefined
              ? store.put(args.value)
              : store.put(args.value, args.key);
        } else {
          request = store.clear();
        }
        const value = await this.#idbRequest(request);
        await done;
        return {
          ...identity,
          database: args.database,
          store: args.store,
          ...boundedValue(value),
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } finally {
      database.close();
    }
  }

  #idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(new McpToolError("storage_failed", "IndexedDB request failed"));
    });
  }
}
