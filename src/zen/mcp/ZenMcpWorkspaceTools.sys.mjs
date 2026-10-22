// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  McpToolError,
  makeTool,
  paginate,
  requireValue,
  schema,
  uuid,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import {
  revision,
  sortTabs,
  validSortKey,
} from "resource:///modules/zen/mcp/ZenMcpTabQuery.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore:
    "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
  TabStateFlusher:
    "moz-src:///browser/components/sessionstore/TabStateFlusher.sys.mjs",
});
const ids = {
  type: "array",
  items: schema.string,
  uniqueItems: true,
  maxItems: 10000,
};
const select = {
  windowId: schema.string,
  tabIds: ids,
  selectionId: schema.string,
  filter: schema.object,
  filterLambda: schema.string,
};
const placement = {
  destinationWindowId: schema.string,
  spaceId: schema.string,
  folderId: { type: ["string", "null"] },
  beforeId: schema.string,
  afterId: schema.string,
};
const actions = ["move", "sort", "close", "discard", "reopen", "open", "pin"];
const PAGE = {
  cursor: schema.string,
  limit: { type: "integer", minimum: 1, maximum: 500 },
};
const LIMIT = 32;
const SELECTION_TTL = 5 * 60 * 1000;
const OPERATION_TTL = 30 * 60 * 1000;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const owner = tab => tab.ownerGlobal ?? tab.documentGlobal;
const abort = signal =>
  requireValue(
    !signal?.aborted,
    "cancelled",
    "Request cancelled; inspect its operation receipt before issuing another mutation"
  );
const jsonClone = value => JSON.parse(JSON.stringify(value));
const errorInfo = error => ({
  code: error.code ?? "native_error",
  message: String(error.message ?? error).slice(0, 512),
});

function selectsOnlyGroups(args, groupIds) {
  return (
    groupIds &&
    args.tabIds === undefined &&
    !args.selectionId &&
    !args.filter &&
    args.filterLambda === undefined
  );
}

function expressionSource(source) {
  if (source === undefined) {
    return "null";
  }
  requireValue(
    typeof source === "string" &&
      source.length <= 8192 &&
      !/\bimport\b/.test(source),
    "invalid_expression",
    "Lambda must be at most 8192 characters and cannot import modules"
  );
  return source;
}

