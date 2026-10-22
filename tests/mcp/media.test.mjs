// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Exercise the actual provider and child actor. Only Gecko transport, native
// windows and media event generation are replaced; no source-pattern assertions.
const mocks = {};
globalThis.ChromeUtils = {
  defineESModuleGetters(object, modules) {
    for (const key of Object.keys(modules)) {
      Object.defineProperty(object, key, { get: () => mocks[key] });
    }
  },
};
globalThis.JSWindowActorChild = class {};
globalThis.Services = {
  uuid: { generateUUID: () => `{${randomUUID()}}` },
  wm: { getEnumerator: () => mocks.players },
};
globalThis.Ci = { nsIScreenManager: {} };
globalThis.Cc = {
  "@mozilla.org/gfx/screenmanager;1": { getService: () => mocks.screenManager },
};
const dataURL = source =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const utils = dataURL(
  await readFile(
    new URL("../../src/zen/mcp/ZenMcpUtils.sys.mjs", import.meta.url),
    "utf8"
  )
);
async function load(path) {
  return import(
    dataURL(
      (await readFile(new URL(path, import.meta.url), "utf8"))
        .replace("resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs", utils)
        .replace("resource://gre/modules/Timer.sys.mjs", "node:timers")
    )
  );
}
const { ZenMcpMediaTools, pipPlacement, desktopWindowRect } = await load(
  "../../src/zen/mcp/ZenMcpMediaTools.sys.mjs"
);
const { ZenMcpMediaChild, seekDestination, scanMediaElements } = await load(
  "../../src/zen/mcp/actors/ZenMcpMediaChild.sys.mjs"
);
const client = { id: "client-one" };
const identity = { instanceId: "test-instance" };

function screen(x, y, width, height, scale = 1, topInset = 24) {
  const put = (values, data) =>
    values.forEach((value, index) => {
      value.value = data[index];
    });
  return {
    defaultCSSScaleFactor: scale,
    contentsScaleFactor: 1,
    GetRectDisplayPix(...values) {
      put(values, [x, y, width, height]);
    },
    GetAvailRectDisplayPix(...values) {
      put(values, [x, y + topInset, width, height - topInset]);
    },
    geometry: { x, y, width, height },
  };
}

