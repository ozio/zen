/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, test } from "node:test";
import vm from "node:vm";

const defaultPairs = [
  { sourceLanguage: "en", targetLanguage: "ru" },
  { sourceLanguage: "ru", targetLanguage: "en" },
  { sourceLanguage: "es", targetLanguage: "en" },
  { sourceLanguage: "en", targetLanguage: "es" },
];
let enabled;
let engineSupported;
let catalog;
let catalogCalls;
let actorLookups;
const TranslationsUtils = {
  langTagsMatch(lhs, rhs) {
    return (
      !!lhs &&
      !!rhs &&
      new Intl.Locale(lhs).language === new Intl.Locale(rhs).language
    );
  },
};
// Mock only the Gecko boundary. The controller and context-menu methods below
// are the canonical production code; assertions inspect native actor calls.
const TranslationsParent = {
  AIFeature: {
    get isEnabled() {
      return enabled;
    },
  },
  getIsTranslationsEngineSupported: () => engineSupported,
  isFullPageTranslationsRestrictedForPage({ selectedBrowser, currentURI }) {
    return (
      selectedBrowser.documentContentType === "application/pdf" ||
      !["http", "https", "file", "moz-extension"].includes(currentURI.scheme)
    );
  },
  getTranslationsActor(browser) {
    actorLookups++;
    if (!browser.actor) {
      throw new Error("No actor for this document");
    }
    return browser.actor;
  },
  getNonPivotLanguagePairs() {
    catalogCalls++;
    return typeof catalog === "function" ? catalog() : Promise.resolve(catalog);
  },
  findCompatibleSourceLangTagSync(langTag, pairs) {
    return (
      pairs.find((pair) =>
        TranslationsUtils.langTagsMatch(pair.sourceLanguage, langTag),
      )?.sourceLanguage ?? null
    );
  },
  findCompatibleTargetLangTagSync(langTag, pairs) {
    return (
      pairs.find((pair) =>
        TranslationsUtils.langTagsMatch(pair.targetLanguage, langTag),
      )?.targetLanguage ?? null
    );
  },
};
globalThis.ChromeUtils = {
  defineESModuleGetters(target, entries) {
    for (const name of Object.keys(entries)) {
      Object.defineProperty(target, name, {
        get: () => ({ TranslationsParent, TranslationsUtils })[name],
      });
    }
  },
};
const { ZenPageTranslations } =
  await import("../../src/browser/components/translations/content/ZenPageTranslations.sys.mjs");

beforeEach(() => {
  enabled = true;
  engineSupported = true;
  catalog = defaultPairs;
  catalogCalls = 0;
  actorLookups = 0;
});

function deferred() {
  return Promise.withResolvers();
}

function makeBrowser({
  lang = "en",
  state = {},
  scheme = "https",
  contentType = "text/html",
} = {}) {
  const browser = new EventTarget();
  browser.isConnected = true;
  browser.browsingContext = { currentWindowGlobal: {} };
  browser.currentURI = { scheme };
  browser.documentContentType = contentType;
  const langTags = {
    docLangTag: lang,
    userLangTag: null,
    isDocLangTagSupported: true,
  };
  const calls = { translate: [], restore: [], detect: 0 };
  const actor = {
    languageState: {
      detectedLanguages: null,
      requestedLanguagePair: null,
      hasVisibleChange: false,
      error: null,
      isEngineReady: false,
      ...state,
    },
    isTopLevelActor: () => true,
    async getLangTags() {
      calls.detect++;
      actor.setState({ detectedLanguages: langTags });
      return langTags;
    },
    setState(patch) {
      Object.assign(actor.languageState, patch);
      browser.dispatchEvent(
        new CustomEvent("TranslationsParent:LanguageState", {
          detail: { actor },
        }),
      );
    },
    async translate(...args) {
      calls.translate.push(args);
      actor.setState({
        requestedLanguagePair: args[0],
        error: null,
        isEngineReady: true,
      });
    },
    restorePage(...args) {
      calls.restore.push(args);
      actor.setState({
        requestedLanguagePair: null,
        hasVisibleChange: false,
        error: null,
      });
    },
  };
  browser.actor = actor;
  return { browser, actor, calls, langTags };
}

