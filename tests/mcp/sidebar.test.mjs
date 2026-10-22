import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

globalThis.Services = { uuid: { generateUUID: () => `{${randomUUID()}}` } };
globalThis.ChromeUtils = {
  defineESModuleGetters: target =>
    Object.assign(target, { setTimeout, clearTimeout }),
};
globalThis.PathUtils = {
  profileDir: "/synthetic",
  join: (...parts) => parts.join("/"),
};
const { ZenMcpSidebarTools, validateDefinition } =
  await import("../../src/zen/mcp/ZenMcpSidebarTools.sys.mjs");

function fixture() {
  const files = new Map();
  globalThis.IOUtils = {
    exists: async path => files.has(path),
    stat: async path => ({ size: JSON.stringify(files.get(path)).length }),
    readJSON: async path => structuredClone(files.get(path)),
    writeJSON: async (path, data) => files.set(path, structuredClone(data)),
    setPermissions: async () => {},
  };
  const win = {};
  const calls = [];
  const service = {
    instanceId: "instance",
    getWindows: () => [win],
    windowId: () => "window",
    getWindow(id) {
      assert.equal(id, "window");
      return win;
    },
    workspaceTools: {
      query: async args => {
        calls.push({ type: "query", args });
        return { items: [], total: 3, selectionId: "selection" };
      },
      execute: async (name, args) => {
        calls.push({ type: name, args });
        return name === "zen_tabs_plan"
          ? { planId: "plan", items: [{ tabId: "changed" }] }
          : { operationId: "operation", summary: { applied: 3 } };
      },
      cleanup() {},
      releasePlan(planId) {
        calls.push({ type: "releasePlan", planId });
      },
      releaseOperation(operationId) {
        calls.push({ type: "release", operationId });
      },
    },
    enqueueMutation: operation => operation(),
  };
  const provider = new ZenMcpSidebarTools(service);
  return { provider, service, files, calls };
}
const client = { id: "client" };

test("saved views and opt-in rules survive a provider restart with stable targets", async () => {
  const f = fixture();
  await f.provider.init();
  const view = await f.provider.execute(
    "zen_sidebar_views",
    {
      action: "save",
      definition: {
        name: "Playing",
        filter: { playing: true, spaceId: "stable-space" },
      },
    },
    client
  );
  const rule = await f.provider.execute(
    "zen_sidebar_rules",
    {
      action: "save",
      definition: {
        name: "GitHub",
        filter: { domains: ["github.com"] },
        operation: { action: "move", spaceId: "stable-space" },
      },
    },
    client
  );
  assert.equal(rule.definition.automatic, false);
  assert.equal(
    f.calls.some(call => call.type === "zen_tabs_apply"),
    false
  );
  const second = new ZenMcpSidebarTools(f.service);
  await second.init();
  assert.deepEqual(second.data.views, [view.definition]);
  assert.deepEqual(second.data.rules, [rule.definition]);
  await second.execute(
    "zen_sidebar_views",
    { action: "delete", viewId: view.definition.id },
    client
  );
  const third = new ZenMcpSidebarTools(f.service);
  await third.init();
  assert.equal(third.data.views.length, 0);
  assert.equal(third.data.rules.length, 1);
});

test("saved definitions refuse ephemeral handles, destructive automation, and hidden properties", () => {
  for (const key of [
    "windowId",
    "tabIds",
    "selectionId",
    "beforeId",
    "order",
  ]) {
    assert.throws(
      () =>
        validateDefinition("views", {
          name: "Bad",
          filter: { all: [{ [key]: "transient" }] },
        }),
      { code: "transient_target" }
    );
  }
  for (const action of ["close", "open"]) {
    assert.throws(
      () =>
        validateDefinition("rules", {
          name: "Bad",
          operation: { action },
          automatic: true,
        }),
      { code: "invalid_automatic_action" }
    );
  }
  assert.throws(
    () => validateDefinition("views", { name: "Bad", typo: true }),
    { code: "invalid_definition" }
  );
  assert.throws(
    () =>
      validateDefinition("rules", {
        name: "Bad",
        operation: { action: "move", select: true },
      }),
    { code: "invalid_operation" }
  );
});

test("manual preview does not apply; run uses the returned plan with focus preservation", async () => {
  const f = fixture();
  f.provider.data.rules.push(
    validateDefinition(
      "rules",
      {
        name: "Sort",
        filter: { spaceId: "space" },
        operation: { action: "sort", sort: { by: "title" } },
      },
      "rule"
    )
  );
  await f.provider.execute(
    "zen_sidebar_rules",
    { action: "preview", ruleId: "rule", windowId: "window" },
    client
  );
  assert.equal(
    f.calls.some(call => call.type === "zen_tabs_apply"),
    false
  );
  await f.provider.execute(
    "zen_sidebar_rules",
    { action: "run", ruleId: "rule", windowId: "window" },
    client
  );
  assert.equal(f.calls.at(-1).type, "zen_tabs_apply");
  assert.equal(f.calls.at(-1).args.planId, "plan");
  assert.equal(
    f.calls.find(call => call.type === "zen_tabs_plan").args.select,
    false
  );
});