function fakeMedia(doc, kind = "video") {
  const listeners = new Map();
  const values = { volume: 1, muted: false, playbackRate: 1, currentTime: 20 };
  const media = {
    namespaceURI: "http://www.w3.org/1999/xhtml",
    localName: kind,
    ownerDocument: doc,
    isConnected: true,
    paused: false,
    ended: false,
    currentSrc: "https://media.invalid/fixture.webm",
    readyState: 4,
    duration: 120,
    videoWidth: kind === "video" ? 1920 : 0,
    videoHeight: kind === "video" ? 1080 : 0,
    title: "Fixture media",
    isCloningElementVisually: false,
    seekable: { length: 1, start: () => 0, end: () => 120 },
    getAttribute: () => null,
    addEventListener(name, callback) {
      if (!listeners.has(name)) {
        listeners.set(name, new Set());
      }
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    emit(name, trusted = true) {
      for (const callback of listeners.get(name) || []) {
        callback({ type: name, isTrusted: trusted, target: media });
      }
    },
    pause() {
      if (!media.paused) {
        media.paused = true;
        queueMicrotask(() => media.emit("pause"));
      }
    },
    play() {
      if (media.paused) {
        media.paused = false;
        queueMicrotask(() => media.emit("play"));
      }
      return Promise.resolve();
    },
    listeners,
  };
  for (const [property, event] of [
    ["volume", "volumechange"],
    ["muted", "volumechange"],
    ["playbackRate", "ratechange"],
    ["currentTime", "seeked"],
  ]) {
    Object.defineProperty(media, property, {
      get: () => values[property],
      set(value) {
        if (values[property] !== value) {
          values[property] = value;
          queueMicrotask(() => {
            if (property === "currentTime") {
              media.emit("seeking");
            }
            media.emit(event);
          });
        }
      },
    });
  }
  return media;
}

function fixture() {
  let serial = 0;
  mocks.players = [];
  const primary = screen(0, 0, 1920, 1080);
  const external = screen(-1600, -100, 1600, 1000, 1.5);
  mocks.screenManager = {
    primaryScreen: primary,
    screens: [primary, external],
  };
  mocks.getActorFor = media => media.pipActor;
  mocks.PictureInPicture = {
    weakWinToBrowser: new WeakMap(),
    async closeSinglePipWindow({ actorRef }) {
      const win = mocks.players.find(item => item.Player.actor === actorRef);
      if (win) {
        win.closed = true;
        win.source.isCloningElementVisually = false;
        win.source.pipActor = null;
      }
    },
  };
  const normalWindow = { id: "window-1" };
  const tabs = [];
  const selectorCalls = [];
  const service = {
    instanceId: identity.instanceId,
    assertInstance(args) {
      assert.equal(args.instanceId, identity.instanceId);
    },
    getWindows: () => [normalWindow],
    listTabs: () => tabs,
    getTab(id) {
      const tab = tabs.find(value => value.id === id && !value.closing);
      if (!tab) {
        throw new Error("Missing tab");
      }
      return tab;
    },
    tabId: tab => tab.id,
    windowId: win => win.id,
    workspaceTools: {
      async resolveTargets(args) {
        selectorCalls.push(args);
        return tabs.filter(tab => !args.tabIds || args.tabIds.includes(tab.id));
      },
    },
  };
  function playerFor(media, tab) {
    const frameId = 9000 + ++serial;
    media.isCloningElementVisually = true;
    media.pipActor = {
      browsingContext: { id: frameId },
      async closePictureInPicture() {
        win.closed = true;
        media.isCloningElementVisually = false;
        media.pipActor = null;
      },
    };
    const win = {
      closed: false,
      fullScreen: false,
      devicePixelRatio: 1,
      desktopToDeviceScale: 1,
      screenX: 100,
      screenY: 100,
      outerWidth: 480,
      outerHeight: 270,
      source: media,
      document: {
        getElementById: () => ({ browsingContext: { id: frameId } }),
      },
      Player: { actor: {} },
      moveTo(x, y) {
        const oldScale = this.devicePixelRatio / this.desktopToDeviceScale;
        const dx = x * oldScale,
          dy = y * oldScale;
        const target =
          mocks.screenManager.screens.find(
            value =>
              dx >= value.geometry.x &&
              dx < value.geometry.x + value.geometry.width
          ) || primary;
        this.devicePixelRatio = target.defaultCSSScaleFactor;
        const scale = this.devicePixelRatio / this.desktopToDeviceScale;
        this.screenX = dx / scale;
        this.screenY = dy / scale;
      },
      resizeTo(width, height) {
        this.outerWidth = width;
        this.outerHeight = height;
      },
    };
    mocks.PictureInPicture.weakWinToBrowser.set(win, tab.linkedBrowser);
    mocks.players.push(win);
    return win;
  }
  function addTab({
    unloaded = false,
    kinds = ["video"],
    extraFrame = false,
  } = {}) {
    const id = `tab-${++serial}`;
    const tab = {
      id,
      linkedPanel: unloaded ? null : `panel-${serial}`,
      ownerGlobal: normalWindow,
      hasAttribute: name => name === "pending" && unloaded,
    };
    if (unloaded) {
      Object.defineProperty(tab, "linkedBrowser", {
        get() {
          throw new Error("Unloaded browser binding accessed");
        },
      });
      tabs.push(tab);
      return { tab, media: [] };
    }
    const doc = {
      nodes: [],
      createTreeWalker(root) {
        const nodes = root.nodes || [];
        let index = 0;
        return { nextNode: () => nodes[index++] || null };
      },
    };
    const docId = 100 + serial;
    const frame = { id: 1000 + serial, children: [] };
    const actor = new ZenMcpMediaChild();
    actor.browsingContext = frame;
    actor.contentWindow = {
      document: doc,
      windowGlobalChild: { innerWindowId: docId },
      windowUtils: { setHandlingUserInput: () => ({ destruct() {} }) },
    };
    actor.manager = {
      isCurrentGlobal: true,
      isClosed: false,
      getActor: () => ({
        async togglePictureInPicture({ video }, activate) {
          tab.lastActivate = activate;
          playerFor(video, tab);
        },
      }),
    };
    const bridge = {
      sendQuery(name, data) {
        return actor.receiveMessage({ name, data });
      },
      sendAsyncMessage(name, data) {
        actor.receiveMessage({ name, data });
      },
    };
    const wgp = {
      innerWindowId: docId,
      isClosed: false,
      getActor: () => bridge,
    };
    frame.currentWindowGlobal = wgp;
    tab.linkedBrowser = { browsingContext: frame };
    const media = kinds.map(kind => fakeMedia(doc, kind));
    doc.nodes = [...media];
    tabs.push(tab);
    if (extraFrame) {
      const extra = addTab();
      tabs.pop();
      frame.children.push(extra.frame);
      media.push(...extra.media);
    }
    return { tab, media, actor, frame, wgp, bridge, doc };
  }
  const provider = new ZenMcpMediaTools(service);
  const call = (name, args = {}, as = client, signal) =>
    provider.execute(name, { ...identity, ...args }, as, signal);
  return {
    addTab,
    provider,
    call,
    service,
    selectorCalls,
    playerFor,
    primary,
    external,
  };
}

test("inventory covers separate frame documents and leaves unloaded browser bindings untouched", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "audio"], extraFrame: true });
  const unloaded = f.addTab({ unloaded: true });
  const result = await f.call("zen_media_items", {
    tabIds: [a.tab.id, unloaded.tab.id],
  });
  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map(item => item.frameId)).size, 2);
  assert.ok(
    result.items.every(item => item.tabId === a.tab.id && item.documentId)
  );
  assert.deepEqual(result.unavailable, [
    { tabId: unloaded.tab.id, code: "unloaded_tab" },
  ]);
  assert.equal(f.selectorCalls.length, 1);
  assert.equal(result.instanceId, identity.instanceId);
});

