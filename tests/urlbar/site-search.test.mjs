import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Run the canonical patch against the bootstrapped Firefox base, so a stale
// generated engine cannot make a changed implementation look green.
const root = fileURLToPath(new URL("../../", import.meta.url));
const target = "browser/components/urlbar/content/UrlbarInput.mjs";
const dir = mkdtempSync(join(tmpdir(), "zen-site-search-"));
let source;
try {
  mkdirSync(join(dir, dirname(target)), { recursive: true });
  writeFileSync(
    join(dir, target),
    execFileSync("git", ["show", `HEAD:${target}`], {
      cwd: join(root, "engine"),
    }),
  );
  execFileSync("git", ["apply", "--"], {
    cwd: dir,
    input: readFileSync(
      join(root, "src/browser/components/urlbar/content/UrlbarInput-mjs.patch"),
    ),
  });
  source = readFileSync(join(dir, target), "utf8");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
class Base {
  constructor() {
    this.window = { gBrowser: { selectedBrowser: {} } };
    this.inputField = {};
    this.value = "";
    this.view = {
      isResultMenuOpen: () => false,
      oneOffSearchButtons: { selectedButton: "stale" },
    };
    this.controller = {
      engineStore: { initialized: true, getEngines: () => engines },
    };
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.fallback = [];
  }
  _on_keydown(event) {
    this.fallback.push(event.key);
  }
  search(value) {
    this.value = value;
    this.userTypedValue = value;
  }
}
const context = vm.createContext({
  UrlbarInputBase: Base,
  customElements: { define() {} },
});
vm.runInContext(
  source.replace(/^import[\s\S]*?;\s*$/gm, "").replaceAll("export ", "") +
    "\nglobalThis.api={UrlbarInput,matchZenSiteSearch};",
  context,
);
const { UrlbarInput, matchZenSiteSearch: match } = context.api;
const engines = [
  { name: "Google Maps", aliases: ["maps"] },
  { name: "Google", aliases: ["g"] },
  { name: "Mercury", aliases: ["mer"] },
  { name: "メルカリ", aliases: ["mercari"] },
  { name: "Hidden", hideOneOffButton: true },
];
test("exact names and aliases beat earlier prefix matches; case and Unicode normalize", () => {
  assert.equal(match(" Google ", engines).name, "Google");
  assert.equal(match("g", engines).name, "Google");
  assert.equal(match("ＭＥＲ", engines).name, "Mercury");
  assert.equal(match("ﾒﾙ", engines).name, "メルカリ");
});
test("partial names follow the explicit settings order and support the Arc one-letter example", () => {
  assert.equal(match("goo", engines).name, "Google Maps");
  assert.equal(match("m", engines).name, "Mercury");
});
test("empty, unknown, hidden and URL inputs have no site-name shortcut", () => {
  for (const text of [
    "",
    " ",
    "ordinary question",
    "Hidden",
    "https://Mercury/",
    "Mercury/path",
    "Mercury?q=one",
    "Mercury#one",
  ]) {
    assert.equal(match(text, engines), null, text);
  }
});
function harness(text = "mer") {
  const input = new UrlbarInput();
  input.value = text;
  input.userTypedValue = text;
  return input;
}
function key(input, key, options = {}) {
  const event = {
    key,
    target: input.inputField,
    currentTarget: input.inputField,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...options,
  };
  input._on_keydown(event);
  return event;
}
test("Tab consumes an engine name and starts an empty confirmed search mode", () => {
  const input = harness();
  const event = key(input, "Tab");
  assert.equal(input.searchMode.engineName, "Mercury");
  assert.equal(input.searchMode.isPreview, false);
  assert.equal(input.value, "");
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});
test("autocomplete text does not replace the typed trigger", () => {
  const input = harness();
  input.value = "mercari.example.com";
  key(input, "Tab");
  assert.equal(input.searchMode.engineName, "Mercury");
});
test("one Escape exits and restores the empty-mode trigger; a query is retained", () => {
  for (const text of ["", "red shoes"]) {
    const input = harness();
    key(input, "Tab");
    input.value = text;
    const event = key(input, "Escape");
    assert.equal(input.searchMode, null);
    assert.equal(input.value, text || "mer");
    assert.equal(input.view.oneOffSearchButtons.selectedButton, null);
    assert.equal(event.prevented, true);
    assert.equal(input.fallback.length, 0);
  }
});
test("Backspace at an empty query leaves the mode immediately or after deleting a query", () => {
  for (const hadQuery of [false, true]) {
    const input = harness();
    key(input, "Tab");
    if (hadQuery) {
      input.value = "shoes";
      input.value = "";
    }
    assert.equal(key(input, "Backspace").prevented, true);
    assert.equal(input.searchMode, null);
    assert.equal(input.value, "mer");
  }
});
test("Backspace at column zero does not leave a nonempty query", () => {
  const input = harness();
  key(input, "Tab");
  input.value = "red shoes";
  assert.equal(key(input, "Backspace").prevented, true);
  assert.equal(input.searchMode.engineName, "Mercury");
  assert.equal(input.value, "red shoes");
  input.selectionStart = 4;
  input.selectionEnd = 4;
  assert.equal(key(input, "Backspace").prevented, undefined);
  assert.deepEqual(input.fallback, ["Backspace"]);
});
test("modified Tab, IME, menu navigation, window events and unknown queries retain native handling", () => {
  for (const options of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    const input = harness();
    assert.equal(key(input, "Tab", options).prevented, undefined);
    assert.equal(input.searchMode, undefined);
  }
  for (const kind of ["ime", "menu", "window", "unknown"]) {
    const input = harness();
    if (kind === "ime") input.isComposing = true;
    if (kind === "menu") input.view.isResultMenuOpen = () => true;
    if (kind === "unknown")
      input.value = input.userTypedValue = "ordinary question";
    assert.equal(
      key(
        input,
        "Tab",
        kind === "window" ? { currentTarget: input.window } : {},
      ).prevented,
      undefined,
    );
    assert.equal(input.searchMode, undefined);
  }
});
test("a trigger from another tab cannot leak into the current tab", () => {
  const input = harness();
  key(input, "Tab");
  input.window.gBrowser.selectedBrowser = {};
  key(input, "Escape");
  assert.equal(input.value, "");
});
