// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  paginate,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import { boundedValue } from "resource:///actors/ZenMcpInteraction.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  require: "resource://devtools/shared/loader/Loader.sys.mjs",
});

const MAX_RECORDS = 2000;
const CONSOLE_TYPES = ["console-message", "error-message"];
const NETWORK_TYPES = ["network-event"];

function commandsFactory() {
  // forTab initializes DevToolsServer and connects using connectPipe(). It
  // neither starts a listener nor needs a global remote/chrome debugging pref.
  return lazy.require("resource://devtools/shared/commands/commands-factory.js")
    .CommandsFactory;
}

export function consoleRecord(resource) {
  const message = resource.message || resource.pageError || resource;
  const documentId = message.innerWindowID ?? resource.innerWindowId ?? null;
  const frameId =
    resource.browsingContextID ??
    (documentId === resource.targetFront?.innerWindowId
      ? resource.targetFront?.browsingContextID
      : null);
  return {
    id: String(
      resource.resourceId ??
        message.timeStamp ??
        message.timestamp ??
        Date.now(),
    ),
    resourceType: resource.resourceType,
    level:
      message.level ||
      (resource.resourceType === "error-message" ? "error" : "log"),
    timeStamp: message.timeStamp ?? message.timestamp ?? null,
    text: boundedValue(message.errorMessage || message.message || null, {
      maxChars: 10000,
    }).value,
    arguments: boundedValue(
      (message.arguments || [])
        .slice(0, 100)
        .map((argument) => argument?.getGrip?.() ?? argument),
      { maxDepth: 5, maxEntries: 100, maxChars: 10000 },
    ).value,
    filename: message.filename || message.sourceName || null,
    line: message.lineNumber ?? null,
    column: message.columnNumber ?? null,
    frameId: frameId ? String(frameId) : null,
    documentId: documentId ? String(documentId) : null,
    isPromiseRejection: message.isPromiseRejection === true,
  };
}

export function networkRecord(resource) {
  return {
    requestId: String(resource.resourceId),
    actorId: resource.actor,
    url: String(resource.url || resource.request?.url || "").slice(0, 16384),
    method: String(resource.method || resource.request?.method || "").slice(
      0,
      64,
    ),
    urlTruncated:
      String(resource.url || resource.request?.url || "").length > 16384,
    status: resource.status ?? null,
    statusText: resource.statusText?.slice(0, 500) ?? null,
    mimeType: resource.mimeType?.slice(0, 500) || null,
    startedDateTime: resource.startedDateTime || null,
    totalTime: resource.totalTime ?? null,
    transferredSize: resource.transferredSize ?? null,
    contentSize: resource.contentSize ?? null,
    fromCache: resource.fromCache === true,
    blockedReason: resource.blockedReason ?? null,
    frameId: resource.browsingContextID
      ? String(resource.browsingContextID)
      : null,
    documentId: resource.innerWindowId ? String(resource.innerWindowId) : null,
  };
}

/** Per-client collectors attach only after an explicit request for a tab. */
export class ZenMcpDevTools {
  constructor(service, { factory = commandsFactory } = {}) {
    this.service = service;
    this.factory = factory;
    this.entries = new Map();
    this.closed = false;
  }