test("volume, playback rate and relative seek target one exact video and return observed state", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "video"] });
  const list = await f.call("zen_media_items");
  const id = list.items[1].mediaId;
  let result = await f.call("zen_media_control", {
    mediaIds: [id],
    action: "volume",
    volume: 0.4,
  });
  assert.equal(result.results[0].observed.volume, 0.4);
  assert.equal(a.media[0].volume, 1);
  result = await f.call("zen_media_control", {
    mediaIds: [id],
    action: "rate",
    playbackRate: 1.75,
  });
  assert.equal(result.results[0].observed.playbackRate, 1.75);
  result = await f.call("zen_media_control", {
    mediaIds: [id],
    action: "seek",
    offsetSeconds: -30,
  });
  assert.equal(result.results[0].observed.currentTime, 0);
  assert.equal(a.media[0].currentTime, 20);
});

test("invalid values fail before mutation; shared selection and mediaIds cannot be mixed", async () => {
  const f = fixture();
  const a = f.addTab();
  const id = (await f.call("zen_media_items")).items[0].mediaId;
  for (const args of [
    { action: "volume", volume: 2 },
    { action: "rate", playbackRate: 0 },
    { action: "seek", positionSeconds: 3, offsetSeconds: 4 },
    { action: "pause", tabIds: [a.tab.id] },
  ]) {
    await assert.rejects(
      f.call("zen_media_control", { mediaIds: [id], ...args })
    );
  }
  assert.equal(a.media[0].volume, 1);
  assert.equal(a.media[0].paused, false);
  await assert.rejects(
    f.call("zen_media_control", { action: "pause" }),
    error => error.code === "missing_selection"
  );
});