test("automatic rules use first match, coalesce re-entry, and only target the changed tab", async () => {
  const f = fixture();
  for (const id of ["one", "two"]) {
    f.provider.data.rules.push(
      validateDefinition(
        "rules",
        {
          name: id,
          filter: { domain: "example.test" },
          operation: { action: "move", spaceId: id },
          automatic: true,
        },
        id
      )
    );
  }
  const change = {
    windowId: "window",
    tabId: "changed",
    events: new Set(["TabOpen"]),
  };
  await f.provider.runAutomatic([change, change]);
  const applies = f.calls.filter(call => call.type === "zen_tabs_apply");
  assert.equal(
    applies.length,
    1,
    "overlapping rules must not oscillate a tab between destinations"
  );
  assert.deepEqual(f.calls[0].args.filter.all[1], { tabIds: ["changed"] });
  assert.equal(f.provider.history[0].ruleId, "one");
  f.provider.busy = true;
  f.provider.ownTabs.add("changed");
  f.provider.onBrowserEvent({ ...change, event: "TabOpen" });
  assert.equal(f.provider.pending.size, 0);
  f.provider.onBrowserEvent({
    ...change,
    tabId: "opened-by-user",
    event: "TabOpen",
  });
  assert.equal(
    f.provider.pending.size,
    1,
    "unrelated user events must survive an in-flight automatic operation"
  );
  f.provider.destroy();
});

test("blocked and undone automatic receipts do not exhaust the workspace receipt budget", async () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) {
    f.provider.recordRun("rule", {
      operationId: `blocked-${i}`,
      undoAvailable: false,
    });
  }
  assert.equal(f.calls.filter(call => call.type === "release").length, 40);
  f.provider.recordRun("rule", {
    operationId: "undo-this",
    undoAvailable: true,
    affectedTabIds: ["changed"],
  });
  f.service.workspaceTools.execute = async () => {
    f.provider.onBrowserEvent({
      windowId: "window",
      tabId: "changed",
      event: "TabUnpinned",
    });
    return { undone: true };
  };
  await f.provider.execute(
    "zen_sidebar_rules",
    { action: "undo", operationId: "undo-this" },
    client
  );
  assert.equal(
    f.provider.pending.size,
    0,
    "Undo's own events must not immediately reapply the rule"
  );
  assert.equal(f.provider.history.at(-1).undoAvailable, false);
  assert.equal(f.calls.at(-1).operationId, "undo-this");
});

test("a final title arriving immediately after TabOpen reruns the sort rule", async () => {
  const f = fixture();
  let title = "Loading";
  f.service.workspaceTools.query = async () => ({
    total: 1,
    items: [{ tabId: "changed", title }],
    selectionId: "selection",
  });
  f.provider.data.rules.push(
    validateDefinition(
      "rules",
      {
        name: "Sort",
        automatic: true,
        events: ["TabOpen", "TabAttrModified"],
        operation: { action: "sort", sort: { by: "title" } },
      },
      "rule"
    )
  );
  await f.provider.runAutomatic([
    { windowId: "window", tabId: "changed", events: new Set(["TabOpen"]) },
  ]);
  title = "Actual title";
  await f.provider.runAutomatic([
    {
      windowId: "window",
      tabId: "changed",
      events: new Set(["TabAttrModified"]),
    },
  ]);
  assert.equal(
    f.calls.filter(call => call.type === "zen_tabs_apply").length,
    2
  );
});

test("sidebar rendering coalesces events while an earlier asynchronous render is running", async () => {
  const f = fixture();
  const win = f.service.getWindows()[0];
  let count = 0;
  let release;
  const pending = new Promise(resolve => {
    release = resolve;
  });
  f.provider.render = async () => {
    if (++count === 1) {
      await pending;
    }
  };
  f.provider.attachWindow(win);
  await new Promise(resolve => setTimeout(resolve, 225));
  f.provider.scheduleRender(win);
  f.provider.scheduleRender(win);
  await new Promise(resolve => setTimeout(resolve, 225));
  assert.equal(count, 1);
  release();
  await new Promise(resolve => setTimeout(resolve, 225));
  assert.equal(count, 2);
  f.provider.destroy();
});

test("corrupt saved data is preserved and cannot be silently overwritten", async () => {
  const f = fixture();
  const corrupt = { version: 900, views: [], rules: [] };
  f.files.set(f.provider.file, corrupt);
  await f.provider.init();
  assert.ok(f.provider.loadError);
  await assert.rejects(
    f.provider.persist({ version: 1, views: [], rules: [] }),
    { code: "workspace_store_unavailable" }
  );
  assert.deepEqual(f.files.get(f.provider.file), corrupt);
});
