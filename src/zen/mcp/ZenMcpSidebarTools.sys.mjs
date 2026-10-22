// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  makeTool,
  requireValue,
  schema,
  uuid,
} from "./ZenMcpUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  gZenSpaceRoutingManager:
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs",
  ZenLiveFoldersManager:
    "resource:///modules/zen/ZenLiveFoldersManager.sys.mjs",
});

const MAX_DEFINITIONS = 50;
const MAX_FILE_BYTES = 256 * 1024;
const HTML = "http://www.w3.org/1999/xhtml";
const EVENTS = new Set([
  "TabOpen",
  "LocationChange",
  "TabAttrModified",
  "TabPinned",
  "TabUnpinned",
  "MediaPlaybackChange",
]);
const ACTIONS = new Set(["move", "sort", "pin", "discard", "close", "open"]);
const AUTO_ACTIONS = new Set(["move", "sort", "pin", "discard"]);
const TRANSIENT = new Set([
  "instanceId",
  "windowId",
  "destinationWindowId",
  "tabIds",
  "selectionId",
  "planId",
  "operationId",
  "beforeId",
  "afterId",
  "order",
]);

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function ruleFingerprint(item) {
  // Clock-like position and ordering changed by our own placement are not new
  // input. A final page title/URL/media state must always trigger a fresh pass.
  return JSON.stringify(item ?? null, (key, value) =>
    ["position", "index", "lastAccessed"].includes(key) ? undefined : value
  );
}

function checkDurable(value, depth = 0) {
  requireValue(
    depth <= 12,
    "invalid_definition",
    "Saved definition is too deeply nested"
  );
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    requireValue(
      !TRANSIENT.has(key),
      "transient_target",
      `Saved definitions cannot contain ${key}; use stable Space/folder/domain filters`
    );
    checkDurable(item, depth + 1);
  }
}

export function validateDefinition(kind, input, existingId) {
  requireValue(
    plain(input),
    "invalid_definition",
    "definition must be an object"
  );
  const allowed = new Set([
    "name",
    "filter",
    "filterLambda",
    "enabled",
    ...(kind === "rules" ? ["operation", "automatic", "events"] : []),
  ]);
  for (const key of Object.keys(input)) {
    requireValue(
      allowed.has(key),
      "invalid_definition",
      `Unknown definition property: ${key}`
    );
  }
  requireValue(
    typeof input.name === "string" &&
      !!input.name.trim().length &&
      input.name.length <= 100,
    "invalid_name",
    "name must contain 1–100 characters"
  );
  requireValue(
    input.filter === undefined || plain(input.filter),
    "invalid_filter",
    "filter must be an object"
  );
  requireValue(
    input.filterLambda === undefined ||
      (typeof input.filterLambda === "string" &&
        input.filterLambda.length <= 8192),
    "invalid_lambda",
    "filterLambda must be a bounded JavaScript function"
  );
  requireValue(
    input.enabled === undefined || typeof input.enabled === "boolean",
    "invalid_definition",
    "enabled must be boolean"
  );
  checkDurable(input);
  const result = {
    id: existingId ?? uuid(),
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    filter: structuredClone(input.filter ?? {}),
    ...(input.filterLambda ? { filterLambda: input.filterLambda } : {}),
  };
  if (kind === "rules") {
    requireValue(
      plain(input.operation) && ACTIONS.has(input.operation.action),
      "invalid_operation",
      "A rule needs a move, sort, pin, discard, close or open operation"
    );
    requireValue(
      input.automatic === undefined || typeof input.automatic === "boolean",
      "invalid_definition",
      "automatic must be boolean"
    );
    requireValue(
      !input.automatic || AUTO_ACTIONS.has(input.operation.action),
      "invalid_automatic_action",
      "Automatic rules support move, sort, pin and discard only"
    );
    requireValue(
      input.operation.select !== true,
      "invalid_operation",
      "Saved rules preserve the active tab"
    );
    const events = input.events ?? ["TabOpen", "LocationChange"];
    requireValue(
      Array.isArray(events) &&
        !!events.length &&
        events.every(event => EVENTS.has(event)),
      "invalid_events",
      "Choose supported browser events"
    );
    result.operation = structuredClone(input.operation);
    result.automatic = input.automatic ?? false;
    result.events = [...new Set(events)];
  }
  return result;
}