test("media handles are client-, tab-, frame- and document-bound, not silently retargeted", async () => {
  const f = fixture();
  const a = f.addTab();
  const id = (await f.call("zen_media_items")).items[0].mediaId;
  await assert.rejects(
    f.call(
      "zen_media_control",
      { mediaIds: [id], action: "pause" },
      { id: "other-client" }
    ),
    error => error.code === "unknown_media"
  );
  a.wgp.innerWindowId++;
  const result = await f.call("zen_media_control", {
    mediaIds: [id],
    action: "pause",
  });
  assert.equal(result.results[0].error.code, "stale_document");
  assert.equal(a.media[0].paused, false);
});

test("pause others and restore preserve the protected video and originally paused media", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "video", "audio"] });
  a.media[2].paused = true;
  const list = await f.call("zen_media_items");
  const focused = await f.call("zen_media_control", {
    tabIds: [a.tab.id],
    action: "pauseOthers",
    exceptMediaIds: [list.items[0].mediaId],
  });
  assert.equal(focused.restorable, 1);
  assert.equal(a.media[0].paused, false);
  assert.equal(a.media[1].paused, true);
  const restored = await f.call("zen_media_control", {
    action: "restore",
    operationId: focused.operationId,
  });
  assert.equal(restored.results[0].status, "applied");
  assert.equal(a.media[1].paused, false);
  assert.equal(a.media[2].paused, true);
  await assert.rejects(
    f.call("zen_media_control", {
      action: "restore",
      operationId: focused.operationId,
    }),
    error => error.code === "unknown_operation"
  );
});

test("duck restore skips native user changes even if volume was changed away and back", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "audio"] });
  const focused = await f.call("zen_media_control", {
    tabIds: [a.tab.id],
    action: "duckOthers",
    volume: 0.2,
  });
  assert.equal(focused.restorable, 2);
  a.media[0].volume = 0.7;
  await Promise.resolve();
  a.media[0].volume = 0.2;
  await Promise.resolve();
  const restored = await f.call("zen_media_control", {
    action: "restore",
    operationId: focused.operationId,
  });
  assert.equal(restored.results[0].status, "skipped_changed");
  assert.equal(a.media[0].volume, 0.2);
  assert.equal(a.media[1].volume, 1);
});

test("restore belongs to its issuing client and document and does not start media after navigation", async () => {
  const f = fixture();
  const a = f.addTab();
  const focused = await f.call("zen_media_control", {
    tabIds: [a.tab.id],
    action: "pauseOthers",
  });
  await assert.rejects(
    f.call(
      "zen_media_control",
      { action: "restore", operationId: focused.operationId },
      { id: "other" }
    ),
    error => error.code === "unknown_operation"
  );
  a.wgp.innerWindowId++;
  const restored = await f.call("zen_media_control", {
    action: "restore",
    operationId: focused.operationId,
  });
  assert.equal(restored.results[0].error.code, "stale_document");
  assert.equal(a.media[0].paused, true);
});

test("pause restore also skips seek/rate/volume interventions and ignores synthetic DOM events", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "video", "video", "video"] });
  const focused = await f.call("zen_media_control", {
    tabIds: [a.tab.id],
    action: "pauseOthers",
  });
  a.media[0].currentTime = 30;
  a.media[1].playbackRate = 1.5;
  a.media[2].volume = 0.6;
  a.media[3].emit("play", false);
  await Promise.resolve();
  const restored = await f.call("zen_media_control", {
    action: "restore",
    operationId: focused.operationId,
  });
  assert.deepEqual(
    restored.results.map(item => item.status),
    ["skipped_changed", "skipped_changed", "skipped_changed", "applied"]
  );
  assert.deepEqual(
    a.media.map(item => item.paused),
    [true, true, true, false]
  );
});