function makeMenu(
  t,
  browser,
  {
    item = {},
    windowGlobal = browser.browsingContext.currentWindowGlobal,
  } = {},
) {
  let updates = 0;
  const menu = new ZenPageTranslations(
    browser,
    windowGlobal,
    item,
    () => updates++,
  );
  t.after(() => menu.destroy());
  return { menu, item, updates: () => updates };
}

test("English in preferred languages still invokes the native actor with fixed ru and manual telemetry", async (t) => {
  const { browser, calls } = makeBrowser({ lang: "en-GB" });
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  assert.equal(item.hidden, false);
  assert.equal(item.disabled, false);
  assert.equal(item.label, "Перевести на русский");
  assert.equal(await menu.toggle(), true);
  assert.deepEqual(calls.translate, [
    [{ sourceLanguage: "en", targetLanguage: "ru" }, false],
  ]);
  assert.equal(item.label, "Показать оригинал");
  assert.equal(await menu.toggle(), true);
  assert.deepEqual(calls.restore, [[]]);
  assert.equal(
    await menu.toggle(),
    false,
    "reload of the same old actor cannot be repeated",
  );
});

for (const lang of ["ru", "ru-RU", "zz", null]) {
  test(`original ${lang} page cannot start an unsupported or same-language translation`, async (t) => {
    const { browser, calls } = makeBrowser({ lang });
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, true);
    assert.equal(await menu.toggle(), false);
    assert.deepEqual(calls.translate, []);
    assert.deepEqual(calls.restore, []);
  });
}

test("missing Russian target catalog entry hides the action", async (t) => {
  catalog = defaultPairs.filter((pair) => pair.targetLanguage !== "ru");
  const { browser, calls } = makeBrowser({ lang: "es" });
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  assert.equal(item.hidden, true);
  assert.equal(await menu.toggle(), false);
  assert.deepEqual(calls.translate, []);
});

for (const feature of ["disabled", "hardware unsupported"]) {
  test(`${feature} never acquires the native actor`, async (t) => {
    enabled = feature !== "disabled";
    engineSupported = feature !== "hardware unsupported";
    const { browser, calls } = makeBrowser();
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, true);
    assert.equal(await menu.toggle(), false);
    assert.equal(actorLookups, 0);
    assert.equal(catalogCalls, 0);
    assert.equal(calls.detect, 0);
  });
}

for (const scheme of ["about", "chrome", "resource", "data", "blob"]) {
  test(`${scheme} pages respect Firefox full-page restrictions`, async (t) => {
    const { browser, calls } = makeBrowser({ scheme });
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, true);
    assert.equal(await menu.toggle(), false);
    assert.equal(actorLookups, 0);
    assert.deepEqual(calls.translate, []);
  });
}

test("PDF page respects the native content-type restriction", async (t) => {
  const { browser } = makeBrowser({ contentType: "application/pdf" });
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  assert.equal(item.hidden, true);
  assert.equal(await menu.toggle(), false);
  assert.equal(actorLookups, 0);
});

for (const scheme of ["file", "moz-extension"]) {
  test(`${scheme} tab follows native supported-page rules`, async (t) => {
    const { browser, calls } = makeBrowser({ scheme });
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, false);
    await menu.toggle();
    assert.equal(calls.translate.length, 1);
  });
}

