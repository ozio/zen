/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const { gZenSpaceRoutingAI } = ChromeUtils.importESModule(
  "resource:///modules/zen/spacerouting/ZenSpaceRoutingAI.sys.mjs"
);

add_setup(async function () {
  await gZenSpaceRoutingManager.ready;
  await gZenWorkspaces.promiseInitialized;
  const classify = gZenSpaceRoutingAI.classify;
  const settings = await gZenSpaceRoutingAI.getSettings();
  const defaultRoute = gZenSpaceRoutingManager.getDefaultExternalRoute();
  registerCleanupFunction(async () => {
    gZenSpaceRoutingAI.classify = classify;
    await gZenSpaceRoutingAI.saveSettings(settings);
    gZenSpaceRoutingManager.setDefaultExternalRoute(defaultRoute);
    clearAllRoutes();
  });
});

add_task(async function test_external_decision_precedes_initial_container() {
  clearAllRoutes();
  const source = gZenWorkspaces.getActiveWorkspace();
  const identity = ContextualIdentityService.create(
    "SR AI Test",
    "fingerprint",
    "purple"
  );
  let target, tab;
  try {
    target = await gZenWorkspaces.createAndSaveWorkspace(
      "SR AI Work",
      undefined,
      false,
      identity.userContextId
    );
    await gZenWorkspaces.changeWorkspace(source);
    let release, requested;
    const classified = new Promise(resolve => {
      requested = resolve;
    });
    gZenSpaceRoutingAI.classify = () => {
      requested();
      return new Promise(resolve => {
        release = resolve;
      });
    };
    let opened = false;
    const url = "https://example.com/traffic-control?synthetic=1#fragment";
    const pending = gZenSpaceRoutingManager.openExternalURI(
      Services.io.newURI(url),
      window,
      (win, routed) => {
        opened = true;
        ok(routed, "The external open is forced into its own tab");
        tab = win.gBrowser.addTab(url, {
          fromExternal: true,
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
        });
        Assert.equal(
          tab.linkedBrowser.contentPrincipal.originAttributes.userContextId ||
            Number(tab.getAttribute("usercontextid")),
          identity.userContextId,
          "The initial tab receives the destination container"
        );
      }
    );
    await classified;
    ok(!opened, "No native open occurs while a decision is pending");
    release({ reason: "jev", spaceId: target.uuid });
    await pending;
    await TestUtils.waitForCondition(
      () => tab.getAttribute("zen-workspace-id") === target.uuid,
      "External tab is in the chosen Space"
    );
    gZenSpaceRoutingAI.classify = () =>
      Assert.ok(false, "Ordinary tabs never invoke Jev");
    const before = gZenSpaceRoutingManager.onBeforeAddTab(url, {}, window);
    Assert.equal(
      before.targetRoute,
      "most-recent-space",
      "An internal new tab stays in its normal context"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspace(source);
    if (target) {
      await gZenWorkspaces.removeWorkspace(target.uuid);
    }
    ContextualIdentityService.remove(identity.userContextId);
  }
});

add_task(async function test_rules_are_final_and_first_fallback_tracks_order() {
  clearAllRoutes();
  const spaces = gZenWorkspaces.getWorkspaces();
  const route = addRoute({
    reference: "example.com/*",
    matchType: "url-mask",
    openIn: spaces[0].uuid,
  });
  gZenSpaceRoutingAI.classify = () =>
    Assert.ok(false, "Explicit rules bypass Jev");
  Assert.equal(
    (
      await gZenSpaceRoutingManager.resolveExternalURI(
        "https://example.com/path",
        window
      )
    ).reason,
    "rule"
  );
  gZenSpaceRoutingManager.removeRoute(route.id);
  gZenSpaceRoutingManager.setDefaultExternalRoute("first-space");
  gZenSpaceRoutingAI.classify = async () => ({
    reason: "uncertain",
    spaceId: null,
  });
  Assert.equal(
    (
      await gZenSpaceRoutingManager.resolveExternalURI(
        "https://example.com/path",
        window
      )
    ).spaceId,
    spaces[0].uuid
  );
});

add_task(async function test_native_external_batch_keeps_each_decision() {
  clearAllRoutes();
  const { nsDefaultCommandLineHandler } = ChromeUtils.importESModule(
    "resource:///modules/BrowserContentHandler.sys.mjs"
  );
  const source = gZenWorkspaces.getActiveWorkspace();
  let target;
  const addedTabs = [];
  const tabOpened = event => addedTabs.push(event.target);
  try {
    target = await gZenWorkspaces.createAndSaveWorkspace("SR Native Batch");
    await gZenWorkspaces.changeWorkspace(source);
    const urls = [
      "https://example.com/traffic-control-native-a",
      "https://example.org/traffic-control-native-b",
    ];
    const pending = new Map();
    gZenSpaceRoutingAI.classify = url =>
      new Promise(resolve => pending.set(url, resolve));
    gBrowser.tabContainer.addEventListener("TabOpen", tabOpened);
    const cmdLine = Cu.createCommandLine(
      urls,
      null,
      Ci.nsICommandLine.STATE_REMOTE_AUTO
    );
    new nsDefaultCommandLineHandler().handle(cmdLine);
    await TestUtils.waitForCondition(
      () => pending.size === 2,
      "Both native links reached the router"
    );
    Assert.equal(addedTabs.length, 0, "Neither link opens before its decision");
    pending.get(urls[1])({ reason: "jev", spaceId: target.uuid });
    await TestUtils.waitForCondition(
      () => addedTabs.length === 1,
      "Second link can finish first"
    );
    pending.get(urls[0])({ reason: "jev", spaceId: source.uuid });
    await TestUtils.waitForCondition(
      () => addedTabs.length === 2,
      "Both external links opened exactly once"
    );
    await TestUtils.waitForCondition(
      () =>
        addedTabs[0].getAttribute("zen-workspace-id") === target.uuid &&
        addedTabs[1].getAttribute("zen-workspace-id") === source.uuid,
      "Each native open keeps its own destination"
    );
  } finally {
    gBrowser.tabContainer.removeEventListener("TabOpen", tabOpened);
    for (const tab of addedTabs) {
      await BrowserTestUtils.removeTab(tab);
    }
    await gZenWorkspaces.changeWorkspace(source);
    if (target) {
      await gZenWorkspaces.removeWorkspace(target.uuid);
    }
    gZenSpaceRoutingAI.classify = async () => ({
      reason: "uncertain",
      spaceId: null,
    });
  }
});

add_task(
  async function test_ai_dialog_settings_survive_reopening_and_preview_does_not_open_tabs() {
    clearAllRoutes();
    const originalCount = gBrowser.tabs.length;
    let dlg = await openRoutingDialog();
    const prompt = "Route engineering links to Work. Synthetic browser test.";
    try {
      const doc = dlg.document;
      const input = doc.getElementById("sr-ai-prompt");
      input.value = prompt;
      input.dispatchEvent(new dlg.Event("input", { bubbles: true }));
      await flushEventLoop();
      Assert.equal((await gZenSpaceRoutingAI.getSettings()).prompt, prompt);
      doc.getElementById("sr-preview-url").value = "https://example.com/path";
      doc.getElementById("sr-preview-run").click();
      await TestUtils.waitForCondition(
        () =>
          doc
            .getElementById("sr-preview-result")
            .getAttribute("data-l10n-id") === "zen-space-routing-preview-result"
      );
      Assert.equal(
        gBrowser.tabs.length,
        originalCount,
        "Preview does not create a tab"
      );
      await closeRoutingDialog(dlg);
      dlg = await openRoutingDialog();
      Assert.equal(
        dlg.document.getElementById("sr-ai-prompt").value,
        prompt,
        "Prompt persists when dialog is reopened"
      );
      Assert.equal(
        dlg.document.querySelectorAll("#sr-ai-spaces input").length,
        gZenWorkspaces.getWorkspaces().length,
        "All current Spaces are listed automatically"
      );
    } finally {
      await closeRoutingDialog(dlg);
    }
  }
);
