/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (relative) => readFile(new URL(relative, root), "utf8");
const paths = [
  "src/browser/base/content/nsContextMenu-sys-mjs.patch",
  "src/browser/base/content/browser-context-inc-xhtml.patch",
  "src/browser/base/content/browser-context-js.patch",
  "src/browser/components/translations/jar-mn.patch",
];
const [context, menu, command, jar] = await Promise.all(paths.map(read));
for (const [index, patch] of [context, menu, command, jar].entries()) {
  assert.ok(patch.startsWith("diff --git "), `${paths[index]} is a patch`);
  assert.equal(
    patch.split("\n").filter((line) => /^-(?!--)/.test(line)).length,
    0,
    `${paths[index]} preserves existing Firefox code`,
  );
}
const moduleURL =
  "chrome://browser/content/translations/ZenPageTranslations.sys.mjs";
assert.ok(
  context.includes(moduleURL),
  "context menu loads the packaged module",
);
assert.ok(
  jar.includes("content/browser/translations/ZenPageTranslations.sys.mjs"),
);
const moduleSource = await read(
  "src/browser/components/translations/content/ZenPageTranslations.sys.mjs",
);
assert.match(
  moduleSource,
  /resource:\/\/gre\/actors\/TranslationsParent\.sys\.mjs/,
);
assert.match(moduleSource, /\.translate\(languagePair, false\)/);
assert.match(moduleSource, /\.restorePage\(\)/);
assert.ok(moduleSource.includes('const TARGET_LANGUAGE = "ru";'));
assert.ok(moduleSource.includes('"Показать оригинал"'));
assert.ok(menu.includes('id="context-zen-translate-page"'));
assert.ok(menu.includes('label="Перевести на русский"'));
assert.ok(command.includes('case "context-zen-translate-page":'));
assert.ok(
  command.includes("gContextMenu.toggleTranslatePage().catch(console.error)"),
);
assert.ok(context.includes("this.#pageTranslations?.destroy()"));
assert.ok(context.includes("this.showTranslateSelectionItem();"));
assert.ok(context.includes('this.showItem("context-zenSplitLink"'));
assert.ok(context.includes('this.showItem("context-zenOpenLinkInGlance"'));
assert.ok(command.includes("gContextMenu.openSelectTranslationsPanel(event)"));
console.log("CANONICAL_TRANSLATION_WIRING_OK");