for (const state of [
  { requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" } },
  { requestedLanguagePair: { sourceLanguage: "ru", targetLanguage: "en" } },
  { requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "de" } },
  { hasVisibleChange: true, error: "engine-load-failure" },
]) {
  test(`active/partial translation restores original without catalog: ${JSON.stringify(state)}`, async (t) => {
    catalog = () => {
      throw new Error("Catalog must not be consulted for restore");
    };
    const { browser, calls } = makeBrowser({ lang: "ru", state });
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, false);
    assert.equal(
      item.disabled,
      false,
      "native pending model downloads can be cancelled",
    );
    assert.equal(item.label, "Показать оригинал");
    assert.equal(catalogCalls, 0);
    assert.equal(calls.detect, 0);
    assert.equal(await menu.toggle(), true);
    assert.deepEqual(calls.restore, [[]]);
    assert.deepEqual(calls.translate, []);
    assert.equal(
      item.disabled,
      true,
      "restore awaits the original document's reload",
    );
    assert.equal(item.label, "Показать оригинал");
  });
}

test("startup lock survives menu reopening and rejects duplicate native translation", async (t) => {
  const started = deferred();
  const { browser, actor, calls } = makeBrowser();
  actor.translate = async (...args) => {
    calls.translate.push(args);
    await started.promise;
    actor.setState({ requestedLanguagePair: args[0], isEngineReady: false });
  };
  const first = makeMenu(t, browser);
  await first.menu.init();
  const translate = first.menu.toggle();
  assert.equal(first.item.disabled, true);
  assert.equal(await first.menu.toggle(), false);
  first.menu.destroy();
  const second = makeMenu(t, browser);
  await second.menu.init();
  assert.equal(second.item.disabled, true);
  assert.equal(await second.menu.toggle(), false);
  assert.equal(calls.translate.length, 1);
  started.resolve();
  assert.equal(await translate, true);
  assert.equal(second.item.label, "Показать оригинал");
  assert.equal(
    second.item.disabled,
    false,
    "native activation allows cancellation in the open menu",
  );
  assert.equal(await second.menu.toggle(), true);
  assert.equal(calls.restore.length, 1);
});

test("a native active request can be restored even before translate's promise settles", async (t) => {
  const started = deferred();
  const { browser, actor, calls } = makeBrowser();
  actor.translate = async (...args) => {
    calls.translate.push(args);
    actor.setState({ requestedLanguagePair: args[0], isEngineReady: false });
    await started.promise;
  };
  const first = makeMenu(t, browser);
  await first.menu.init();
  const translate = first.menu.toggle();
  const second = makeMenu(t, browser);
  await second.menu.init();
  assert.equal(second.item.label, "Показать оригинал");
  assert.equal(second.item.disabled, false);
  assert.equal(await second.menu.toggle(), true);
  assert.equal(calls.restore.length, 1);
  started.resolve();
  await translate;
  assert.equal(
    second.item.disabled,
    true,
    "settling old startup does not release the reload lock",
  );
  assert.equal(await second.menu.toggle(), false);
});

test("language detection is disabled while pending and can retry after lookup failure", async (t) => {
  const lookup = deferred();
  const { browser, actor, calls, langTags } = makeBrowser();
  actor.getLangTags = () => lookup.promise;
  const first = makeMenu(t, browser);
  const init = first.menu.init();
  assert.equal(first.item.hidden, false);
  assert.equal(first.item.disabled, true);
  assert.equal(await first.menu.toggle(), false);
  lookup.reject(new Error("Language lookup failed"));
  await assert.rejects(init, /Language lookup failed/);
  assert.equal(first.item.hidden, true);
  first.menu.destroy();
  actor.getLangTags = async () => {
    actor.setState({ detectedLanguages: langTags });
    return langTags;
  };
  const retry = makeMenu(t, browser);
  await retry.menu.init();
  assert.equal(retry.item.disabled, false);
  await retry.menu.toggle();
  assert.equal(calls.translate.length, 1);
});

