// Requires a bootstrapped engine. Execute the canonical patches, not a copy of
// their policy, with actor/window creation boundaries replaced by test doubles.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
function patched(target) {
  const dir = mkdtempSync(join(tmpdir(), "zen-auto-pip-"));
  try {
    mkdirSync(join(dir, dirname(target)), { recursive: true });
    writeFileSync(
      join(dir, target),
      execFileSync("git", ["show", `HEAD:${target}`], {
        cwd: join(root, "engine"),
      }),
    );
    const patch = readFileSync(
      join(
        root,
        "src",
        dirname(target),
        target.split("/").at(-1).replaceAll(".", "-") + ".patch",
      ),
    );
    execFileSync("git", ["apply", "--"], { cwd: dir, input: patch });
    return readFileSync(join(dir, target), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const child = patched("toolkit/actors/PictureInPictureChild.sys.mjs");
const parent = patched(
  "toolkit/components/pictureinpicture/PictureInPicture.sys.mjs",
);
function load(source, output) {
  const context = vm.createContext({
    JSWindowActorChild: class {},
    JSWindowActorParent: class {},
    AppConstants: { platform: "macosx" },
    Ci: {},
    HTMLVideoElement: { isInstance: (v) => !!v?.isVideo },
    ChromeUtils: { defineESModuleGetters() {}, defineLazyGetter() {} },
    XPCOMUtils: {
      defineLazyServiceGetters() {},
      defineLazyPreferenceGetter: (obj, key, pref, value) => {
        obj[key] = value;
      },
    },
    Glean: {
      pictureinpicture: new Proxy(
        {},
        { get: () => ({ set() {}, record() {} }) },
      ),
    },
    Services: { prefs: { setBoolPref() {} } },
    console,
  });
  vm.runInContext(
    source.replace(/^import[\s\S]*?;\s*$/gm, "").replaceAll("export ", "") +
      `\nglobalThis.out = ${output};`,
    context,
  );
  return context.out;
}
function video(overrides = {}) {
  return {
    isVideo: true,
    paused: false,
    ended: false,
    readyState: 4,
    muted: false,
    eligible: true,
    ...overrides,
  };
}
function launch(videos, active = null, visibilityState = "hidden") {
  const { Launcher, Child } = load(
    child,
    "({Launcher:PictureInPictureLauncherChild, Child:PictureInPictureChild})",
  );
  Child.videoIsPiPEligible = (v) => v.eligible;
  const actor = new Launcher();
  actor.document = {
    activeElement: active,
    querySelectorAll: () => videos,
    visibilityState,
  };
  const calls = [];
  actor.togglePictureInPicture = (request, autoFocus) =>
    calls.push({ request, autoFocus });
  actor.autoToggle();
  return calls;
}
test("auto selection ignores paused, muted, ended, ineligible and already popped-out videos", () => {
  for (const overrides of [
    { paused: true },
    { muted: true },
    { ended: true },
    { readyState: 2 },
    { eligible: false },
    { isCloningElementVisually: true },
  ]) {
    const candidate = video(overrides);
    assert.equal(launch([candidate], candidate).length, 0);
  }
  assert.equal(launch([video()], null, "visible").length, 0);
});
test("an unsuitable focused preview cannot hide the playing unmuted video", () => {
  const preview = video({ muted: true });
  const playing = video();
  const calls = launch([preview, playing], preview);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.video, playing);
  assert.equal(calls[0].request.reason, "AutoPip");
  assert.equal(calls[0].autoFocus, false);
});
test("an eligible focused video wins over another playing video", () => {
  const focused = video();
  assert.equal(launch([video(), focused], focused)[0].request.video, focused);
});
function harness() {
  const pip = load(parent, "PictureInPicture");
  const tab = { setAttribute() {}, addEventListener() {} };
  const browser = { docShellIsActive: false, audioMuted: false };
  browser.documentGlobal = {
    gBrowser: { selectedBrowser: {}, getTabForBrowser: () => tab },
  };
  const wgp = { browsingContext: { top: { embedderElement: browser } } };
  return {
    pip,
    browser,
    wgp,
    data: { isAutoPip: true, playing: true, isMuted: false },
  };
}
test("automatic request does not replace manual PiP, open on selected tab or mute/pause", async () => {
  for (const kind of [
    "manual",
    "selected",
    "tab-muted",
    "video-muted",
    "paused",
  ]) {
    const h = harness();
    let opens = 0;
    h.pip.openPictureInPictureRequest = async () => opens++;
    if (kind === "manual") h.pip.browserWeakMap.set(h.browser, 1);
    if (kind === "selected")
      h.browser.documentGlobal.gBrowser.selectedBrowser = h.browser;
    if (kind === "tab-muted") h.browser.audioMuted = true;
    if (kind === "video-muted") h.data.isMuted = true;
    if (kind === "paused") h.data.playing = false;
    await h.pip.handlePictureInPictureRequest(h.wgp, h.data);
    assert.equal(opens, 0, kind);
  }
});
test("duplicate auto requests serialize and failed creation releases the pending browser", async () => {
  const h = harness();
  let resolve;
  let opens = 0;
  h.pip.openPictureInPictureRequest = () => {
    opens++;
    return new Promise((r) => {
      resolve = r;
    });
  };
  const first = h.pip.handlePictureInPictureRequest(h.wgp, h.data);
  await h.pip.handlePictureInPictureRequest(h.wgp, h.data);
  assert.equal(opens, 1);
  resolve();
  await first;
  assert.equal(h.pip.weakAutoPipPendingBrowsers.has(h.browser), false);
  h.pip.openPictureInPictureRequest = async () => {
    throw new Error("Synthetic creation failure");
  };
  await assert.rejects(
    h.pip.handlePictureInPictureRequest(h.wgp, h.data),
    /Synthetic creation failure/,
  );
  assert.equal(h.pip.weakAutoPipPendingBrowsers.has(h.browser), false);
});
test("explicit ownership survives background manual requests and quick automatic returns", async () => {
  for (const auto of [false, true]) {
    const h = harness();
    let resolveSetup;
    const actor = {};
    const closed = [];
    const win = new Proxy(
      {
        setupPlayer: () => ({
          actor,
          setupPromise: new Promise((r) => {
            resolveSetup = r;
          }),
        }),
      },
      {
        get: (obj, key) =>
          key === "then" ? undefined : obj[key] || (() => {}),
      },
    );
    h.pip.openPipWindow = async () => win;
    h.pip.addPiPBrowserToWeakMap = () => {};
    h.pip.addOriginatingWinToWeakMap = () => {};
    h.pip.setUrlbarPipIconActive = () => {};
    h.pip.closeSinglePipWindow = async (value) => closed.push(value);
    const request = h.pip.openPictureInPictureRequest(h.wgp, {
      ...h.data,
      isAutoPip: auto,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.pip.weakAutoPipBrowserToParent.has(h.browser), auto);
    h.browser.documentGlobal.gBrowser.selectedBrowser = h.browser;
    resolveSetup();
    await request;
    assert.equal(closed.length, auto ? 1 : 0);
    if (auto) assert.equal(closed[0].reason, "Foregrounded");
  }
});