function createExpressionWorker(source) {
  // A system-principal worker must use a trusted resource URI. The substitution
  // keeps the entry module in memory and is never exposed to content pages.
  const name = `zen-mcp-expression-${uuid()}`;
  const handler = Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
  const url = URL.createObjectURL(
    new Blob([source], { type: "text/javascript" })
  );
  const cleanup = () => {
    try {
      handler.setSubstitution(name, null);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  try {
    handler.setSubstitution(name, Services.io.newURI(url));
    // ChromeWorker has a non-removable ctypes FFI. Standard workers do not.
    const worker = new Worker(`resource://${name}/`, { type: "module" });
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => {
      try {
        terminate();
      } finally {
        cleanup();
      }
    };
    return worker;
  } catch (error) {
    cleanup();
    throw error;
  }
}

function pinMode(pinned, essential) {
  if (essential) {
    return "essential";
  }
  return pinned ? "pinned" : "normal";
}

function groupsNeededForRestore(layout, selected, groupIds) {
  const definitions = new Map(
    layout.groups.map(group => [group.groupId, group])
  );
  const needed = new Set(groupIds.filter(id => definitions.has(id)));
  for (const definition of definitions.values()) {
    let parent = definition.parentGroupId;
    while (parent) {
      if (needed.has(parent)) {
        needed.add(definition.groupId);
        break;
      }
      parent = definitions.get(parent)?.parentGroupId;
    }
  }
  for (const item of selected) {
    let id = item.groupId;
    while (id) {
      needed.add(id);
      id = definitions.get(id)?.parentGroupId;
    }
  }
  return needed;
}

/** Client-private selections, previews and reversible native sidebar operations. */
export class ZenMcpWorkspaceTools {
  constructor(
    service,
    {
      now = () => Date.now(),
      id = uuid,
      createWorker = createExpressionWorker,
      workerTimeout = 500,
    } = {}
  ) {
    this.service = service;
    this.now = now;
    this.id = id;
    this.createWorker = createWorker;
    this.workerTimeout = workerTimeout;
    this.selections = new Map();
    this.plans = new Map();
    this.operations = new Map();
    this.workers = new Set();
  }

  get browser() {
    return this.service.browserTools;
  }

  getTools() {
    return [
      makeTool(
        "zen_sidebar_snapshot",
        "Read Spaces, folder/group tree and compact tab descriptors without loading discarded tabs.",
        { windowId: schema.string, ...PAGE },
        ["windowId"],
        { readOnly: true, openWorld: false }
      ),
      makeTool(
        "zen_tabs_query",
        "Select tabs with one reusable filter. Returns a client-owned five-minute selection, count and revision. Text conditions support equals/contains/glob/regex. duplicates keeps containers separate by default. Lambdas run over immutable descriptors in a disposable worker.",
        { ...select, ...PAGE },
        ["windowId"],
        { readOnly: true, openWorld: false }
      ),
      makeTool(
        "zen_tabs_plan",
        "Preview a batch operation without changing tabs. sort preserves native sibling boundaries; scope folder/subtree also orders folder/group units. order is an exact permutation of selected tab/group IDs. placements supports different destinations in one move plan. Reopen uses a retained close operationId, independent of Firefox's closed-tab cap.",
        {
          ...select,
          action: schema.enum(...actions),
          ...placement,
          groupIds: ids,
          placements: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              properties: { tabIds: ids, groupIds: ids, ...placement },
              additionalProperties: false,
            },
          },
          order: ids,
          sort: { type: ["object", "array"] },
          sortKeyLambda: schema.string,
          scope: schema.enum("siblings", "folder", "subtree"),
          mode: schema.enum("normal", "pinned", "essential"),
          urls: {
            type: "array",
            maxItems: 500,
            items: {
              oneOf: [
                schema.string,
                {
                  type: "object",
                  properties: {
                    url: schema.string,
                    title: schema.string,
                    containerId: schema.integer,
                  },
                  required: ["url"],
                  additionalProperties: false,
                },
              ],
            },
          },
          containerId: schema.integer,
          lazy: schema.boolean,
          reuse: schema.enum("never", "url"),
          select: schema.boolean,
          operationId: schema.string,
          closedIds: {
            type: "array",
            items: schema.integer,
            uniqueItems: true,
            maxItems: 500,
          },
        },
        ["windowId", "action"],
        { readOnly: true, openWorld: false }
      ),
      makeTool(
        "zen_tabs_apply",
        "Apply a preview once, if its relevant state still matches. Returns per-item outcomes and an operation receipt even for partial completion. Repeating the same planId never repeats effects.",
        { planId: schema.string },
        ["planId"]
      ),
      makeTool(
        "zen_tabs_undo",
        "Undo an owned operation within thirty minutes only while its resulting state is unchanged. Restores batch-close SessionStore snapshots; reports conflicts instead of overwriting later user changes.",
        { operationId: schema.string },
        ["operationId"]
      ),
      makeTool(
        "zen_pins",
        "List or batch reset/replace/edit saved pin URLs, rename custom titles, or unload pins. list exposes saved/current URLs and drift. Non-list operations return an undo receipt.",
        {
          ...select,
          ...PAGE,
          action: schema.enum(
            "list",
            "reset",
            "replace",
            "setUrl",
            "rename",
            "unload"
          ),
          url: schema.string,
          title: schema.string,
        },
        ["windowId", "action"]
      ),
    ];
  }

  async execute(name, args, client, signal) {
    this.service.assertInstance(args, name);
    this.prune();
    abort(signal);
    switch (name) {
      case "zen_sidebar_snapshot":
        return this.sidebar(args);
      case "zen_tabs_query":
        return this.query(args, client, signal);
      case "zen_tabs_plan":
        return this.plan(args, client, signal);
      case "zen_tabs_apply":
        return this.apply(args, client, signal);
      case "zen_tabs_undo":
        return this.undo(args, client, signal);
      case "zen_pins":
        return this.pins(args, client, signal);
      default:
        throw new McpToolError("unknown_tool", "Unknown workspace tool");
    }
  }

  prune() {
    for (const map of [this.selections, this.plans, this.operations]) {
      for (const [id, record] of map) {
        if (record.expiresAt <= this.now() && !record.running) {
          map.delete(id);
        }
      }
    }
  }

  cleanup(clientId, reason) {
    // An idle HTTP/SSE connection is not an explicit revocation of recovery.
    if (reason === "idle") {
      this.prune();
      return;
    }
    for (const map of [this.selections, this.plans, this.operations]) {
      for (const [id, record] of map) {
        if (record.clientId === clientId) {
          map.delete(id);
        }
      }
    }
  }

  destroy() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers.clear();
    this.selections.clear();
    this.plans.clear();
    this.operations.clear();
  }

  put(map, client, record, ttl) {
    this.prune();
    const owned = [...map.entries()].filter(
      ([, value]) => value.clientId === client.id
    );
    if (map === this.selections) {
      while (owned.length >= 128) {
        map.delete(owned.shift()[0]);
      }
      while (map.size >= 512) {
        map.delete(map.keys().next().value);
      }
    } else if (map === this.plans) {
      for (let i = owned.length - 1; i >= 0; i--) {
        if (
          owned[i][1].operationId &&
          !owned[i][1].running &&
          owned.length >= LIMIT
        ) {
          // Keep the idempotency link through the operation receipt instead.
          const [oldId, old] = owned.splice(i, 1)[0];
          const operation = this.operations.get(old.operationId);
          if (operation) {
            operation.planId = oldId;
          }
          map.delete(oldId);
        }
      }
    }
    requireValue(
      owned.length < (map === this.selections ? 128 : LIMIT),
      "receipt_limit",
      "Too many retained receipts; wait for expiration or finish prior operations"
    );
    if (map === this.operations && record.sessions) {
      const size = sessions =>
        sessions
          ? [...sessions.values()].reduce(
              (sum, state) => sum + state.length * 2,
              0
            )
          : 0;
      const total = [...map.values()].reduce(
        (sum, value) => sum + size(value.sessions),
        0
      );
      const clientTotal = owned.reduce(
        (sum, [, value]) => sum + size(value.sessions),
        0
      );
      requireValue(
        clientTotal + size(record.sessions) <= MAX_SESSION_BYTES &&
          total + size(record.sessions) <= 4 * MAX_SESSION_BYTES,
        "recovery_limit",
        "Retained close snapshots reached the memory budget"
      );
    }
    const id = this.id();
    map.set(id, {
      ...record,
      clientId: client.id,
      expiresAt: this.now() + ttl,
    });
    return id;
  }

  get(map, id, client, kind) {
    this.prune();
    const record = map.get(id);
    requireValue(
      record && record.clientId === client.id,
      `unknown_${kind}`,
      `${kind} is unknown, expired or belongs to another client`
    );
    return record;
  }

  releaseOperation(operationId, client) {
    const operation = this.get(
      this.operations,
      operationId,
      client,
      "operation"
    );
    requireValue(
      !operation.running,
      "operation_running",
      "Cannot release an active operation"
    );
    this.operations.delete(operationId);
    for (const [id, plan] of this.plans) {
      if (plan.operationId === operationId) {
        this.plans.delete(id);
      }
    }
  }

  releasePlan(planId, client) {
    const plan = this.get(this.plans, planId, client, "plan");
    requireValue(
      !plan.running && !plan.operationId,
      "plan_in_use",
      "Only an unapplied preview can be released"
    );
    this.plans.delete(planId);
  }

  tabs(win) {
    return this.service
      .listTabs(win)
      .filter(
        tab =>
          !tab.closing &&
          !tab.hasAttribute("zen-empty-tab") &&
          !tab.hasAttribute("zen-glance-tab")
      );
  }

  descriptor(tab) {
    const state = this.browser.mediaState(tab);
    // Firefox's cached tab.index only tracks its active strip. Zen keeps tabs
    // in inactive Spaces as well; its stored-array identity is invalidated on
    // native ordering changes, making this map both current and cheap to reuse.
    const win = owner(tab);
    const stored =
      win.gZenWorkspaces.allStoredTabs ?? this.service.listTabs(win);
    this.indexMaps ??= new WeakMap();
    let indexes = this.indexMaps.get(stored);
    if (!indexes) {
      indexes = new Map(stored.map((item, index) => [item, index]));
      this.indexMaps.set(stored, indexes);
    }
    state.index = indexes.get(tab) ?? null;
    const folderPath = [];
    let group = tab.group;
    while (group) {
      // Native live folders can create lazy tabs before their Space attribute
      // is materialized. Their enclosing group already defines membership.
      state.spaceId ||= group.getAttribute("zen-workspace-id") || null;
      if (group.isZenFolder) {
        folderPath.unshift({ groupId: group.id, title: group.label ?? "" });
      }
      group = group.group;
    }
    let domain = "";
    let registrableDomain = "";
    try {
      domain = new URL(state.url).hostname.toLocaleLowerCase();
      try {
        registrableDomain = Services.eTLD.getBaseDomainFromHost(domain);
      } catch {
        registrableDomain = domain;
      }
    } catch {}
    const savedUrl = tab._zenPinnedInitialState?.entry?.url ?? null;
    return {
      ...state,
      domain,
      registrableDomain,
      folderPath,
      playing: !!state.media?.playing,
      audible: !!state.media?.audible || !!state.soundPlaying,
      pictureInPicture: tab.hasAttribute("pictureinpicture"),
      savedUrl,
      currentUrl: state.url,
      customTitle: tab.zenStaticLabel ?? null,
      pinChanged: !!savedUrl && savedUrl !== state.url,
      lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : null,
      createdAt: Number.isFinite(tab._creationTime) ? tab._creationTime : null,
    };
  }

  describe(win) {
    return this.tabs(win).map(tab => this.descriptor(tab));
  }

  sidebar(args) {
    const win = this.browser.window(args.windowId);
    const tabs = this.describe(win);
    return {
      window: this.browser.windowState(win),
      spaces: win.gZenWorkspaces
        .getWorkspaces()
        .map(space => this.browser.spaceState(win, space)),
      groups: this.browser
        .allGroups(win)
        .map(group => this.browser.groupState(win, group)),
      ...paginate(tabs, args),
    };
  }

  async evaluate(items, args, signal) {
    abort(signal);
    requireValue(
      items.length <= 10000 && JSON.stringify(items).length <= 16 * 1024 * 1024,
      "selection_too_large",
      "Selection exceeds worker data limit; narrow the window first"
    );
    // Parse caller expressions as module source, avoiding system-principal
    // eval/Function, which Gecko's CSP forbids. The unconditional first call
    // removes capabilities before evaluating any interpolated expression.
    const worker = this.createWorker(`
      import { lockdown, serve } from "resource:///modules/zen/mcp/ZenMcpLambdaWorker.sys.mjs";
      lockdown();
      serve(\n(${expressionSource(args.filterLambda)})\n,\n(${expressionSource(args.sortKeyLambda)})\n);
    `);
    this.workers.add(worker);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        worker.terminate();
        this.workers.delete(worker);
        error ? reject(error) : resolve(result);
      };
      const cancel = () =>
        finish(new McpToolError("cancelled", "Selection evaluation cancelled"));
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(
        () =>
          finish(
            new McpToolError(
              "lambda_timeout",
              "Tab expression exceeded its worker time budget"
            )
          ),
        this.workerTimeout
      );
      worker.onerror = () =>
        finish(
          new McpToolError("lambda_failed", "Tab expression worker failed")
        );
      worker.onmessage = event => {
        const data = event.data;
        if (data?.error) {
          finish(new McpToolError("invalid_expression", data.error));
          return;
        }
        const allowed = new Set(items.map(item => item.tabId));
        if (
          !data ||
          !Array.isArray(data.ids) ||
          data.ids.length > items.length ||
          new Set(data.ids).size !== data.ids.length ||
          !data.ids.every(id => allowed.has(id)) ||
          (data.keys !== null &&
            (!Array.isArray(data.keys) ||
              data.keys.length !== data.ids.length ||
              !data.keys.every(validSortKey)))
        ) {
          finish(
            new McpToolError(
              "invalid_lambda_result",
              "Worker returned invalid tab IDs or keys"
            )
          );
          return;
        }
        finish(null, data);
      };
      try {
        worker.postMessage(
          jsonClone({
            items,
            filter: args.filter ?? {},
          })
        );
      } catch (error) {
        finish(error);
      }
    });
  }

  async resolveTargets(args, client, signal) {
    const win = args.windowId ? this.browser.window(args.windowId) : null;
    requireValue(
      win || (Array.isArray(args.tabIds) && !args.selectionId),
      "missing_window",
      "Filter selections need windowId; explicit tabIds may span windows"
    );
    if (args.selectionId) {
      requireValue(
        args.tabIds === undefined &&
          args.filter === undefined &&
          args.filterLambda === undefined,
        "ambiguous_selection",
        "selectionId cannot be combined with IDs or filters"
      );
      const selected = this.get(
        this.selections,
        args.selectionId,
        client,
        "selection"
      );
      requireValue(
        selected.windowId === args.windowId,
        "wrong_window",
        "Selection belongs to another window"
      );
      const tabs = selected.ids.map(id => this.browser.tab(id, win));
      requireValue(
        revision(
          tabs.map(tab => this.descriptor(tab)),
          { selection: true }
        ) === selected.signature,
        "selection_conflict",
        "Selected tab state changed; query again before acting"
      );
      return tabs;
    }
    requireValue(
      args.tabIds === undefined ||
        (Array.isArray(args.tabIds) &&
          new Set(args.tabIds).size === args.tabIds.length &&
          args.tabIds.every(id => typeof id === "string")),
      "invalid_argument",
      "tabIds must be unique explicit IDs"
    );
    const tabs = args.tabIds
      ? args.tabIds.map(id => this.browser.tab(id, win))
      : this.tabs(win);
    if (!args.filter && args.filterLambda === undefined) {
      return tabs;
    }
    const before = tabs.map(tab => this.descriptor(tab));
    const selected = await this.evaluate(before, args, signal);
    requireValue(
      revision(
        tabs.map(tab =>
          this.descriptor(this.browser.tab(this.service.tabId(tab), win))
        ),
        { selection: true }
      ) === revision(before, { selection: true }),
      "selection_conflict",
      "Tabs changed while evaluating the filter"
    );
    const byId = new Map(tabs.map(tab => [this.service.tabId(tab), tab]));
    return selected.ids.map(id => byId.get(id));
  }

  async query(args, client, signal) {
    const tabs = await this.resolveTargets(args, client, signal);
    const items = tabs.map(tab => this.descriptor(tab));
    // Paged reads of an existing selection reuse its identity and deadline.
    const existing =
      args.selectionId &&
      this.get(this.selections, args.selectionId, client, "selection");
    const version = existing?.revision ?? this.id();
    const selectionId =
      args.selectionId ??
      this.put(
        this.selections,
        client,
        {
          windowId: args.windowId,
          ids: items.map(item => item.tabId),
          signature: revision(items, { selection: true }),
          revision: version,
        },
        SELECTION_TTL
      );
    return {
      ...paginate(items, args),
      selectionId,
      revision: version,
      expiresAt: this.selections.get(selectionId).expiresAt,
    };
  }

  signature(windows) {
    return JSON.stringify(
      windows.map(win => ({
        id: this.service.windowId(win),
        tabs: revision(
          this.describe(win).sort((a, b) => a.tabId.localeCompare(b.tabId)),
          { layout: true }
        ),
        orders: this.captureOrders(win)
          .map(order => JSON.stringify(order))
          .sort(),
        groups: this.browser
          .allGroups(win)
          .map(group => this.browser.groupState(win, group))
          .sort((a, b) => a.groupId.localeCompare(b.groupId)),
      }))
    );
  }

  group(win, id) {
    const group = this.browser.allGroups(win).find(item => item.id === id);
    requireValue(
      group,
      "unknown_group",
      "Group or folder is no longer in this window"
    );
    return group;
  }

  groupTabs(group) {
    return Array.from(group.tabs).filter(
      tab => !tab.hasAttribute("zen-empty-tab")
    );
  }

  itemId(item) {
    return item.localName === "tab" || item.linkedBrowser
      ? this.service.tabId(item)
      : item.id;
  }

  itemTabs(item) {
    return item.tabs ? this.groupTabs(item) : [item];
  }

  groupDescriptor(group) {
    const first = this.groupTabs(group)[0];
    return {
      ...(first ? this.descriptor(first) : {}),
      tabId: group.id,
      title: group.label ?? "",
      customTitle: group.label ?? "",
      groupId: group.group?.id ?? null,
    };
  }

  boundary(item) {
    const tab = item.tabs ? this.groupTabs(item)[0] : item;
    const win = owner(item) ?? owner(tab);
    return JSON.stringify([
      this.service.windowId(win),
      item.group?.id ?? null,
      item.getAttribute("zen-workspace-id") ||
        tab?.getAttribute("zen-workspace-id"),
      !!item.pinned,
      item.hasAttribute("zen-essential"),
    ]);
  }

  units(tabs, groups = []) {
    // Complete native groups travel as one unit; a partial Split View never can.
    const selected = new Set(tabs);
    const explicit = new Set(groups);
    const enclosing = new Set();
    for (const group of groups) {
      this.groupTabs(group).forEach(tab => selected.add(tab));
      for (let parent = group.group; parent; parent = parent.group) {
        enclosing.add(parent);
      }
    }
    const units = [];
    for (const tab of selected) {
      let item = tab;
      for (let group = tab.group; group; group = group.group) {
        const members = this.groupTabs(group);
        if (
          explicit.has(group) ||
          (!enclosing.has(group) &&
            members.length &&
            members.every(member => selected.has(member)))
        ) {
          item = group;
        } else if (group.hasAttribute("split-view-group")) {
          throw new McpToolError(
            "split_boundary",
            "Select the entire Split View to move it"
          );
        }
      }
      if (!units.includes(item)) {
        units.push(item);
      }
    }
    for (const group of groups) {
      if (!this.groupTabs(group).length && !units.includes(group)) {
        units.push(group);
      }
    }
    // Explicit child folders must not pull their parent along merely because
    // they contain its last tabs. Conversely, a selected ancestor already owns
    // its selected descendants, including empty folders with no member tabs.
    return units.filter(item => {
      for (let parent = item.group; parent; parent = parent.group) {
        if (units.includes(parent)) {
          return false;
        }
      }
      return true;
    });
  }

  validatePlacement(args, units, source) {
    const win = args.destinationWindowId
      ? this.browser.window(args.destinationWindowId)
      : source;
    const spaceId =
      args.spaceId ??
      (win !== source ? win.gZenWorkspaces.activeWorkspace : null);
    if (spaceId) {
      this.browser.validateSpace(win, spaceId);
    }
    const folder = args.folderId
      ? this.browser.group(args.folderId, win, "folder")
      : null;
    requireValue(
      !(args.beforeId && args.afterId),
      "invalid_placement",
      "Use beforeId or afterId, not both"
    );
    const anchorId = args.beforeId ?? args.afterId;
    const anchor = anchorId
      ? (this.browser.allGroups(win).find(group => group.id === anchorId) ??
        this.browser.tab(anchorId, win))
      : null;
    const members = units.flatMap(item => this.itemTabs(item));
    if (win !== source) {
      const destinationGroups = new Set(
        this.browser.allGroups(win).map(group => group.id)
      );
      for (const unit of units.filter(item => item.tabs)) {
        const tree = [
          unit,
          ...(unit.allItemsRecursive ?? []).filter(item => item.tabs),
        ];
        requireValue(
          tree.every(group => !destinationGroups.has(group.id)),
          "group_collision",
          "Destination already contains a group from this tree; choose distinct groups or move within the synced window"
        );
      }
    }
    const effectiveSpace =
      spaceId ??
      (folder && folder.getAttribute("zen-workspace-id")) ??
      (anchor &&
        (anchor.getAttribute("zen-workspace-id") ||
          this.itemTabs(anchor)[0]?.getAttribute("zen-workspace-id")));
    if (folder) {
      requireValue(
        !effectiveSpace ||
          folder.getAttribute("zen-workspace-id") === effectiveSpace,
        "folder_space",
        "Destination folder and Space must match"
      );
      requireValue(
        !members.some(tab => tab.hasAttribute("zen-essential")),
        "essential_scope",
        "Essentials cannot be placed in folders"
      );
      for (const unit of units) {
        let parent = folder;
        while (parent) {
          requireValue(
            parent !== unit,
            "folder_cycle",
            "A folder cannot be placed inside itself or a descendant"
          );
          parent = parent.group;
        }
        if (unit.isZenFolder) {
          const descendants = [
            unit,
            ...(unit.allItemsRecursive ?? []).filter(item => item.isZenFolder),
          ];
          const depth = Math.max(
            ...descendants.map(item => (item.level ?? 0) - (unit.level ?? 0))
          );
          requireValue(
            (folder.level ?? 0) + 1 + depth <
              Services.prefs.getIntPref("zen.folders.max-subfolders", 5),
            "folder_depth",
            "Destination would exceed Zen's folder nesting depth"
          );
        }
      }
    }
    requireValue(
      !effectiveSpace ||
        members.every(tab => !tab.hasAttribute("zen-essential")),
      "essential_scope",
      "Essentials cannot be moved into a Space"
    );
    if (anchor) {
      requireValue(
        !units.includes(anchor) &&
          !this.itemTabs(anchor).some(tab => members.includes(tab)),
        "invalid_anchor",
        "Anchor cannot be part of the moved selection"
      );
      if (folder) {
        requireValue(
          anchor.group === folder,
          "anchor_boundary",
          "Anchor must be a direct child of the destination folder"
        );
      }
      requireValue(
        units.every(item => !!item.pinned === !!anchor.pinned || !!folder),
        "pin_boundary",
        "An anchor cannot cross pinned and normal sections"
      );
      if (args.folderId === null) {
        requireValue(
          !anchor.group,
          "anchor_boundary",
          "Root placement needs a root anchor"
        );
      }
    }
    return {
      win,
      spaceId: effectiveSpace,
      folder,
      anchor,
      root: args.folderId === null,
    };
  }

  sortSelection(args, tabs, win) {
    const explicit = [
      "tabIds",
      "selectionId",
      "filter",
      "filterLambda",
      "groupIds",
    ].some(key => args[key] !== undefined);
    if (!explicit) {
      return () => true;
    }
    const selected = new Set(tabs);
    const groups = new Set(
      (args.groupIds ?? []).map(id => this.group(win, id))
    );
    return item => {
      for (let ancestor = item; ancestor; ancestor = ancestor.group) {
        if (groups.has(ancestor)) {
          return true;
        }
      }
      if (!item.tabs) {
        return selected.has(item);
      }
      const members = this.groupTabs(item);
      const complete =
        !!members.length && members.every(tab => selected.has(tab));
      requireValue(
        !item.hasAttribute("split-view-group") ||
          complete ||
          !members.some(tab => selected.has(tab)),
        "split_boundary",
        "Select the entire Split View to sort it as one unit"
      );
      return complete;
    };
  }

  async sortGroups(args, tabs, signal) {
    const win = this.browser.window(args.windowId);
    const buckets = new Map();
    const add = items => {
      for (const item of items) {
        if (item.hasAttribute("zen-empty-tab")) {
          continue;
        }
        const key = this.boundary(item);
        if (!buckets.has(key)) {
          buckets.set(key, []);
        }
        if (!buckets.get(key).includes(item)) {
          buckets.get(key).push(item);
        }
      }
    };
    if (args.scope === "folder" || args.scope === "subtree") {
      requireValue(
        args.folderId,
        "missing_folder",
        "folder/subtree sorting needs folderId"
      );
      const root = this.browser.group(args.folderId, win, "folder");
      const selected = this.sortSelection(args, tabs, win);
      const visit = folder => {
        add(folder.allItems.filter(selected));
        if (args.scope === "subtree") {
          for (const item of folder.allItems) {
            if (item.isZenFolder) {
              visit(item);
            }
          }
        }
      };
      visit(root);
    } else {
      const selected = new Set(tabs);
      add(
        tabs.map(tab => {
          if (tab.group?.hasAttribute("split-view-group")) {
            requireValue(
              this.groupTabs(tab.group).every(member => selected.has(member)),
              "split_boundary",
              "Select the entire Split View to sort it as one unit"
            );
            return tab.group;
          }
          return tab;
        })
      );
      add((args.groupIds ?? []).map(id => this.group(win, id)));
    }
    const result = [];
    const all = [...buckets.values()].flat();
    if (args.order) {
      requireValue(
        buckets.size === 1 &&
          args.order.length === all.length &&
          new Set(args.order).size === all.length &&
          args.order.every(id => all.some(item => this.itemId(item) === id)),
        "invalid_order",
        "order must be an exact permutation of one native sibling selection"
      );
      result.push(
        args.order.map(id => all.find(item => this.itemId(item) === id))
      );
      return result;
    }
    for (const items of buckets.values()) {
      const descriptors = items.map(item =>
        item.tabs ? this.groupDescriptor(item) : this.descriptor(item)
      );
      const evaluated = args.sortKeyLambda
        ? await this.evaluate(
            descriptors,
            { sortKeyLambda: args.sortKeyLambda },
            signal
          )
        : null;
      const sorted = sortTabs(descriptors, args.sort, evaluated?.keys);
      result.push(
        sorted.map(value =>
          items.find(item => this.itemId(item) === value.tabId)
        )
      );
    }
    return result;
  }

  async plan(args, client, signal) {
    requireValue(
      actions.includes(args.action),
      "invalid_action",
      "Unknown batch action"
    );
    const win = this.browser.window(args.windowId);
    const originalSignature = this.signature([win]);
    const windows = new Set([win]);
    let tabs = [];
    let moves = [];
    let orders = [];
    let open = [];
    let recovery = null;
    let closedSignature = null;
    if (args.action === "open") {
      requireValue(
        Array.isArray(args.urls) && args.urls.length && args.urls.length <= 500,
        "invalid_urls",
        "Open needs between one and 500 URLs"
      );
      const destination = this.validatePlacement(args, [], win);
      windows.add(destination.win);
      const spaceId =
        destination.spaceId ?? destination.win.gZenWorkspaces.activeWorkspace;
      this.browser.validateSpace(destination.win, spaceId);
      open = args.urls.map(entry => {
        const value = typeof entry === "string" ? { url: entry } : entry;
        requireValue(
          value && typeof value.url === "string",
          "invalid_url",
          "Each open item needs url"
        );
        Services.io.newURI(value.url);
        const containerId =
          value.containerId ??
          args.containerId ??
          destination.win.gZenWorkspaces.getWorkspaceFromId(spaceId)
            .containerTabId ??
          0;
        this.browser.validateContainer(containerId);
        return { ...value, containerId, spaceId };
      });
    } else if (args.action === "reopen") {
      requireValue(
        !!args.operationId !== !!args.closedIds,
        "invalid_recovery",
        "Reopen needs operationId or closedIds, not both"
      );
      if (args.operationId) {
        recovery = this.get(
          this.operations,
          args.operationId,
          client,
          "operation"
        );
        requireValue(
          recovery.action === "close" && !recovery.undone,
          "invalid_recovery",
          "Reopen requires a retained, unrecovered close operation"
        );
        requireValue(
          recovery.windowIds.includes(args.windowId),
          "wrong_window",
          "Close operation belongs to another window"
        );
        recovery.windowIds.forEach(id => windows.add(this.browser.window(id)));
      } else {
        requireValue(
          Array.isArray(args.closedIds) &&
            args.closedIds.length <= 500 &&
            new Set(args.closedIds).size === args.closedIds.length &&
            args.closedIds.every(Number.isInteger),
          "invalid_closed_ids",
          "closedIds must contain at most 500 unique integer IDs"
        );
        const available = this.browser.closedTabs(win);
        const selected = args.closedIds.map(id =>
          available.find(item => item.closedId === id)
        );
        requireValue(
          selected.every(Boolean),
          "unknown_closed_tab",
          "A requested closed tab is no longer retained in this window"
        );
        closedSignature = JSON.stringify(selected);
      }
    } else if (args.action === "move") {
      const layouts = args.placements ?? [args];
      requireValue(
        Array.isArray(layouts) && layouts.length && layouts.length <= 100,
        "invalid_placements",
        "placements must contain 1..100 destinations"
      );
      const seen = new Set();
      for (const entry of layouts) {
        const groupsOnly = selectsOnlyGroups(args, entry.groupIds);
        const selected = await this.resolveTargets(
          args.placements || groupsOnly
            ? { windowId: args.windowId, tabIds: entry.tabIds ?? [] }
            : args,
          client,
          signal
        );
        const groups = (entry.groupIds ?? []).map(id => this.group(win, id));
        const units = this.units(selected, groups);
        const target = this.validatePlacement(entry, units, win);
        windows.add(target.win);
        for (const tab of units.flatMap(unit => this.itemTabs(unit))) {
          requireValue(
            !seen.has(tab),
            "duplicate_placement",
            "Each tab may occur in only one destination"
          );
          seen.add(tab);
          tabs.push(tab);
        }
        moves.push({
          args: jsonClone(entry),
          units: units.map(item => ({
            id: this.itemId(item),
            group: !!item.tabs,
          })),
        });
      }
    } else {
      const groupsOnly = selectsOnlyGroups(args, args.groupIds);
      tabs = await this.resolveTargets(
        groupsOnly ? { windowId: args.windowId, tabIds: [] } : args,
        client,
        signal
      );
      if (args.action === "sort") {
        const groups = await this.sortGroups(args, tabs, signal);
        orders = groups.map(items =>
          items.map(item => ({ id: this.itemId(item), group: !!item.tabs }))
        );
        tabs = [...new Set(groups.flat().flatMap(item => this.itemTabs(item)))];
      }
      if (args.action === "pin") {
        requireValue(
          ["normal", "pinned", "essential"].includes(args.mode),
          "invalid_mode",
          "Pin mode is required"
        );
        requireValue(
          tabs.every(tab => !tab.group?.hasAttribute("split-view-group")),
          "split_boundary",
          "Change the whole Split View through its native API"
        );
      }
    }
    abort(signal);
    requireValue(
      this.signature([win]) === originalSignature,
      "plan_conflict",
      "Sidebar changed while preparing this preview"
    );
    const windowList = [...windows];
    const descriptors = tabs.map(tab => this.descriptor(tab));
    const signature = this.signature(windowList);
    const version = this.id();
    const preview = {
      moves,
      orders,
      open,
      ...(recovery
        ? {
            recoverOperationId: args.operationId,
            recoverable: recovery.outcomes.filter(
              item =>
                item.status === "closed" &&
                !recovery.restoredIds.includes(item.tabId)
            ).length,
          }
        : {}),
      ...(args.closedIds
        ? { closedIds: args.closedIds, recoverable: args.closedIds.length }
        : {}),
    };
    const planId = this.put(
      this.plans,
      client,
      {
        args: jsonClone(args),
        ids: descriptors.map(item => item.tabId),
        selectionSignature: revision(descriptors, { selection: true }),
        moves,
        orders,
        open,
        windowIds: windowList.map(value => this.service.windowId(value)),
        signature,
        closedSignature,
        revision: version,
        preview,
      },
      SELECTION_TTL
    );
    return {
      planId,
      action: args.action,
      revision: version,
      total: descriptors.length || open.length || preview.recoverable || 0,
      items: descriptors,
      preview,
      expiresAt: this.plans.get(planId).expiresAt,
    };
  }

  resolveItem(ref, win) {
    return ref.group ? this.group(win, ref.id) : this.browser.tab(ref.id, win);
  }

  captureLayout(windows) {
    return windows.map(win => ({
      windowId: this.service.windowId(win),
      groups: this.browser.allGroups(win).map(group => ({
        ...this.browser.groupState(win, group),
        isLiveFolder: !!group.isLiveFolder,
      })),
      items: this.tabs(win).map(tab => ({
        ...this.descriptor(tab),
        pinnedInitialState: jsonClone(tab._zenPinnedInitialState ?? null),
      })),
      orders: this.captureOrders(win),
    }));
  }

  captureOrders(win) {
    const tabs = new Set(this.tabs(win));
    const groups = new Set(this.browser.allGroups(win));
    const parents = new Set(
      [...tabs, ...groups].map(item => item.parentElement).filter(Boolean)
    );
    return [...parents].map(parent =>
      Array.from(parent.children)
        .filter(item => tabs.has(item) || groups.has(item))
        .map(item => ({ id: this.itemId(item), group: groups.has(item) }))
    );
  }

  focus(windows) {
    return windows.map(win => ({
      win,
      tab: win.gBrowser.selectedTab,
      spaceId: win.gZenWorkspaces.activeWorkspace,
    }));
  }

  async restoreFocus(focus, replacements = new Map()) {
    for (const state of focus) {
      if (state.win.closed) {
        continue;
      }
      if (
        state.spaceId &&
        state.win.gZenWorkspaces.activeWorkspace !== state.spaceId &&
        state.win.gZenWorkspaces.getWorkspaceFromId(state.spaceId)
      ) {
        await state.win.gZenWorkspaces.changeWorkspaceWithID(state.spaceId);
      }
      const tab = replacements.get(state.tab) ?? state.tab;
      if (
        tab &&
        owner(tab) === state.win &&
        !tab.closing &&
        this.tabs(state.win).includes(tab)
      ) {
        // Selecting a tab moved into another Space would undo focus preservation.
        if (
          tab.hasAttribute("zen-essential") ||
          tab.getAttribute("zen-workspace-id") === state.spaceId
        ) {
          state.win.gBrowser.selectedTab = tab;
        }
      }
    }
  }

  async captureSessions(tabs, signal) {
    const states = new Map();
    let bytes = 0;
    for (const tab of tabs) {
      abort(signal);
      if (tab.linkedPanel && !tab.hasAttribute("pending")) {
        await lazy.TabStateFlusher.flush(tab.linkedBrowser);
      }
      const state = lazy.SessionStore.getTabState(tab);
      bytes += state.length * 2;
      requireValue(
        bytes <= MAX_SESSION_BYTES,
        "recovery_limit",
        "Batch session recovery would exceed 32 MiB; use smaller close batches"
      );
      states.set(this.service.tabId(tab), state);
    }
    return states;
  }

  async apply(args, client, signal) {
    const retained = [...this.operations.entries()].find(
      ([, operation]) =>
        operation.planId === args.planId && operation.clientId === client.id
    );
    if (retained) {
      return this.receipt(retained[1], retained[0]);
    }
    const plan = this.get(this.plans, args.planId, client, "plan");
    if (plan.operationId) {
      return this.receipt(
        this.get(this.operations, plan.operationId, client, "operation"),
        plan.operationId
      );
    }
    requireValue(
      !plan.running,
      "operation_running",
      "This plan is already being applied"
    );
    const windows = plan.windowIds.map(id => this.browser.window(id));
    if (plan.args.closedIds) {
      const available = this.browser.closedTabs(
        this.browser.window(plan.args.windowId)
      );
      requireValue(
        JSON.stringify(
          plan.args.closedIds.map(id =>
            available.find(item => item.closedId === id)
          )
        ) === plan.closedSignature,
        "plan_conflict",
        "Native closed-tab records changed after preview"
      );
    }
    requireValue(
      this.signature(windows) === plan.signature,
      "plan_conflict",
      "Sidebar changed after preview; create a fresh plan"
    );
    const tabs = plan.ids.map(id => this.browser.tab(id));
    requireValue(
      !plan.selectionSignature ||
        revision(
          tabs.map(tab => this.descriptor(tab)),
          { selection: true }
        ) === plan.selectionSignature,
      "plan_conflict",
      "Selected tab state changed after preview"
    );
    const sessions =
      plan.args.action === "close"
        ? await this.captureSessions(tabs, signal)
        : null;
    // Capturing live content is asynchronous. Recheck *before* the first effect.
    requireValue(
      this.signature(windows) === plan.signature &&
        (!plan.selectionSignature ||
          revision(
            tabs.map(tab => this.descriptor(tab)),
            { selection: true }
          ) === plan.selectionSignature),
      "plan_conflict",
      "Tabs changed while preparing the operation"
    );
    abort(signal);
    const operation = {
      action: plan.args.action,
      windowIds: plan.windowIds,
      before: this.captureLayout(windows),
      sessions,
      outcomes: [],
      afterSignature: null,
      running: true,
      undoable: true,
      idMap: new Map(),
      createdIds: [],
      createdGroups: [],
      restoredIds: [],
      affectedIds: plan.ids,
      affectedGroups: [
        ...new Set(
          [
            ...(plan.moves ?? []).flatMap(move => move.units),
            ...(plan.orders ?? []).flat(),
          ]
            .filter(ref => ref.group)
            .map(ref => ref.id)
        ),
      ],
      sourceOperationId: plan.args.operationId,
    };
    const operationId = this.put(
      this.operations,
      client,
      operation,
      OPERATION_TTL
    );
    const stored = this.operations.get(operationId);
    plan.operationId = operationId;
    plan.running = true;
    const focus = this.focus(windows);
    try {
      await this.perform(plan, stored, client, signal);
      if (plan.args.select && stored.outcomes.length) {
        const last = stored.outcomes.findLast(
          item =>
            item.tabId &&
            ["moved", "opened", "reused", "restored"].includes(item.status)
        );
        if (last) {
          await this.browser.selectTab(this.browser.tab(last.tabId));
        }
      }
    } catch (error) {
      stored.error = errorInfo(error);
    } finally {
      if (!plan.args.select) {
        try {
          await this.restoreFocus(focus);
        } catch (error) {
          stored.focusError = errorInfo(error);
        }
      }
      stored.running = false;
      plan.running = false;
      stored.afterSignature = this.signature(
        windows.filter(win => !win.closed)
      );
      stored.windowIds = windows
        .filter(win => !win.closed)
        .map(win => this.service.windowId(win));
      stored.undoable =
        !!stored.createdIds.length ||
        stored.idMap.size > 0 ||
        !!stored.createdGroups.length ||
        stored.outcomes.some(
          item =>
            !["blocked", "failed", "skipped", "reused"].includes(item.status)
        );
      for (const win of windows) {
        if (!win.closed) {
          this.browser.changed(win, null);
        }
      }
    }
    return this.receipt(stored, operationId);
  }

  receipt(operation, operationId) {
    this.reconcileClose(operation);
    const summary = {};
    for (const item of operation.outcomes) {
      summary[item.status] = (summary[item.status] ?? 0) + 1;
    }
    return {
      operationId,
      action: operation.action,
      outcomes: operation.outcomes,
      summary,
      undoable: operation.undoable && !operation.undone,
      running: !!operation.running,
      ...(operation.error ? { error: operation.error } : {}),
      ...(operation.focusError ? { focusError: operation.focusError } : {}),
      expiresAt: operation.expiresAt,
    };
  }

  reconcileClose(operation) {
    if (operation.action !== "close") {
      return;
    }
    for (const item of operation.outcomes) {
      if (item.status !== "pending" && item.status !== "blocked") {
        continue;
      }
      const native = operation.pendingTabs?.get(item.tabId);
      if (native && !this.service.listTabs(owner(native)).includes(native)) {
        item.status = "closed";
        operation.undoable = true;
        operation.undone = false;
      }
    }
  }

  hasPendingClose(operation) {
    return operation.outcomes.some(
      item =>
        ["pending", "blocked"].includes(item.status) &&
        operation.pendingTabs?.has(item.tabId)
    );
  }

  async permitClose(tab, signal) {
    if (!tab.linkedPanel || tab.hasAttribute("pending")) {
      return { permitUnload: true };
    }
    const original = revision([this.descriptor(tab)], { selection: true });
    let timer, cancel;
    let result;
    try {
      result = await Promise.race([
        // Run the native check without opening a modal or entering the
        // synchronous permitUnload spin loop. A page needing confirmation
        // remains open and is reported as blocked in the batch receipt.
        tab.linkedBrowser.asyncPermitUnload("dontUnload"),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => resolve({ permitUnload: false, pending: true }),
            1500
          );
          cancel = () =>
            reject(new McpToolError("cancelled", "Close check cancelled"));
          signal?.addEventListener("abort", cancel, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    abort(signal);
    if (revision([this.descriptor(tab)], { selection: true }) !== original) {
      return { permitUnload: false, changed: true };
    }
    return result;
  }

  async perform(plan, operation, client, signal) {
    const win = this.browser.window(plan.args.windowId);
    if (plan.args.action === "move") {
      for (const move of plan.moves) {
        abort(signal);
        const units = move.units.map(ref => this.resolveItem(ref, win));
        const target = this.validatePlacement(move.args, units, win);
        let anchor = target.anchor;
        for (const unit of units) {
          abort(signal);
          const oldIds = this.itemTabs(unit).map(tab =>
            this.service.tabId(tab)
          );
          try {
            const moved = await this.moveUnit(unit, target, operation);
            if (anchor) {
              if (move.args.beforeId) {
                target.win.gBrowser.moveTabBefore(moved, anchor);
              } else {
                target.win.gBrowser.moveTabAfter(moved, anchor);
                anchor = moved;
              }
            }
            const movedTabs = this.itemTabs(moved);
            movedTabs.forEach((tab, index) =>
              operation.outcomes.push({
                originalTabId: oldIds[index],
                tabId: this.service.tabId(tab),
                status: "moved",
              })
            );
            if (!movedTabs.length) {
              operation.outcomes.push({
                itemId: this.itemId(moved),
                status: "moved",
              });
            }
          } catch (error) {
            operation.outcomes.push({
              itemId: this.itemId(unit),
              status: "failed",
              error: errorInfo(error),
            });
          }
        }
      }
      return;
    }
    if (plan.args.action === "sort") {
      for (const order of plan.orders) {
        abort(signal);
        const items = order.map(ref => this.resolveItem(ref, win));
        this.reorder(items);
        items.forEach(item =>
          operation.outcomes.push({
            itemId: this.itemId(item),
            status: "sorted",
          })
        );
      }
      return;
    }
    if (plan.args.action === "open") {
      await this.openTabs(plan, operation, signal);
      return;
    }
    if (plan.args.action === "reopen") {
      if (plan.args.closedIds) {
        for (const closedId of plan.args.closedIds) {
          abort(signal);
          try {
            const tab = lazy.SessionStore.undoCloseById(closedId, false, win);
            requireValue(
              tab && this.service.listTabs(win).includes(tab),
              "restore_failed",
              "Native SessionStore did not restore the closed tab"
            );
            const tabId = this.service.tabId(tab);
            operation.createdIds.push(tabId);
            operation.outcomes.push({ closedId, tabId, status: "restored" });
          } catch (error) {
            operation.outcomes.push({
              closedId,
              status: "failed",
              error: errorInfo(error),
            });
          }
        }
        return;
      }
      const source = this.get(
        this.operations,
        plan.args.operationId,
        client,
        "operation"
      );
      await this.restoreClosed(source, operation, signal);
      source.undone =
        !this.hasPendingClose(source) &&
        source.outcomes
          .filter(item => item.status === "closed")
          .every(item => source.restoredIds.includes(item.tabId));
      return;
    }
    for (const id of plan.ids) {
      abort(signal);
      let tab;
      try {
        tab = this.browser.tab(id);
        const tabWin = owner(tab);
        if (plan.args.action === "close") {
          const permission = await this.permitClose(tab, signal);
          if (!permission.permitUnload) {
            let code = "beforeunload_confirmation";
            let message = "Page requires confirmation before closing";
            if (permission.changed) {
              code = "close_target_changed";
              message = "Tab changed during its unload check; query again";
            } else if (permission.pending) {
              code = "unload_check_pending";
              message =
                "Native unload check is still pending; no close was requested";
            }
            operation.outcomes.push({
              tabId: id,
              status: "blocked",
              error: { code, message },
            });
            continue;
          }
          tabWin.gBrowser.removeTab(tab, {
            animate: false,
            closeWindowWithLastTab: false,
            skipPermitUnload: true,
          });
          try {
            await this.browser.waitFor(
              () => !this.service.listTabs(tabWin).includes(tab),
              signal,
              "Tab still exists; a beforeunload dialog may be blocking it",
              1500
            );
          } catch (error) {
            operation.pendingTabs ??= new Map();
            operation.pendingTabs.set(id, tab);
            operation.outcomes.push({
              tabId: id,
              status: tab.closing ? "pending" : "blocked",
              error: errorInfo(error),
            });
            continue;
          }
          operation.outcomes.push({ tabId: id, status: "closed" });
        } else if (plan.args.action === "discard") {
          if (!tab.linkedPanel) {
            operation.outcomes.push({ tabId: id, status: "skipped" });
            continue;
          }
          const discarded = await tabWin.gBrowser.discardBrowser(tab, true);
          operation.outcomes.push({
            tabId: id,
            status: discarded ? "discarded" : "blocked",
          });
        } else if (plan.args.action === "pin") {
          this.browser.setPinMode(tabWin, tab, plan.args.mode);
          operation.outcomes.push({ tabId: id, status: "pinned" });
        } else if (plan.args.action === "pins") {
          await this.pinAction(tab, plan.args, signal);
          operation.outcomes.push({ tabId: id, status: plan.args.pinAction });
        }
      } catch (error) {
        operation.outcomes.push({
          tabId: id,
          status: "failed",
          error: errorInfo(error),
        });
      }
    }
  }

  reorder(items) {
    if (items.length < 2) {
      return;
    }
    const win = owner(items[0]) ?? owner(this.itemTabs(items[0])[0]);
    const current = items.slice().sort((a, b) => {
      const at = this.itemTabs(a)[0];
      const bt = this.itemTabs(b)[0];
      return (at?.index ?? 0) - (bt?.index ?? 0);
    });
    // Replace only selected sibling slots. Unselected siblings stay in place.
    const container = items[0].parentElement;
    const siblings = container ? Array.from(container.children) : current;
    const selected = new Set(items);
    let next = 0;
    const desired = siblings.map(item =>
      selected.has(item) ? items[next++] : item
    );
    const relevant = desired.filter(
      item =>
        item &&
        !item.hasAttribute("zen-empty-tab") &&
        (selected.has(item) || item.localName === "tab" || item.tabs)
    );
    for (let i = relevant.length - 2; i >= 0; i--) {
      if (relevant[i].nextElementSibling !== relevant[i + 1]) {
        win.gBrowser.moveTabBefore(relevant[i], relevant[i + 1]);
      }
    }
  }

  async moveUnit(unit, target, operation) {
    const source = owner(unit) ?? owner(this.itemTabs(unit)[0]);
    const oldTabs = this.itemTabs(unit);
    const originalPins = oldTabs.map(tab => ({
      mode: pinMode(tab.pinned, tab.hasAttribute("zen-essential")),
      state: jsonClone(tab._zenPinnedInitialState ?? null),
    }));
    let moved = unit;
    if (source !== target.win) {
      if (unit.isZenFolder) {
        // Firefox's adoptTabGroup flattens nested Zen folders. Preserve the tree.
        moved = target.win.gZenFolders.createFolder([], {
          id: unit.id,
          label: unit.label,
          workspaceId: target.spaceId,
          collapsed: unit.collapsed,
          renameFolder: false,
          isLiveFolder: unit.isLiveFolder,
        });
        operation.createdGroups.push({
          windowId: this.service.windowId(target.win),
          groupId: moved.id,
        });
        if (unit.iconURL) {
          target.win.gZenFolders.setFolderUserIcon(moved, unit.iconURL);
        }
        for (const child of Array.from(unit.allItems).filter(
          item => !item.hasAttribute("zen-empty-tab")
        )) {
          await this.moveUnit(
            child,
            { ...target, folder: moved, anchor: null },
            operation
          );
        }
        await unit.delete();
      } else if (unit.tabs) {
        moved = target.win.gBrowser.adoptTabGroup(unit, {
          tabIndex: target.win.gBrowser.tabs.length,
          selectTab: false,
          closeWindowWithLastTab: false,
        });
        if (moved) {
          operation.createdGroups.push({
            windowId: this.service.windowId(target.win),
            groupId: moved.id,
          });
        }
      } else {
        moved = target.win.gBrowser.adoptTab(unit, {
          tabIndex: target.win.gBrowser.tabs.length,
          selectTab: false,
          closeWindowWithLastTab: false,
          spaceId: target.spaceId ?? target.win.gZenWorkspaces.activeWorkspace,
        });
      }
      requireValue(
        moved,
        "adoption_failed",
        "Native browser could not adopt the selected item"
      );
      const newTabs = this.itemTabs(moved);
      oldTabs.forEach((tab, index) => {
        if (!newTabs[index]) {
          return;
        }
        operation.idMap.set(
          this.service.tabId(tab),
          this.service.tabId(newTabs[index])
        );
        // adoptTab determines pinning from insertion index. Preserve the source
        // semantics and canonical pin URL even when destination has normal tabs.
        const pin = originalPins[index];
        if (!moved.isZenFolder && !moved.tabs) {
          this.browser.setPinMode(target.win, newTabs[index], pin.mode);
        }
        if (pin.state) {
          this.setPinnedState(newTabs[index], pin.state);
        }
      });
    }
    if (target.spaceId) {
      if (moved.isZenFolder) {
        target.win.gZenFolders.changeFolderToSpace(moved, target.spaceId, {
          hasDndSwitch: true,
        });
      } else if (moved.tabs) {
        target.win.gBrowser.zenHandleTabMove(moved, () => {
          for (const tab of this.itemTabs(moved)) {
            tab.setAttribute("zen-workspace-id", target.spaceId);
          }
          const root = target.win.gZenWorkspaces.workspaceElement(
            target.spaceId
          );
          (moved.pinned
            ? root.pinnedTabsContainer
            : root.tabsContainer
          ).appendChild(moved);
        });
      } else {
        target.win.gZenWorkspaces.moveTabToWorkspace(moved, target.spaceId);
      }
    }
    if (target.folder) {
      if (moved.isZenFolder) {
        this.browser.nestFolder(target.win, moved, target.folder);
      } else if (moved.tabs) {
        const members = this.itemTabs(moved);
        const definition = {
          id: moved.id,
          label: moved.label,
          color: moved.color,
          forSplitView: moved.hasAttribute("split-view-group"),
        };
        for (const tab of members) {
          target.win.gBrowser.pinTab(tab);
        }
        if (!this.browser.allGroups(target.win).includes(moved)) {
          moved = target.win.gBrowser.addTabGroup(members, {
            ...definition,
            insertBefore: members[0],
          });
        } else {
          moved.addTabs(members);
        }
        target.win.gBrowser.zenHandleTabMove(moved, () =>
          target.folder.groupContainer.appendChild(moved)
        );
      } else {
        target.win.gBrowser.pinTab(moved);
        target.folder.addTabs([moved]);
      }
    } else if (moved.isZenFolder && (target.spaceId || source !== target.win)) {
      const root = target.win.gZenWorkspaces.workspaceElement(
        target.spaceId ?? moved.getAttribute("zen-workspace-id")
      ).pinnedTabsContainer;
      target.win.gBrowser.zenHandleTabMove(moved, () =>
        root.insertBefore(moved, root.lastChild)
      );
    } else if (target.root && moved.group) {
      target.win.gBrowser.ungroupTab(moved);
    }
    const members = this.itemTabs(moved);
    requireValue(
      members.every(
        tab =>
          owner(tab) === target.win &&
          (!target.spaceId ||
            tab.getAttribute("zen-workspace-id") === target.spaceId)
      ),
      "placement_failed",
      "Native placement did not reach the requested window and Space"
    );
    if (target.folder) {
      requireValue(
        moved.group === target.folder,
        "placement_failed",
        "Native placement did not reach the requested folder"
      );
    }
    return moved;
  }

  async openTabs(plan, operation, signal) {
    const source = this.browser.window(plan.args.windowId);
    const target = this.validatePlacement(plan.args, [], source);
    let anchor = target.anchor;
    for (const entry of plan.open) {
      abort(signal);
      try {
        let tab =
          plan.args.reuse === "url" &&
          this.tabs(target.win).find(value => {
            const state = this.descriptor(value);
            return (
              state.url === entry.url &&
              state.containerId === entry.containerId &&
              state.spaceId === entry.spaceId
            );
          });
        if (tab) {
          operation.outcomes.push({
            tabId: this.service.tabId(tab),
            status: "reused",
          });
          continue;
        }
        tab = target.win.gBrowser.addTab(entry.url, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          userContextId: entry.containerId,
          createLazyBrowser: plan.args.lazy ?? false,
          skipAnimation: true,
          skipRoute: true,
          zenWorkspaceId: entry.spaceId,
        });
        const id = this.service.tabId(tab);
        operation.createdIds.push(id);
        target.win.gZenWorkspaces.moveTabToWorkspace(tab, entry.spaceId);
        if (entry.title !== undefined) {
          this.rename(tab, entry.title);
        }
        if (target.folder) {
          target.win.gBrowser.pinTab(tab);
          target.folder.addTabs([tab]);
        }
        if (anchor) {
          if (plan.args.beforeId) {
            target.win.gBrowser.moveTabBefore(tab, anchor);
          } else {
            target.win.gBrowser.moveTabAfter(tab, anchor);
            anchor = tab;
          }
        }
        // Native background insertion can prepend each new tab in an inactive
        // Space. Use the first new tab as a stable anchor for the remaining
        // entries so their final order follows the supplied URL list.
        anchor ??= tab;
        operation.outcomes.push({ tabId: id, status: "opened" });
      } catch (error) {
        operation.outcomes.push({
          url: entry.url,
          status: "failed",
          error: errorInfo(error),
        });
      }
    }
  }

  rename(tab, title) {
    requireValue(
      typeof title === "string" && title.length <= 1000,
      "invalid_title",
      "Title must be a string of at most 1000 characters"
    );
    const text = title.replace(/\s+/g, " ").trim();
    if (text) {
      tab.zenStaticLabel = text;
      owner(tab).gBrowser._setTabLabel(tab, text, {
        _zenChangeLabelFlag: true,
      });
    } else {
      delete tab.zenStaticLabel;
      owner(tab).gBrowser.setTabTitle(tab);
    }
  }

  setPinnedState(tab, state) {
    const win = owner(tab);
    if (win.gZenWindowSync) {
      win.gZenWindowSync.setPinnedInitialState(tab, state.entry, state.image);
    } else {
      // Independent windows have no synchronization manager. Their canonical
      // pin state belongs to this tab, without propagating to synced windows.
      tab._zenPinnedInitialState = jsonClone(state);
    }
  }

  async replacePinnedState(tab) {
    const win = owner(tab);
    if (win.gZenWindowSync) {
      await win.gZenWindowSync.setPinnedTabState(tab);
      return;
    }
    if (tab.linkedPanel && !tab.hasAttribute("pending")) {
      await lazy.TabStateFlusher.flush(tab.linkedBrowser);
    }
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    const index = (state.index || state.entries?.length || 1) - 1;
    const entry = state.entries?.[index] ?? {};
    this.setPinnedState(tab, {
      entry: {
        url: entry.url ?? this.descriptor(tab).url,
        title: entry.title ?? tab.label,
      },
      image: tab.getAttribute("image"),
    });
  }

  async pinAction(tab, args, signal) {
    const win = owner(tab);
    requireValue(
      tab.pinned,
      "not_pinned",
      "Pin action requires pinned tabs or Essentials"
    );
    switch (args.pinAction) {
      case "reset": {
        const expected = tab._zenPinnedInitialState?.entry?.url;
        requireValue(
          expected,
          "missing_saved_url",
          "Pin has no canonical saved URL"
        );
        win.gZenPinnedTabManager.resetPinnedTab(tab);
        await this.browser.waitFor(
          () => this.descriptor(tab).url === expected,
          signal,
          "Pin reset has not reached its saved URL; inspect navigation before retrying"
        );
        break;
      }
      case "replace":
        await this.replacePinnedState(tab);
        win.gZenPinnedTabManager.resetPinChangedUrl(tab);
        break;
      case "setUrl":
        Services.io.newURI(args.url);
        this.setPinnedState(tab, {
          entry: { url: args.url, title: tab.zenStaticLabel },
          image: tab.getAttribute("image"),
        });
        break;
      case "rename":
        this.rename(tab, args.title);
        break;
      case "unload":
        requireValue(
          !tab.linkedPanel || (await win.gBrowser.discardBrowser(tab, true)),
          "discard_rejected",
          "Native browser kept this active or media tab loaded"
        );
        break;
      default:
        throw new McpToolError("invalid_action", "Unknown pin operation");
    }
  }

  async pins(args, client, signal) {
    const tabs = await this.resolveTargets(args, client, signal);
    if (args.action === "list") {
      return {
        ...paginate(
          tabs.filter(tab => tab.pinned).map(tab => this.descriptor(tab)),
          args
        ),
      };
    }
    requireValue(
      tabs.every(tab => tab.pinned),
      "not_pinned",
      "All selected tabs must be pinned; use filter.pinned:true"
    );
    requireValue(
      ["reset", "replace", "setUrl", "rename", "unload"].includes(args.action),
      "invalid_action",
      "Unknown pin action"
    );
    if (args.action === "setUrl") {
      requireValue(
        typeof args.url === "string",
        "invalid_url",
        "setUrl requires url"
      );
      Services.io.newURI(args.url);
    }
    if (args.action === "rename") {
      requireValue(
        typeof args.title === "string",
        "invalid_title",
        "rename requires title"
      );
    }
    const win = this.browser.window(args.windowId);
    const planId = this.put(
      this.plans,
      client,
      {
        args: { ...args, action: "pins", pinAction: args.action },
        ids: tabs.map(tab => this.service.tabId(tab)),
        windowIds: [args.windowId],
        signature: this.signature([win]),
      },
      SELECTION_TTL
    );
    return this.apply({ planId }, client, signal);
  }

  async restoreClosed(source, operation, signal) {
    this.reconcileClose(source);
    const closedTabIds = source.outcomes
      .filter(item => item.status === "closed")
      .map(item => item.tabId);
    for (const id of closedTabIds) {
      abort(signal);
      if (source.restoredIds.includes(id)) {
        continue;
      }
      const layout = source.before.find(value =>
        value.items.some(item => item.tabId === id)
      );
      const original = layout.items.find(item => item.tabId === id);
      const win = this.browser.window(layout.windowId);
      this.browser.validateSpace(win, original.spaceId);
      this.browser.validateContainer(original.containerId);
      let tab;
      try {
        tab = win.gBrowser.addTab("about:blank", {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          userContextId: original.containerId,
          createLazyBrowser: true,
          skipAnimation: true,
          skipRoute: true,
          zenWorkspaceId: original.spaceId,
        });
        const newId = this.service.tabId(tab);
        // Mark ownership immediately: a native failure must not cause a duplicate retry.
        operation.createdIds.push(newId);
        operation.idMap.set(id, newId);
        source.restoredIds.push(id);
        lazy.SessionStore.setTabState(tab, source.sessions.get(id));
        operation.outcomes.push({
          originalTabId: id,
          tabId: newId,
          status: "restored",
        });
      } catch (error) {
        operation.outcomes.push({
          originalTabId: id,
          ...(tab ? { tabId: this.service.tabId(tab) } : {}),
          status: "failed",
          error: errorInfo(error),
        });
      }
    }
    await this.restoreLayout(
      source.before,
      operation.idMap,
      new Set(operation.idMap.keys()),
      signal,
      { preserveOthers: true }
    );
  }

  restoreTabLayout(win, tab, item, groups) {
    const mode = pinMode(item.pinned, item.essential);
    if (pinMode(tab.pinned, tab.hasAttribute("zen-essential")) !== mode) {
      this.browser.setPinMode(win, tab, mode);
    }
    if (!item.essential && this.descriptor(tab).spaceId !== item.spaceId) {
      win.gZenWorkspaces.moveTabToWorkspace(tab, item.spaceId);
    }
    if (item.groupId && groups.get(item.groupId)) {
      const group = groups.get(item.groupId);
      if (tab.group !== group) {
        group.addTabs([tab]);
      }
    } else if (!item.groupId && tab.group) {
      win.gBrowser.ungroupTab(tab);
    }
    if ((tab.zenStaticLabel ?? "") !== (item.customTitle ?? "")) {
      this.rename(tab, item.customTitle ?? "");
    }
    if (
      item.pinnedInitialState &&
      JSON.stringify(tab._zenPinnedInitialState ?? null) !==
        JSON.stringify(item.pinnedInitialState)
    ) {
      this.setPinnedState(tab, item.pinnedInitialState);
    }
  }

  async restoreLayout(
    layouts,
    idMap,
    only,
    signal,
    { preserveOthers = false, groupIds = [] } = {}
  ) {
    for (const layout of layouts) {
      const win = this.browser.window(layout.windowId);
      const selected = layout.items.filter(
        item => !only || only.has(item.tabId)
      );
      const groups = new Map(
        this.browser.allGroups(win).map(group => [group.id, group])
      );
      const needed = groupsNeededForRestore(layout, selected, groupIds);
      const ensure = definition => {
        const parent =
          definition.parentGroupId &&
          ensure(
            layout.groups.find(
              group => group.groupId === definition.parentGroupId
            )
          );
        let group = groups.get(definition.groupId);
        if (group) {
          if (preserveOthers) {
            requireValue(
              group.getAttribute("zen-workspace-id") === definition.spaceId &&
                (group.group?.id ?? null) === definition.parentGroupId,
              "recovery_conflict",
              "An original folder changed placement after closing; recovery will not relocate it"
            );
          } else if (
            group.getAttribute("zen-workspace-id") !== definition.spaceId ||
            (group.group?.id ?? null) !== definition.parentGroupId
          ) {
            if (definition.kind === "folder") {
              win.gZenFolders.changeFolderToSpace(group, definition.spaceId, {
                hasDndSwitch: true,
              });
            } else {
              group.setAttribute("zen-workspace-id", definition.spaceId);
              for (const tab of this.groupTabs(group)) {
                tab.setAttribute("zen-workspace-id", definition.spaceId);
              }
            }
            if (parent) {
              if (definition.kind === "folder") {
                this.browser.nestFolder(win, group, parent);
              } else {
                win.gBrowser.zenHandleTabMove(group, () =>
                  parent.groupContainer.appendChild(group)
                );
              }
            } else {
              const workspace = win.gZenWorkspaces.workspaceElement(
                definition.spaceId
              );
              const root =
                definition.kind === "folder" || group.pinned
                  ? workspace.pinnedTabsContainer
                  : workspace.tabsContainer;
              win.gBrowser.zenHandleTabMove(group, () =>
                root.insertBefore(group, root.lastChild)
              );
            }
          }
          return group;
        }
        if (definition.kind === "folder") {
          group = win.gZenFolders.createFolder([], {
            id: definition.groupId,
            label: definition.name,
            workspaceId: definition.spaceId,
            collapsed: definition.collapsed,
            renameFolder: false,
            isLiveFolder: definition.isLiveFolder,
          });
          if (definition.icon) {
            win.gZenFolders.setFolderUserIcon(group, definition.icon);
          }
          if (parent) {
            this.browser.nestFolder(win, group, parent);
          }
        } else {
          // addTabGroup requires members; created after tab restoration below.
          return null;
        }
        groups.set(definition.groupId, group);
        return group;
      };
      for (const definition of layout.groups.filter(group =>
        needed.has(group.groupId)
      )) {
        ensure(definition);
      }
      const native = [];
      for (const item of selected) {
        abort(signal);
        let tab;
        try {
          tab = this.browser.tab(idMap.get(item.tabId) ?? item.tabId);
        } catch {
          continue;
        }
        if (owner(tab) !== win) {
          tab = win.gBrowser.adoptTab(tab, {
            tabIndex: win.gBrowser.tabs.length,
            selectTab: false,
            closeWindowWithLastTab: false,
            spaceId: item.spaceId,
          });
          requireValue(
            tab,
            "adoption_failed",
            "Undo could not return the tab to its window"
          );
          idMap.set(item.tabId, this.service.tabId(tab));
        }
        this.restoreTabLayout(win, tab, item, groups);
        native.push({ tab, original: item });
      }
      for (const definition of layout.groups.filter(
        group =>
          needed.has(group.groupId) &&
          group.kind !== "folder" &&
          !groups.has(group.groupId)
      )) {
        const tabs = native
          .filter(value => value.original.groupId === definition.groupId)
          .map(value => value.tab);
        if (tabs.length) {
          groups.set(
            definition.groupId,
            win.gBrowser.addTabGroup(tabs, {
              id: definition.groupId,
              label: definition.name,
              color: definition.color,
              forSplitView: definition.kind === "split",
              insertBefore: tabs[0],
            })
          );
        }
      }
      // Both folder units and leaf-tab order are part of a sidebar snapshot.
      for (const order of layout.orders ?? []) {
        const values = order.map(ref => {
          try {
            return ref.group
              ? this.group(win, ref.id)
              : this.browser.tab(idMap.get(ref.id) ?? ref.id, win);
          } catch {
            return null;
          }
        });
        if (!preserveOthers) {
          this.reorder(values.filter(Boolean));
          continue;
        }
        for (let i = values.length - 1; i >= 0; i--) {
          const item = values[i];
          if (
            !item ||
            !this.itemTabs(item).some(tab =>
              [...idMap.values()].includes(this.service.tabId(tab))
            )
          ) {
            continue;
          }
          const next = values
            .slice(i + 1)
            .find(value => value && value.parentElement === item.parentElement);
          const previous = values
            .slice(0, i)
            .findLast(
              value => value && value.parentElement === item.parentElement
            );
          if (next) {
            win.gBrowser.moveTabBefore(item, next);
          } else if (previous) {
            win.gBrowser.moveTabAfter(item, previous);
          }
        }
      }
    }
  }

  async undo(args, client, signal) {
    const operation = this.get(
      this.operations,
      args.operationId,
      client,
      "operation"
    );
    this.reconcileClose(operation);
    requireValue(
      !operation.running,
      "operation_running",
      "Wait for this operation to settle"
    );
    if (operation.undone) {
      return {
        operationId: args.operationId,
        undone: true,
        outcomes: operation.undoOutcomes ?? [],
      };
    }
    requireValue(
      operation.undoable,
      "not_undoable",
      "This operation has no completed effects to undo"
    );
    const windows = operation.windowIds.map(id => this.browser.window(id));
    requireValue(
      this.signature(windows) === operation.afterSignature,
      "undo_conflict",
      "Tabs changed after this operation; undo will not overwrite later work"
    );
    const focus = this.focus(windows);
    operation.running = true;
    const recovery = {
      outcomes: [],
      createdIds: [],
      idMap: new Map(operation.idMap),
    };
    try {
      if (operation.action === "close") {
        await this.restoreClosed(operation, recovery, signal);
      } else if (operation.action === "open" || operation.action === "reopen") {
        for (const id of operation.createdIds) {
          abort(signal);
          const tab = this.browser.tab(id);
          owner(tab).gBrowser.removeTab(tab, {
            animate: false,
            closeWindowWithLastTab: false,
          });
          await this.browser.waitFor(
            () => !this.service.listTabs(owner(tab)).includes(tab),
            signal,
            "Undo close is blocked",
            1500
          );
          recovery.outcomes.push({ tabId: id, status: "closed" });
        }
      } else {
        const changed = new Set(operation.affectedIds);
        await this.restoreLayout(
          operation.before,
          recovery.idMap,
          changed,
          signal,
          { groupIds: operation.affectedGroups }
        );
        // Remove only empty shells this operation itself created in the target.
        for (const created of [...(operation.createdGroups ?? [])].reverse()) {
          const win = this.browser.window(created.windowId);
          const group = this.browser
            .allGroups(win)
            .find(item => item.id === created.groupId);
          if (group && !this.groupTabs(group).length) {
            if (group.isZenFolder) {
              await group.delete();
            } else {
              group.remove();
            }
          }
        }
        if (operation.action === "discard" || operation.action === "pins") {
          for (const layout of operation.before) {
            for (const original of layout.items.filter(item =>
              changed.has(item.tabId)
            )) {
              const tab = this.browser.tab(
                recovery.idMap.get(original.tabId) ?? original.tabId
              );
              if (original.loaded && !tab.linkedPanel) {
                owner(tab).gBrowser.insertBrowser(tab);
              }
              if (
                operation.action === "pins" &&
                this.descriptor(tab).url !== original.url
              ) {
                tab.linkedBrowser.loadURI(Services.io.newURI(original.url), {
                  triggeringPrincipal:
                    Services.scriptSecurityManager.getSystemPrincipal(),
                });
              }
            }
          }
        }
      }
      operation.undone =
        operation.action !== "close" || !this.hasPendingClose(operation);
      operation.undoOutcomes = recovery.outcomes;
      return {
        operationId: args.operationId,
        undone: operation.undone,
        outcomes: recovery.outcomes,
      };
    } finally {
      operation.running = false;
      await this.restoreFocus(focus);
      operation.afterSignature = this.signature(windows);
      for (const win of windows) {
        this.browser.changed(win, null);
      }
    }
  }
}