test("native translation rejection releases the startup lock for retry", async (t) => {
  const { browser, actor, calls } = makeBrowser();
  let attempt = 0;
  actor.translate = async (...args) => {
    calls.translate.push(args);
    if (++attempt === 1) {
      actor.setState({
        error: "engine-load-failure",
        requestedLanguagePair: null,
      });
      throw new Error("Native translation failed");
    }
    actor.setState({ requestedLanguagePair: args[0] });
  };
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  await assert.rejects(menu.toggle(), /Native translation failed/);
  assert.equal(item.disabled, false);
  assert.equal(item.label, "Перевести на русский");
  assert.equal(await menu.toggle(), true);
  assert.equal(calls.translate.length, 2);
});

test("initial native engine error with no visible changes offers retry", async (t) => {
  const { browser, calls } = makeBrowser({
    state: { error: "engine-load-failure" },
  });
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  assert.equal(item.hidden, false);
  assert.equal(item.disabled, false);
  await menu.toggle();
  assert.equal(calls.translate.length, 1);
  assert.equal(calls.restore.length, 0);
});

test("an open restore menu offers retry when native model loading fails before changing content", async (t) => {
  const { browser, actor, calls } = makeBrowser({
    state: {
      requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
    },
  });
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  assert.equal(item.label, "Показать оригинал");
  actor.setState({ requestedLanguagePair: null, error: "engine-load-failure" });
  await new Promise(setImmediate);
  assert.equal(item.label, "Перевести на русский");
  assert.equal(item.hidden, false);
  assert.equal(item.disabled, false);
  await menu.toggle();
  assert.equal(calls.translate.length, 1);
  assert.equal(calls.restore.length, 0);
});

test("a non-top-level or uninitialized native actor never receives a page action", async (t) => {
  for (const kind of ["subframe", "uninitialized"]) {
    const { browser, actor, calls } = makeBrowser({
      state: {
        requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
      },
    });
    if (kind === "subframe") {
      actor.isTopLevelActor = () => false;
    } else {
      actor.languageState = null;
    }
    const { menu, item } = makeMenu(t, browser);
    await menu.init();
    assert.equal(item.hidden, true);
    assert.equal(await menu.toggle(), false);
    assert.equal(calls.translate.length, 0);
    assert.equal(calls.restore.length, 0);
  }
});

test("navigation after opening refuses the old document and never acquires the new actor", async (t) => {
  const { browser, calls } = makeBrowser();
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  const previousLookups = actorLookups;
  browser.browsingContext.currentWindowGlobal = {};
  browser.actor = makeBrowser().actor;
  assert.equal(await menu.toggle(), false);
  assert.equal(actorLookups, previousLookups);
  assert.deepEqual(calls.translate, []);
  assert.deepEqual(calls.restore, []);
  menu.destroy();
  assert.equal(await menu.toggle(), false);
  assert.equal(item.label, "Перевести на русский");
});

test("closed tab or mismatched right-click WindowGlobal cannot acquire an actor", async (t) => {
  const closed = makeBrowser();
  closed.browser.isConnected = false;
  const first = makeMenu(t, closed.browser);
  await first.menu.init();
  assert.equal(first.item.hidden, true);
  const other = makeBrowser();
  const second = makeMenu(t, other.browser, { windowGlobal: {} });
  await second.menu.init();
  assert.equal(second.item.hidden, true);
  assert.equal(await first.menu.toggle(), false);
  assert.equal(await second.menu.toggle(), false);
  assert.equal(actorLookups, 0);
});

test("actor replacement within the same document refuses a stale command", async (t) => {
  const { browser, calls } = makeBrowser();
  const { menu } = makeMenu(t, browser);
  await menu.init();
  browser.actor = makeBrowser().actor;
  assert.equal(await menu.toggle(), false);
  assert.deepEqual(calls.translate, []);
  assert.deepEqual(calls.restore, []);
});