test("PiP inventory resolves two independent videos in the same tab and controls/closes only the selected player", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "video"] });
  const one = f.playerFor(a.media[0], a.tab);
  const two = f.playerFor(a.media[1], a.tab);
  const list = await f.call("zen_pip_windows");
  assert.equal(list.items.length, 2);
  assert.notEqual(list.items[0].source.mediaId, list.items[1].source.mediaId);
  await f.call("zen_pip", {
    action: "rate",
    playerId: list.items[1].playerId,
    playbackRate: 2,
  });
  assert.equal(a.media[0].playbackRate, 1);
  assert.equal(a.media[1].playbackRate, 2);
  await f.call("zen_pip", {
    action: "close",
    playerId: list.items[0].playerId,
  });
  assert.equal(one.closed, true);
  assert.equal(two.closed, false);
});

test("PiP open uses an exact video and does not activate by default or toggle an existing player closed", async () => {
  const f = fixture();
  const a = f.addTab({ kinds: ["video", "video"] });
  const list = await f.call("zen_media_items");
  const opened = await f.call("zen_pip", {
    action: "open",
    mediaId: list.items[1].mediaId,
  });
  assert.equal(opened.player.source.mediaId, list.items[1].mediaId);
  assert.equal(a.tab.lastActivate, false);
  assert.equal(a.media[0].isCloningElementVisually, false);
  const again = await f.call("zen_pip", {
    action: "open",
    mediaId: list.items[1].mediaId,
  });
  assert.equal(again.status, "unchanged");
  assert.equal(mocks.players.length, 1);
});

test("invalid monitor/geometry is rejected before a PiP window is opened", async () => {
  const f = fixture();
  f.addTab();
  const mediaId = (await f.call("zen_media_items")).items[0].mediaId;
  await assert.rejects(
    f.call("zen_pip", {
      action: "open",
      mediaId,
      monitorId: "missing",
      width: 600,
    }),
    error => error.code === "stale_monitor"
  );
  await assert.rejects(
    f.call("zen_pip", { action: "open", mediaId, x: 50 }),
    error => error.code === "invalid_geometry"
  );
  assert.equal(mocks.players.length, 0);
});

test("monitor placement handles negative coordinates, work area, corner and mixed display scale", async () => {
  const f = fixture();
  const a = f.addTab();
  const native = f.playerFor(a.media[0], a.tab);
  const list = await f.call("zen_pip_windows");
  const monitor = list.monitors.find(item => item.bounds.x < 0);
  const placed = await f.call("zen_pip", {
    action: "place",
    playerId: list.items[0].playerId,
    monitorId: monitor.monitorId,
    topologyRevision: list.topologyRevision,
    corner: "bottom-right",
    width: 600,
    margin: 20,
  });
  assert.deepEqual(placed.observed, {
    x: -620,
    y: 543,
    width: 600,
    height: 338,
  });
  assert.equal(placed.constrained, false);
  assert.equal(placed.monitorId, monitor.monitorId);
  assert.deepEqual(desktopWindowRect(native), placed.observed);
});

test("topology IDs are stable across enumeration order, expire on display changes, and stale placement does not move a player", async () => {
  const f = fixture();
  const a = f.addTab();
  const native = f.playerFor(a.media[0], a.tab);
  const first = await f.call("zen_pip_windows");
  mocks.screenManager.screens.reverse();
  const second = await f.call("zen_pip_windows");
  assert.equal(first.topologyRevision, second.topologyRevision);
  const before = desktopWindowRect(native);
  mocks.screenManager.screens = [f.primary];
  await assert.rejects(
    f.call("zen_pip", {
      action: "place",
      playerId: first.items[0].playerId,
      monitorId: first.monitors[0].monitorId,
      topologyRevision: first.topologyRevision,
      width: 600,
    }),
    error => error.code === "stale_monitor"
  );
  assert.deepEqual(desktopWindowRect(native), before);
});

test("geometry keeps aspect inside the native work area and rejects conflicting placement", () => {
  const monitor = { workArea: { x: -1000, y: 24, width: 1000, height: 700 } };
  const placement = pipPlacement(
    { x: 2000, y: -400, width: 800, height: 450 },
    monitor,
    16 / 9,
    { width: 5000, height: 5000, margin: 10 }
  );
  assert.ok(placement.x >= -990 && placement.y >= 34);
  assert.ok(placement.x + placement.width <= -10);
  assert.ok(placement.y + placement.height <= 714);
  assert.ok(Math.abs(placement.width / placement.height - 16 / 9) < 0.01);
  assert.throws(() =>
    pipPlacement(placement, monitor, 1, { corner: "top-left", x: 2, y: 2 })
  );
  assert.throws(() => pipPlacement(placement, monitor, 1, { x: 2 }));
  assert.throws(() => pipPlacement(placement, monitor, 1, { width: Infinity }));
});