export class ZenMcpSidebarTools {
  constructor(service) {
    this.service = service;
    this.data = { version: 1, views: [], rules: [] };
    this.file = PathUtils.join(PathUtils.profileDir, "zen-mcp-workspace.json");
    this.windows = new Map();
    this.pending = new Map();
    this.lastRuns = new Map();
    this.history = [];
    this.busy = false;
    this.ownTabs = new Set();
    this.stopped = false;
    this.loadError = null;
    this.tools = [
      makeTool(
        "zen_sidebar_views",
        "Save named tab filters as live sidebar collections, list/delete them, or query a collection without moving its tabs. Definitions persist in this profile; tab/window/selection IDs cannot be saved.",
        {
          action: schema.enum("list", "save", "delete", "query", "reorder"),
          order: schema.strings,
          viewId: schema.string,
          definition: schema.object,
          windowId: schema.string,
          limit: schema.integer,
          cursor: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_sidebar_rules",
        "Save deterministic tab placement rules. Manual preview returns a normal plan; run applies it. Automatic rules are opt-in, process listed events, preserve focus, and use the first matching rule per tab. No automatic close/open. Use stable Space/folder IDs.",
        {
          action: schema.enum(
            "list",
            "save",
            "delete",
            "preview",
            "run",
            "undo",
            "reorder"
          ),
          order: schema.strings,
          ruleId: schema.string,
          definition: schema.object,
          windowId: schema.string,
          operationId: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_native_routes",
        "Read or edit Zen's existing native link routing rules (contains/equal-to/regex). These are independent from saved tab placement rules and retain their native first-match semantics.",
        {
          action: schema.enum("list", "save", "delete"),
          routeId: schema.string,
          reference: schema.string,
          matchType: schema.enum("contains", "equal-to", "regex"),
          openIn: schema.string,
        },
        ["action"]
      ),
      makeTool(
        "zen_live_folders",
        "List Zen's existing RSS/GitHub live folder providers or explicitly refresh a folder. Live collections are views of existing tabs; native live folders fetch provider content.",
        {
          action: schema.enum("list", "refresh"),
          folderId: schema.string,
        },
        ["action"]
      ),
    ];
  }

  getTools() {
    return this.tools;
  }

  async init() {
    try {
      if (!(await IOUtils.exists(this.file))) {
        return;
      }
      requireValue(
        (await IOUtils.stat(this.file)).size <= MAX_FILE_BYTES,
        "invalid_store",
        "Saved workspace definitions are too large"
      );
      const stored = await IOUtils.readJSON(this.file);
      requireValue(
        stored?.version === 1,
        "invalid_store",
        "Unsupported workspace definitions version"
      );
      const next = { version: 1, views: [], rules: [] };
      for (const kind of ["views", "rules"]) {
        requireValue(
          Array.isArray(stored[kind]) && stored[kind].length <= MAX_DEFINITIONS,
          "invalid_store",
          "Invalid saved definitions"
        );
        const ids = new Set();
        for (const entry of stored[kind]) {
          const { id, ...definition } = entry;
          requireValue(
            typeof id === "string" && id.length <= 100 && !ids.has(id),
            "invalid_store",
            "Invalid or repeated definition ID"
          );
          ids.add(id);
          next[kind].push(validateDefinition(kind, definition, id));
        }
      }
      this.data = next;
    } catch {
      this.loadError =
        "Saved workspace definitions could not be read; the file was preserved. Repair it before saving.";
    }
  }

  async persist(next) {
    requireValue(
      !this.loadError,
      "workspace_store_unavailable",
      this.loadError
    );
    requireValue(
      new TextEncoder().encode(JSON.stringify(next)).length <= MAX_FILE_BYTES,
      "store_limit",
      "Saved definitions exceed the profile limit"
    );
    await IOUtils.writeJSON(this.file, next, {
      tmpPath: `${this.file}.tmp`,
      flush: true,
    });
    await IOUtils.setPermissions(this.file, 0o600, false);
    this.data = next;
    this.lastRuns.clear();
    this.refreshAll();
  }

  definition(kind, id) {
    const result = this.data[kind].find(item => item.id === id);
    requireValue(
      result,
      "unknown_definition",
      "Saved collection or rule was not found"
    );
    return result;
  }

  async execute(name, args, client, signal) {
    let result;
    if (name === "zen_native_routes") {
      result = this.routes(args);
    } else if (name === "zen_live_folders") {
      result = await this.liveFolders(args);
    } else {
      const kind = name === "zen_sidebar_views" ? "views" : "rules";
      const id = kind === "views" ? args.viewId : args.ruleId;
      if (args.action === "list") {
        result = {
          items: structuredClone(this.data[kind]),
          loadError: this.loadError,
          ...(kind === "rules"
            ? { recentRuns: structuredClone(this.history) }
            : {}),
        };
      } else if (args.action === "reorder") {
        requireValue(
          Array.isArray(args.order) &&
            args.order.length === this.data[kind].length &&
            new Set(args.order).size === args.order.length &&
            args.order.every(value =>
              this.data[kind].some(item => item.id === value)
            ),
          "invalid_order",
          "order must contain every definition ID exactly once"
        );
        const next = structuredClone(this.data);
        next[kind] = args.order.map(value =>
          next[kind].find(item => item.id === value)
        );
        await this.persist(next);
        result = { items: next[kind] };
      } else if (args.action === "save") {
        if (id !== undefined) {
          this.definition(kind, id);
        }
        requireValue(
          id || this.data[kind].length < MAX_DEFINITIONS,
          "definition_limit",
          "Too many saved definitions"
        );
        const definition = validateDefinition(kind, args.definition, id);
        // Validate filters/lambdas against real descriptors before accepting them.
        const win = args.windowId
          ? this.service.getWindow(args.windowId)
          : this.service.getWindows()[0];
        requireValue(
          win,
          "closed_window",
          "A normal browser window is required to validate the definition"
        );
        const windowId = this.service.windowId(win);
        const query = await this.service.workspaceTools.query(
          {
            windowId,
            filter: definition.filter,
            filterLambda: definition.filterLambda,
            limit: 1,
          },
          client,
          signal
        );
        if (kind === "rules") {
          const validationPlan = await this.makePlan(
            definition,
            windowId,
            client,
            signal,
            query.selectionId
          );
          this.service.workspaceTools.releasePlan(
            validationPlan.planId,
            client
          );
        }
        const next = structuredClone(this.data);
        const index = next[kind].findIndex(item => item.id === definition.id);
        if (index < 0) {
          next[kind].push(definition);
        } else {
          next[kind][index] = definition;
        }
        await this.persist(next);
        result = { definition };
      } else if (args.action === "delete") {
        this.definition(kind, id);
        const next = structuredClone(this.data);
        next[kind] = next[kind].filter(item => item.id !== id);
        await this.persist(next);
        result = { deleted: id };
      } else if (kind === "views" && args.action === "query") {
        const view = this.definition(kind, id);
        result = await this.service.workspaceTools.query(
          {
            windowId: args.windowId,
            filter: view.filter,
            filterLambda: view.filterLambda,
            limit: args.limit,
            cursor: args.cursor,
          },
          client,
          signal
        );
      } else if (kind === "rules" && ["preview", "run"].includes(args.action)) {
        const rule = this.definition(kind, id);
        const plan = await this.makePlan(rule, args.windowId, client, signal);
        result =
          args.action === "preview"
            ? plan
            : await this.withOwnTabs(
                (plan.items ?? []).map(item => item.tabId),
                () =>
                  this.service.workspaceTools.execute(
                    "zen_tabs_apply",
                    {
                      instanceId: this.service.instanceId,
                      planId: plan.planId,
                    },
                    client,
                    signal
                  )
              );
      } else if (kind === "rules" && args.action === "undo") {
        const record = this.history.find(
          item => item.operationId === args.operationId && item.undoAvailable
        );
        requireValue(
          record,
          "unknown_operation",
          "Automatic rule receipt is missing or expired; manual runs use zen_tabs_undo"
        );
        result = await this.withOwnTabs(record.affectedTabIds ?? [], () =>
          this.service.workspaceTools.execute(
            "zen_tabs_undo",
            {
              instanceId: this.service.instanceId,
              operationId: args.operationId,
            },
            { id: "zen-sidebar-rules" },
            signal
          )
        );
        record.undoAvailable = false;
        for (const tabId of record.affectedTabIds ?? []) {
          try {
            this.lastRuns.set(`${record.ruleId}:${tabId}`, {
              time: Date.now(),
              fingerprint: ruleFingerprint(
                this.service.workspaceTools.descriptor(
                  this.service.getTab(tabId)
                )
              ),
            });
          } catch {}
        }
        this.releaseRecord(record);
      } else {
        throw new McpToolError(
          "invalid_action",
          "Unsupported collection or rule action"
        );
      }
    }
    return { instanceId: this.service.instanceId, ...result };
  }

  async makePlan(rule, windowId, client, signal, selectionId) {
    const selection =
      selectionId ??
      (
        await this.service.workspaceTools.query(
          {
            windowId,
            filter: rule.filter,
            filterLambda: rule.filterLambda,
            limit: 1,
          },
          client,
          signal
        )
      ).selectionId;
    return this.service.workspaceTools.execute(
      "zen_tabs_plan",
      {
        ...rule.operation,
        instanceId: this.service.instanceId,
        windowId,
        ...(rule.operation.action === "open" ? {} : { selectionId: selection }),
        select: false,
      },
      client,
      signal
    );
  }

  routes(args) {
    const manager = lazy.gZenSpaceRoutingManager;
    if (args.action === "list") {
      return {
        items: manager.getAllRoutes(),
        defaultExternal: manager.getDefaultExternalRoute(),
      };
    }
    if (args.routeId !== undefined) {
      requireValue(
        manager.getRoute(args.routeId),
        "unknown_route",
        "Native route was not found"
      );
    }
    if (args.action === "delete") {
      requireValue(args.routeId, "missing_route", "routeId is required");
      manager.removeRoute(args.routeId);
      manager.saveRoutes();
      return { deleted: args.routeId };
    }
    requireValue(
      args.action === "save" &&
        typeof args.reference === "string" &&
        !!args.reference.trim().length &&
        args.reference.length <= 4096,
      "invalid_route",
      "A bounded reference is required"
    );
    const matchType = args.matchType ?? "contains";
    requireValue(
      ["contains", "equal-to", "regex"].includes(matchType),
      "invalid_route",
      "Unsupported matchType"
    );
    if (matchType === "regex") {
      try {
        new RegExp(args.reference);
      } catch {
        throw new McpToolError("invalid_regex", "Route regex is invalid");
      }
    }
    const openIn = args.openIn ?? "most-recent-space";
    requireValue(
      openIn === "most-recent-space" ||
        this.service
          .getWindows()
          .some(win => win.gZenWorkspaces.getWorkspaceFromId(openIn)),
      "unknown_space",
      "Destination Space was not found"
    );
    const route = args.routeId
      ? manager.getRoute(args.routeId)
      : manager.createNewRoute();
    Object.assign(route, { reference: args.reference, matchType, openIn });
    manager.updateRoute(route);
    manager.saveRoutes();
    return { route };
  }

  async liveFolders(args) {
    const manager = lazy.ZenLiveFoldersManager;
    if (args.action === "refresh") {
      const folder = manager.getFolder(args.folderId);
      requireValue(
        folder,
        "unknown_folder",
        "Native live folder was not found"
      );
      await folder.refresh();
      return { refreshed: args.folderId };
    }
    requireValue(
      args.action === "list",
      "invalid_action",
      "Expected list or refresh"
    );
    return {
      items: [...manager.liveFolders].map(([id, folder]) => ({
        folderId: id,
        type: folder.constructor.type,
      })),
      providers: [...manager.registry.keys()],
    };
  }

  onBrowserEvent(event) {
    if (this.stopped || !event.windowId) {
      return;
    }
    let win;
    try {
      win = this.service.getWindow(event.windowId);
    } catch {
      return;
    }
    this.scheduleRender(win);
    if (
      this.ownTabs.has(event.tabId) ||
      !EVENTS.has(event.event) ||
      !event.tabId
    ) {
      return;
    }
    // Only title/URL/media observations trigger a rule; our own placement events
    // cannot continuously re-enter the queue. Coalesce repeated native events.
    const key = `${event.windowId}:${event.tabId}`;
    let pending = this.pending.get(key);
    if (!pending) {
      pending = {
        windowId: event.windowId,
        tabId: event.tabId,
        events: new Set(),
      };
      this.pending.set(key, pending);
    }
    pending.events.add(event.event);
    if (this.ruleTimer) {
      return;
    }
    this.ruleTimer = lazy.setTimeout(() => {
      this.ruleTimer = null;
      const changes = [...this.pending.values()];
      this.pending.clear();
      this.service
        .enqueueMutation(() => this.runAutomatic(changes))
        .catch(() => {});
    }, 250);
  }

  async runAutomatic(changes) {
    if (this.stopped || this.loadError) {
      return;
    }
    this.busy = true;
    const client = { id: "zen-sidebar-rules" };
    try {
      for (const change of changes.slice(0, 500)) {
        for (const rule of this.data.rules) {
          if (
            !rule.enabled ||
            !rule.automatic ||
            !rule.events.some(event => change.events.has(event))
          ) {
            continue;
          }
          const key = `${rule.id}:${change.tabId}`;
          try {
            const query = await this.service.workspaceTools.query(
              {
                windowId: change.windowId,
                filter: { all: [rule.filter, { tabIds: [change.tabId] }] },
                filterLambda: rule.filterLambda,
                limit: 1,
              },
              client
            );
            if (!query.total) {
              continue;
            }
            const fingerprint = ruleFingerprint(query.items[0]);
            if (this.lastRuns.get(key)?.fingerprint === fingerprint) {
              break;
            }
            const plan = await this.makePlan(
              rule,
              change.windowId,
              client,
              undefined,
              rule.operation.action === "sort" ? undefined : query.selectionId
            );
            const affectedTabIds = (plan.items ?? []).map(item => item.tabId);
            const result = await this.withOwnTabs(affectedTabIds, () =>
              this.service.workspaceTools.execute(
                "zen_tabs_apply",
                { instanceId: this.service.instanceId, planId: plan.planId },
                client
              )
            );
            let resultingFingerprint = fingerprint;
            try {
              resultingFingerprint = ruleFingerprint(
                this.service.workspaceTools.descriptor(
                  this.service.getTab(change.tabId)
                )
              );
            } catch {}
            this.lastRuns.set(key, {
              time: Date.now(),
              fingerprint: resultingFingerprint,
            });
            this.recordRun(rule.id, {
              operationId: result.operationId,
              summary: result.summary,
              undoAvailable: result.undoable !== false,
              affectedTabIds,
            });
          } catch (error) {
            this.recordRun(rule.id, { error: error.code ?? "rule_failed" });
          }
          // Ordered rules have deterministic first-match semantics.
          break;
        }
      }
      for (const [key, last] of this.lastRuns) {
        if (Date.now() - last.time > 60000) {
          this.lastRuns.delete(key);
        }
      }
    } finally {
      this.busy = false;
      this.refreshAll();
    }
  }

  recordRun(ruleId, result) {
    const record = { ruleId, time: Date.now(), ...result };
    this.history.push(record);
    if (record.operationId && !record.undoAvailable) {
      this.releaseRecord(record);
    }
    const retained = this.history.filter(
      item => item.operationId && item.undoAvailable
    );
    while (retained.length > 20) {
      const oldest = retained.shift();
      this.releaseRecord(oldest);
    }
    if (this.history.length > 50) {
      const removed = this.history.shift();
      if (removed.undoAvailable) {
        this.releaseRecord(removed);
      }
    }
  }

  releaseRecord(record) {
    try {
      this.service.workspaceTools.releaseOperation(record.operationId, {
        id: "zen-sidebar-rules",
      });
    } catch (error) {
      if (error.code !== "unknown_operation") {
        throw error;
      }
    }
    record.undoAvailable = false;
  }

  async withOwnTabs(ids, action) {
    const previous = this.ownTabs;
    this.ownTabs = new Set([...previous, ...ids]);
    try {
      return await action();
    } finally {
      this.ownTabs = previous;
    }
  }

  attachWindow(win) {
    if (this.windows.has(win)) {
      return;
    }
    this.windows.set(win, {
      generation: 0,
      timer: null,
      section: null,
      pages: new Map(),
      controllers: new Map(),
      rendering: false,
      rerender: false,
    });
    this.scheduleRender(win);
  }

  detachWindow(win) {
    const state = this.windows.get(win);
    if (state?.timer) {
      lazy.clearTimeout(state.timer);
    }
    state?.section?.remove();
    for (const remove of state?.controllers?.values() ?? []) {
      remove();
    }
    this.windows.delete(win);
    this.service.workspaceTools?.cleanup(
      `zen-sidebar-views:${this.service.windowId(win)}`
    );
  }

  refreshAll() {
    for (const win of this.windows.keys()) {
      this.scheduleRender(win);
    }
  }

  scheduleRender(win) {
    const state = this.windows.get(win);
    if (!state || this.stopped) {
      return;
    }
    state.generation++;
    if (state.timer || state.rendering) {
      state.rerender = true;
      return;
    }
    state.timer = lazy.setTimeout(async () => {
      state.timer = null;
      state.rendering = true;
      state.rerender = false;
      try {
        await this.render(win);
      } catch {
      } finally {
        state.rendering = false;
        if (state.rerender) {
          this.scheduleRender(win);
        }
      }
    }, 200);
  }

  async render(win) {
    const state = this.windows.get(win);
    if (!state || this.stopped || win.closed) {
      return;
    }
    const generation = state.generation;
    this.watchMedia(win, state);
    const views = this.data.views.filter(view => view.enabled);
    if (!views.length) {
      state.section?.remove();
      state.section = null;
      return;
    }
    const document = win.document;
    win.MozXULElement.insertFTLIfNeeded("browser/zen-mcp-workspace.ftl");
    const anchor = document.getElementById("zen-tabs-wrapper");
    if (!anchor) {
      return;
    }
    const client = { id: `zen-sidebar-views:${this.service.windowId(win)}` };
    const rows = [];
    for (const view of views) {
      if (
        this.stopped ||
        !this.windows.has(win) ||
        generation !== state.generation
      ) {
        return;
      }
      try {
        const result = await this.service.workspaceTools.query(
          {
            windowId: this.service.windowId(win),
            filter: view.filter,
            filterLambda: view.filterLambda,
            limit: 100,
            cursor: state.pages.get(view.id)?.at(-1),
          },
          client
        );
        rows.push({ view, result });
      } catch {
        rows.push({ view, error: true });
      }
    }
    if (
      this.stopped ||
      !this.windows.has(win) ||
      generation !== state.generation
    ) {
      return;
    }
    const expanded = new Set(
      [...(state.section?.querySelectorAll("details[open]") ?? [])].map(
        item => item.dataset.viewId
      )
    );
    const section = document.createElementNS(HTML, "section");
    section.id = "zen-mcp-collections";
    document.l10n.setAttributes(section, "zen-mcp-collections");
    const style = document.createElementNS(HTML, "style");
    style.textContent = `#zen-mcp-collections { flex: 0 0 auto; max-height: 35vh; overflow: auto; padding: 4px 8px; color: inherit; font: menu; }
      #zen-mcp-collections summary { cursor: pointer; padding: 5px 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #zen-mcp-collections button { display: block; width: 100%; border: 0; border-radius: 5px; background: transparent; color: inherit; text-align: start; padding: 5px 10px; font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #zen-mcp-collections button:hover, #zen-mcp-collections button:focus-visible { background: color-mix(in srgb, currentColor 12%, transparent); }
      #zen-mcp-collections small { display: block; padding: 5px 10px; opacity: .7; }`;
    section.append(style);
    const active = document.activeElement;
    const focusedView = state.section?.contains(active)
      ? active.closest("details")?.dataset.viewId
      : null;
    const focusedControl = active?.dataset.tabId ?? active?.dataset.control;
    for (const row of rows) {
      section.append(this.renderCollection(win, state, row, expanded));
    }
    if (state.section) {
      const scrollTop = state.section.scrollTop;
      state.section.replaceWith(section);
      section.scrollTop = scrollTop;
    } else {
      anchor.before(section);
    }
    state.section = section;
    if (focusedView) {
      const details = [...section.querySelectorAll("details")].find(
        item => item.dataset.viewId === focusedView
      );
      const target = [
        ...(details?.querySelectorAll("button, summary") ?? []),
      ].find(
        item => (item.dataset.tabId ?? item.dataset.control) === focusedControl
      );
      (target ?? details?.querySelector("summary"))?.focus({
        preventScroll: true,
      });
    }
  }

  renderCollection(win, state, { view, result, error }, expanded) {
    const document = win.document;
    const details = document.createElementNS(HTML, "details");
    details.dataset.viewId = view.id;
    details.open = expanded.has(view.id);
    const summary = document.createElementNS(HTML, "summary");
    document.l10n.setAttributes(summary, "zen-mcp-collection-count", {
      name: view.name,
      count: error ? "—" : result.total,
    });
    summary.dataset.control = "summary";
    details.append(summary);
    for (const item of result?.items ?? []) {
      const button = document.createElementNS(HTML, "button");
      button.type = "button";
      button.textContent = item.title || item.url || "Tab";
      button.dataset.tabId = item.tabId;
      button.addEventListener("click", () => {
        try {
          const tab = this.service.getTab(item.tabId);
          const owner = tab.ownerGlobal ?? tab.documentGlobal;
          owner.gBrowser.selectedTab = tab;
        } catch {
          this.scheduleRender(win);
        }
      });
      details.append(button);
    }
    if (!error && result?.nextCursor) {
      const more = document.createElementNS(HTML, "button");
      more.type = "button";
      more.dataset.control = "next";
      document.l10n.setAttributes(more, "zen-mcp-collection-next");
      more.addEventListener("click", () => {
        const pages = state.pages.get(view.id) ?? [];
        pages.push(result.nextCursor);
        state.pages.set(view.id, pages);
        this.scheduleRender(win);
      });
      details.append(more);
    }
    if (state.pages.get(view.id)?.length) {
      const previous = document.createElementNS(HTML, "button");
      previous.type = "button";
      previous.dataset.control = "previous";
      document.l10n.setAttributes(previous, "zen-mcp-collection-previous");
      previous.addEventListener("click", () => {
        state.pages.get(view.id).pop();
        this.scheduleRender(win);
      });
      details.append(previous);
    }
    if (error || result?.total === 0) {
      const note = document.createElementNS(HTML, "small");
      document.l10n.setAttributes(
        note,
        error ? "zen-mcp-collection-unavailable" : "zen-mcp-collection-empty"
      );
      details.append(note);
    }
    return details;
  }

  cleanup() {}

  watchMedia(win, state) {
    const current = new Set();
    if (
      this.data.views.some(view => view.enabled) ||
      this.data.rules.some(
        rule =>
          rule.enabled &&
          rule.automatic &&
          rule.events.includes("MediaPlaybackChange")
      )
    ) {
      for (const tab of this.service.listTabs(win)) {
        if (!tab.linkedPanel || tab.hasAttribute("pending") || tab.closing) {
          continue;
        }
        const controller = tab.linkedBrowser.browsingContext?.mediaController;
        if (!controller) {
          continue;
        }
        current.add(controller);
        if (state.controllers.has(controller)) {
          continue;
        }
        const changed = () =>
          this.onBrowserEvent({
            windowId: this.service.windowId(win),
            tabId: this.service.tabId(tab),
            event: "MediaPlaybackChange",
          });
        const types = [
          "playbackstatechange",
          "pictureinpicturemodechange",
          "deactivated",
        ];
        types.forEach(type => controller.addEventListener(type, changed));
        state.controllers.set(controller, () =>
          types.forEach(type => controller.removeEventListener(type, changed))
        );
      }
    }
    for (const [controller, remove] of state.controllers) {
      if (!current.has(controller)) {
        remove();
        state.controllers.delete(controller);
      }
    }
  }

  destroy() {
    this.stopped = true;
    if (this.ruleTimer) {
      lazy.clearTimeout(this.ruleTimer);
    }
    for (const win of [...this.windows.keys()]) {
      this.detachWindow(win);
    }
    this.pending.clear();
    this.lastRuns.clear();
  }
}