test("late language detection cannot overwrite a later menu's shared item", async (t) => {
  const lookup = deferred();
  const old = makeBrowser();
  old.actor.getLangTags = () => lookup.promise;
  const item = {};
  const first = makeMenu(t, old.browser, { item });
  const init = first.menu.init();
  first.menu.destroy();
  old.browser.browsingContext.currentWindowGlobal = {};
  const fresh = makeBrowser({
    state: {
      requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
    },
  });
  const second = makeMenu(t, fresh.browser, { item });
  await second.menu.init();
  const visibleState = { ...item };
  old.actor.languageState.detectedLanguages = old.langTags;
  lookup.resolve(old.langTags);
  await init;
  assert.deepEqual(item, visibleState);
  assert.equal(second.item.label, "Показать оригинал");
  assert.equal(await first.menu.toggle(), false);
});

test("state events belong to the captured actor and listeners are removed on close", async (t) => {
  const { browser, actor } = makeBrowser();
  const { menu, item, updates } = makeMenu(t, browser);
  await menu.init();
  const before = updates();
  browser.dispatchEvent(
    new CustomEvent("TranslationsParent:LanguageState", {
      detail: { actor: {} },
    }),
  );
  assert.equal(updates(), before);
  actor.setState({
    requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
  });
  assert.equal(item.label, "Показать оригинал");
  menu.destroy();
  const closedUpdates = updates();
  const closedItem = { ...item };
  actor.setState({ requestedLanguagePair: null });
  assert.equal(updates(), closedUpdates);
  assert.deepEqual(item, closedItem);
});

test("capability disabled while menu is open refuses commands", async (t) => {
  const { browser, actor, calls } = makeBrowser();
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  enabled = false;
  actor.setState({ error: null });
  assert.equal(item.hidden, true);
  assert.equal(await menu.toggle(), false);
  assert.deepEqual(calls.translate, []);
});

test("restore exception removes the lock so the real original can be requested again", async (t) => {
  const { browser, actor, calls } = makeBrowser({
    state: {
      requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
    },
  });
  let attempt = 0;
  actor.restorePage = (...args) => {
    calls.restore.push(args);
    if (++attempt === 1) {
      throw new Error("Reload refused");
    }
  };
  const { menu, item } = makeMenu(t, browser);
  await menu.init();
  await assert.rejects(menu.toggle(), /Reload refused/);
  assert.equal(item.disabled, false);
  assert.equal(await menu.toggle(), true);
  assert.deepEqual(calls.restore, [[], []]);
});

test("two browsers translate independently and never act on the newly selected browser", async (t) => {
  const first = makeBrowser({ lang: "es" });
  const second = makeBrowser({ lang: "en" });
  const firstMenu = makeMenu(t, first.browser);
  const secondMenu = makeMenu(t, second.browser);
  await Promise.all([firstMenu.menu.init(), secondMenu.menu.init()]);
  // No global selectedBrowser is provided: the API must receive each right-click owner.
  await Promise.all([firstMenu.menu.toggle(), secondMenu.menu.toggle()]);
  assert.deepEqual(first.calls.translate, [
    [{ sourceLanguage: "es", targetLanguage: "ru" }, false],
  ]);
  assert.deepEqual(second.calls.translate, [
    [{ sourceLanguage: "en", targetLanguage: "ru" }, false],
  ]);
});

test("the native reload's new document gets an unlocked translation action", async (t) => {
  const old = makeBrowser({
    state: {
      requestedLanguagePair: { sourceLanguage: "en", targetLanguage: "ru" },
    },
  });
  const first = makeMenu(t, old.browser);
  await first.menu.init();
  await first.menu.toggle();
  first.menu.destroy();
  const fresh = makeBrowser();
  old.browser.browsingContext.currentWindowGlobal = {};
  old.browser.actor = fresh.actor;
  const second = makeMenu(t, old.browser);
  await second.menu.init();
  assert.equal(second.item.label, "Перевести на русский");
  assert.equal(second.item.disabled, false);
  assert.equal(await second.menu.toggle(), true);
  assert.equal(fresh.calls.translate.length, 1);
  assert.equal(old.calls.translate.length, 0);
  assert.equal(old.calls.restore.length, 1);
});