  async #entry(tabId, client) {
    requireValue(!this.closed, "server_stopped", "The MCP service stopped");
    const tab = this.service.getTab(tabId);
    requireValue(
      tab.linkedPanel && !tab.hasAttribute("pending"),
      "tab_unloaded",
      "The tab is unloaded; select or navigate it explicitly before attaching DevTools",
    );
    const key = `${client.id}:${tabId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        clientId: client.id,
        tabId,
        tab,
        commands: null,
        closed: false,
        console: [],
        network: new Map(),
        nextSequence: 1,
        consoleWatching: false,
        networkWatching: false,
      };
      this.entries.set(key, entry);
      entry.tabClosed = () => {
        this.#dispose(entry);
      };
      tab.addEventListener("TabClose", entry.tabClosed, { once: true });
      entry.ready = (async () => {
        const commands = await this.factory().forTab(tab);
        entry.commands = commands;
        if (entry.closed || this.closed) {
          await this.#destroyCommands(entry);
          throw new McpToolError(
            "client_disconnected",
            "The client or target disconnected during DevTools attachment",
          );
        }
        commands.descriptorFront.doNotAttachThreadActor = true;
        await commands.targetCommand.startListening();
        if (entry.closed || this.closed) {
          await this.#destroyCommands(entry);
          throw new McpToolError(
            "client_disconnected",
            "The client or target disconnected during DevTools attachment",
          );
        }
        entry.onAvailable = (resources) => {
          if (entry.closed) {
            return;
          }
          for (const resource of resources) {
            if (resource.private === true) {
              continue;
            }
            if (
              CONSOLE_TYPES.includes(resource.resourceType) &&
              entry.consoleWatching
            ) {
              const record = {
                sequence: entry.nextSequence++,
                ...consoleRecord(resource),
              };
              entry.console.push(record);
              if (entry.console.length > MAX_RECORDS) {
                entry.console.shift();
              }
              this.service.notify("console", {
                clientId: entry.clientId,
                tabId: entry.tabId,
                sequence: record.sequence,
              });
            } else if (
              resource.resourceType === "network-event" &&
              entry.networkWatching
            ) {
              const request = networkRecord(resource);
              entry.network.set(request.requestId, request);
              if (entry.network.size > MAX_RECORDS) {
                const oldest = entry.network.keys().next().value;
                this.#releaseRequest(entry, entry.network.get(oldest));
                entry.network.delete(oldest);
              }
              this.service.notify("network", {
                clientId: entry.clientId,
                tabId: entry.tabId,
                requestId: request.requestId,
              });
            }
          }
        };
        entry.onUpdated = (updates) => {
          if (entry.closed || !entry.networkWatching) {
            return;
          }
          for (const { resource, update } of updates) {
            const id = String(resource?.resourceId ?? update?.resourceId);
            const old = entry.network.get(id);
            if (old) {
              Object.assign(
                old,
                networkRecord({ ...resource, ...update, actor: old.actorId }),
              );
              this.service.notify("network", {
                clientId: entry.clientId,
                tabId: entry.tabId,
                requestId: id,
              });
            }
          }
        };
        return entry;
      })();
      // Root owns disconnect/revoke. A failed pending attach also releases all
      // local objects; it must not leave an invisible collector behind.
      entry.ready.catch(() => {
        this.#dispose(entry);
      });
    }
    await entry.ready;
    requireValue(
      !entry.closed,
      "client_disconnected",
      "The client or target disconnected",
    );
    return entry;
  }

  async evaluate(tabId, frame, source, client) {
    const expectedDocumentId = frame.currentWindowGlobal?.innerWindowId;
    const entry = await this.#entry(tabId, client);
    requireValue(
      frame.currentWindowGlobal?.innerWindowId === expectedDocumentId,
      "stale_document",
      "The frame navigated while DevTools was attaching; inspect it again",
    );
    const command = entry.commands.targetCommand;
    const frameTargets = command.getAllTargets([command.TYPES.FRAME]);
    // A same-process subframe has no dedicated target; innerWindowID selects
    // its realm. Walk ancestors for nested same-process frames, but never use
    // an ancestor in a different process for a remote frame.
    let selectedTargetFront;
    for (let ancestor = frame; ancestor; ancestor = ancestor.parent) {
      if (
        ancestor.currentWindowGlobal?.osPid !== frame.currentWindowGlobal?.osPid
      ) {
        break;
      }
      selectedTargetFront =
        frameTargets.find(
          (item) => String(item.browsingContextID) === String(ancestor.id),
        ) || (ancestor === frame.top ? command.targetFront : null);
      if (selectedTargetFront) {
        break;
      }
    }
    requireValue(
      selectedTargetFront,
      "target_unavailable",
      "DevTools has no target for this frame yet",
    );
    const expression = `(async () => { const result = await (0, eval)(${JSON.stringify(source)}); return JSON.stringify((${boundedValue.toString()})(result)); })()`;
    const response = await entry.commands.scriptCommand.execute(expression, {
      selectedTargetFront,
      innerWindowID: expectedDocumentId,
      mapped: { await: true },
      disableBreaks: true,
      url: "zen-mcp-evaluation",
    });
    if (response.exception || response.exceptionMessage) {
      const exception = boundedValue(
        response.exceptionMessage?.getGrip?.() ??
          response.exceptionMessage ??
          response.exception?.getGrip?.() ??
          response.exception,
      ).value;
      for (const front of [response.exception, response.exceptionMessage]) {
        if (typeof front?.release === "function") {
          await front.release().catch(() => {});
        }
      }
      return { exception };
    }
    let result = response.result;
    const resultFront = result;
    try {
      if (result?.string) {
        result = await result.string();
      } else if (result?.getGrip) {
        result = await this.#text(entry, result.getGrip(), 1000000);
      }
    } finally {
      if (typeof resultFront?.release === "function") {
        await resultFront.release().catch(() => {});
      }
    }
    requireValue(
      typeof result === "string",
      "evaluation_failed",
      "DevTools did not return the serialized evaluation result",
    );
    try {
      return JSON.parse(result);
    } catch {
      throw new McpToolError(
        "evaluation_failed",
        "DevTools returned an invalid evaluation result",
      );
    }
  }

  async console(args, client) {
    if (args.action === "stop") {
      return this.#stop(args.tabId, client.id, "console");
    }
    const entry = await this.#entry(args.tabId, client);
    await this.#start(entry, "console");
    if (args.action === "clear") {
      entry.console.length = 0;
    }
    const items = args.level
      ? entry.console.filter((item) => item.level === args.level)
      : entry.console;
    return {
      tabId: args.tabId,
      collecting: true,
      retainedLimit: MAX_RECORDS,
      ...(args.action === "read" || args.action === undefined
        ? paginate(items, args)
        : { count: items.length }),
    };
  }

  async network(args, client) {
    if (args.action === "stop") {
      return this.#stop(args.tabId, client.id, "network");
    }
    const entry = await this.#entry(args.tabId, client);
    await this.#start(entry, "network");
    if (args.action === "clear") {
      for (const request of entry.network.values()) {
        this.#releaseRequest(entry, request);
      }
      entry.network.clear();
    }
    if (args.action === "details") {
      const request = entry.network.get(args.requestId);
      requireValue(
        request,
        "missing_request",
        "The request was not captured by this client or was evicted",
      );
      const maxChars = args.maxChars ?? 100000;
      requireValue(
        Number.isInteger(maxChars) && maxChars >= 1 && maxChars <= 1000000,
        "invalid_limit",
        "maxChars must be from 1 to 1000000",
      );
      const get = (type) =>
        entry.commands.client.request({ to: request.actorId, type });
      const [requestHeaders, responseHeaders] = await Promise.all([
        get("getRequestHeaders"),
        get("getResponseHeaders"),
      ]);
      const sent = await this.#headers(
        entry,
        requestHeaders.headers || [],
        maxChars,
      );
      const received = await this.#headers(
        entry,
        responseHeaders.headers || [],
        maxChars,
      );
      const details = {
        ...this.#publicRequest(request),
        requestHeaders: sent.items,
        requestHeadersTruncated: sent.truncated,
        responseHeaders: received.items,
        responseHeadersTruncated: received.truncated,
      };
      if (args.includeBodies) {
        const [post, response] = await Promise.all([
          get("getRequestPostData"),
          get("getResponseContent"),
        ]);
        details.requestBody = await this.#text(
          entry,
          post.postData?.text,
          maxChars,
        );
        details.requestBodyDiscarded = post.postDataDiscarded === true;
        details.requestBodyTruncated =
          (post.postData?.text?.length ?? 0) > maxChars;
        details.responseBody = await this.#text(
          entry,
          response.content?.text,
          maxChars,
        );
        details.responseBodyDiscarded = response.contentDiscarded === true;
        details.responseEncoding = response.content?.encoding || null;
        details.responseTruncated =
          response.content?.truncated === true ||
          (response.content?.text?.length ?? 0) > maxChars;
      }
      return { tabId: args.tabId, request: details };
    }
    return {
      tabId: args.tabId,
      collecting: true,
      retainedLimit: MAX_RECORDS,
      ...(args.action === "read" || args.action === undefined
        ? paginate(
            [...entry.network.values()].map((value) =>
              this.#publicRequest(value),
            ),
            args,
          )
        : { count: entry.network.size }),
    };
  }

  #publicRequest(request) {
    const { actorId, ...result } = request;
    return result;
  }

  async #headers(entry, headers, maxChars) {
    const result = [];
    let chars = 0,
      truncated = headers.length > 1000;
    for (const header of headers.slice(0, 1000)) {
      const name = String(header.name);
      if (chars + name.length >= maxChars) {
        truncated = true;
        break;
      }
      const remaining = maxChars - chars - name.length;
      const value = await this.#text(entry, header.value, remaining);
      truncated ||= (header.value?.length ?? 0) > remaining;
      result.push({ name, value });
      chars += name.length + String(value ?? "").length;
    }
    return { items: result, truncated };
  }

  async #text(entry, text, maxChars) {
    if (typeof text === "string") {
      return text.slice(0, maxChars);
    }
    if (text?.type === "longString") {
      if (text.initial.length >= Math.min(text.length, maxChars)) {
        return text.initial.slice(0, maxChars);
      }
      const response = await entry.commands.client.request({
        to: text.actor,
        type: "substring",
        start: 0,
        end: Math.min(text.length, maxChars),
      });
      return response.substring;
    }
    return text ?? null;
  }

  async #start(entry, kind) {
    const property = `${kind}Watching`;
    if (entry[property]) {
      return;
    }
    entry[property] = true;
    try {
      await entry.commands.resourceCommand.watchResources(
        kind === "console" ? CONSOLE_TYPES : NETWORK_TYPES,
        {
          onAvailable: entry.onAvailable,
          onUpdated: entry.onUpdated,
          ignoreExistingResources: true,
        },
      );
      if (kind === "network" && entry.commands.watcherFront) {
        const network =
          await entry.commands.watcherFront.getNetworkParentActor();
        // These settings belong to this connection's watcher, not preferences
        // or other DevTools clients. Eviction releases old network actors.
        await network.setPersist(true);
        await network.setSaveRequestAndResponseBodies(true);
      }
      requireValue(
        !entry.closed,
        "client_disconnected",
        "The client or target disconnected during resource attachment",
      );
    } catch (error) {
      entry[property] = false;
      throw error;
    }
  }

  #stop(tabId, clientId, kind) {
    this.service.getTab(tabId);
    const entry = this.entries.get(`${clientId}:${tabId}`);
    if (entry?.commands && entry[`${kind}Watching`]) {
      entry.commands.resourceCommand.unwatchResources(
        kind === "console" ? CONSOLE_TYPES : NETWORK_TYPES,
        { onAvailable: entry.onAvailable },
      );
      entry[`${kind}Watching`] = false;
      if (kind === "console") {
        entry.console.length = 0;
      } else {
        for (const request of entry.network.values()) {
          this.#releaseRequest(entry, request);
        }
        entry.network.clear();
      }
      if (!entry.consoleWatching && !entry.networkWatching) {
        this.#dispose(entry);
      }
    }
    return { tabId, collecting: false };
  }

  #releaseRequest(entry, request) {
    if (request?.actorId && entry.commands && !entry.closed) {
      entry.commands.client
        .request({ to: request.actorId, type: "release" })
        .catch(() => {});
    }
  }

  async #dispose(entry) {
    if (entry.closed) {
      return entry.destroyPromise;
    }
    entry.closed = true;
    this.entries.delete(entry.key);
    entry.tab.removeEventListener("TabClose", entry.tabClosed);
    entry.console.length = 0;
    entry.network.clear();
    if (entry.commands) {
      try {
        if (entry.consoleWatching) {
          entry.commands.resourceCommand.unwatchResources(CONSOLE_TYPES, {
            onAvailable: entry.onAvailable,
          });
        }
        if (entry.networkWatching) {
          entry.commands.resourceCommand.unwatchResources(NETWORK_TYPES, {
            onAvailable: entry.onAvailable,
          });
        }
        await this.#destroyCommands(entry);
      } catch {
        // A target closing has already destroyed its fronts/transport.
      }
    }
  }

  #destroyCommands(entry) {
    if (!entry.destroyPromise && entry.commands) {
      entry.destroyPromise = entry.commands.destroy().catch(() => {});
    }
    return entry.destroyPromise;
  }

  cleanup(clientId) {
    return Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.clientId === clientId)
        .map((entry) => this.#dispose(entry)),
    );
  }

  destroy() {
    this.closed = true;
    return Promise.all(
      [...this.entries.values()].map((entry) => this.#dispose(entry)),
    );
  }
}