test("seek handles live/disconnected ranges and rejects media without metadata", () => {
  const media = {
    currentTime: 160,
    readyState: 4,
    duration: Infinity,
    seekable: {
      length: 2,
      start: index => [100, 200][index],
      end: index => [150, 250][index],
    },
  };
  assert.equal(seekDestination(media, { offsetSeconds: 20 }), 200);
  assert.equal(seekDestination(media, { positionSeconds: 999 }), 250);
  assert.equal(seekDestination(media, { positionSeconds: -10 }), 100);
  media.readyState = 0;
  assert.throws(
    () => seekDestination(media, { positionSeconds: 5 }),
    error => error.code === "media_not_ready"
  );
});

test("scan includes open shadow roots, reports bounded truncation and skips foreign elements", () => {
  const f = fixture();
  const a = f.addTab();
  const shadow = fakeMedia(a.doc, "audio");
  a.doc.nodes.push(
    { localName: "div", shadowRoot: { nodes: [shadow] } },
    { localName: "video", namespaceURI: "foreign" }
  );
  assert.deepEqual(scanMediaElements(a.doc).elements, [a.media[0], shadow]);
  assert.equal(scanMediaElements(a.doc, 1).truncated, true);
});

test("actor cancellation aborts a waiting media event and removes listeners", async () => {
  const f = fixture();
  const a = f.addTab();
  const list = await f.call("zen_media_items");
  a.media[0].pause = () => {
    a.media[0].paused = true;
  };
  const controller = new AbortController();
  const result = f.call(
    "zen_media_control",
    { mediaIds: [list.items[0].mediaId], action: "pause" },
    client,
    controller.signal
  );
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await assert.rejects(result, error => error.code === "cancelled");
  await Promise.resolve();
  assert.equal(a.actor.requests.size, 0);
  assert.equal(a.actor.busy.size, 0);
  assert.equal(a.media[0].listeners.get("pause").size, 1);
});

test("cleanup invalidates client handles and effects without resuming paused media", async () => {
  const f = fixture();
  const a = f.addTab();
  const focused = await f.call("zen_media_control", {
    tabIds: [a.tab.id],
    action: "pauseOthers",
  });
  f.provider.cleanup(client.id);
  assert.equal(a.media[0].paused, true);
  assert.equal(a.actor.effects.size, 0);
  await assert.rejects(
    f.call("zen_media_control", {
      action: "restore",
      operationId: focused.operationId,
    }),
    error => error.code === "unknown_operation"
  );
  f.provider.destroy();
  await assert.rejects(
    f.call("zen_media_items"),
    error => error.code === "server_stopped"
  );
});

test("cancelling pending play prevents a late playback start only while its transition remains owned", async () => {
  for (const intervene of [false, true]) {
    const f = fixture();
    const a = f.addTab();
    a.media[0].paused = true;
    const mediaId = (await f.call("zen_media_items")).items[0].mediaId;
    a.media[0].play = () => {
      a.media[0].paused = false;
      queueMicrotask(() => a.media[0].emit("play"));
      return new Promise(() => {});
    };
    const controller = new AbortController();
    const pending = f.call(
      "zen_media_control",
      { mediaIds: [mediaId], action: "play" },
      client,
      controller.signal
    );
    await new Promise(resolve => setTimeout(resolve, 10));
    if (intervene) {
      a.media[0].emit("pause");
      a.media[0].emit("play");
    }
    controller.abort();
    await assert.rejects(pending, error => error.code === "cancelled");
    await Promise.resolve();
    assert.equal(a.media[0].paused, !intervene);
  }
});