// Execute the real nsContextMenu methods from the canonical patch without a
// Firefox engine checkout or unrelated browser-window initialization.
const contextPatch = await readFile(
  new URL(
    "../../src/browser/base/content/nsContextMenu-sys-mjs.patch",
    import.meta.url,
  ),
  "utf8",
);
const added = contextPatch
  .split("\n")
  .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
  .map((line) => line.slice(1));
const methods = added
  .slice(added.indexOf("  showTranslatePageItem() {"))
  .join("\n");
function makeContext() {
  const constructors = [];
  const commands = [];
  class Controller {
    constructor(...args) {
      constructors.push(args);
    }
    async init() {}
    async toggle() {
      commands.push("toggle");
      return true;
    }
  }
  const sandbox = vm.createContext({
    lazy: { ZenPageTranslations: Controller },
    console,
  });
  new vm.Script(
    `globalThis.Context = class { #pageTranslations = null; ${methods} };`,
  ).runInContext(sandbox);
  const context = new sandbox.Context();
  const item = {};
  Object.assign(context, {
    inTabBrowser: true,
    document: { getElementById: () => item },
    browser: {},
    actor: { manager: {} },
    window: { browsingContext: { isDocumentPiP: false } },
    showHideSeparators() {},
  });
  return { context, item, constructors, commands };
}

test("actual context-menu hook captures the clicked browser and ContextMenu WindowGlobal", async () => {
  const { context, constructors, commands } = makeContext();
  context.showTranslatePageItem();
  assert.equal(constructors.length, 1);
  assert.equal(constructors[0][0], context.browser);
  assert.equal(constructors[0][1], context.actor.manager);
  assert.equal(await context.toggleTranslatePage(), true);
  assert.deepEqual(commands, ["toggle"]);
});

for (const flag of [
  "inAboutDevtoolsToolbox",
  "inWebExtBrowser",
  "inFrame",
  "inSyntheticDoc",
  "isContentSelected",
  "isTextSelected",
  "onLink",
  "onPlainTextLink",
  "onImage",
  "onCanvas",
  "onVideo",
  "onAudio",
  "onTextInput",
  "onEditable",
]) {
  test(`actual context-menu hook keeps ${flag} out of the page action`, async () => {
    const { context, item, constructors, commands } = makeContext();
    context[flag] = true;
    context.showTranslatePageItem();
    assert.equal(item.hidden, true);
    assert.equal(constructors.length, 0);
    assert.equal(await context.toggleTranslatePage(), false);
    assert.deepEqual(commands, []);
  });
}

test("actual context-menu hook excludes PiP and non-tab browsers", async () => {
  for (const option of ["pip", "non-tab"]) {
    const { context, constructors } = makeContext();
    if (option === "pip") {
      context.window.browsingContext.isDocumentPiP = true;
    } else {
      context.inTabBrowser = false;
    }
    context.showTranslatePageItem();
    assert.equal(constructors.length, 0);
    assert.equal(await context.toggleTranslatePage(), false);
  }
});

test("the actual browser-context command dispatches only the new page action", async () => {
  const patch = await readFile(
    new URL(
      "../../src/browser/base/content/browser-context-js.patch",
      import.meta.url,
    ),
    "utf8",
  );
  const addedCommands = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
  let calls = 0;
  const sandbox = vm.createContext({
    console,
    gContextMenu: {
      async toggleTranslatePage() {
        calls++;
      },
    },
  });
  new vm.Script(
    `globalThis.dispatch = event => { switch (event.target.id) { ${addedCommands} } };`,
  ).runInContext(sandbox);
  sandbox.dispatch({ target: { id: "context-translate-selection" } });
  assert.equal(calls, 0);
  sandbox.dispatch({ target: { id: "context-zen-translate-page" } });
  assert.equal(calls, 1);
});
