// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  paginate,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  event: "chrome://remote/content/shared/webdriver/Event.sys.mjs",
  interaction: "chrome://remote/content/marionette/interaction.sys.mjs",
});

const PAGE_SELECTOR =
  "body,a[href],button,input,textarea,select,option,[role],[aria-label],[contenteditable],h1,h2,h3,h4,h5,h6,main,nav,header,footer,section,article,form,dialog,summary,details,iframe,[tabindex]";
const CHROME_SELECTOR =
  "button,toolbarbutton,menu,menuitem,menulist,menupopup,input,textarea,select,checkbox,radio,tab,[role],[aria-label],[data-l10n-id],[command],a[href]";
const MAX_SCANNED = 20000;

export function documentIdentity(win) {
  return String(
    win.windowGlobalChild?.innerWindowId ??
      win.windowUtils.currentInnerWindowID,
  );
}

export function elementFingerprint(element) {
  return JSON.stringify([
    element.localName,
    element.id,
    element.getAttribute("role"),
    element.getAttribute("type"),
    element.getAttribute("href"),
    element.getAttribute("aria-label"),
    element.getAttribute("label"),
    element.getAttribute("data-l10n-id"),
    (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
  ]);
}

export function nativeMenuVisible(element) {
  if (!["menu", "menuitem", "menupopup"].includes(element.localName)) {
    return false;
  }
  const popup =
    element.localName === "menupopup" ? element : element.closest("menupopup");
  if (!popup || popup.state !== "open") {
    return false;
  }
  for (let node = element; node && node !== popup; node = node.parentElement) {
    const style = element.ownerGlobal.getComputedStyle(node);
    if (
      node.hidden ||
      style.display === "none" ||
      style.visibility === "hidden"
    ) {
      return false;
    }
  }
  return true;
}

export function visibleElement(element) {
  if (nativeMenuVisible(element)) {
    return true;
  }
  const win = element.ownerGlobal || element.ownerDocument.defaultView;
  const rect = element.getBoundingClientRect();
  const style = win.getComputedStyle(element);
  return (
    !element.hidden &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    rect.width > 0 &&
    rect.height > 0 &&
    (!element.checkVisibility ||
      element.checkVisibility({ checkVisibilityCSS: true }))
  );
}

function roleFor(element) {
  if (element.getAttribute("role")) {
    return element.getAttribute("role");
  }
  const tag = element.localName;
  if (tag === "input") {
    return (
      {
        checkbox: "checkbox",
        radio: "radio",
        submit: "button",
        button: "button",
        range: "slider",
      }[element.type] || "textbox"
    );
  }
  if (/^h[1-6]$/.test(tag)) {
    return "heading";
  }
  return (
    {
      a: "link",
      button: "button",
      toolbarbutton: "button",
      textarea: "textbox",
      select: "combobox",
      option: "option",
      menu: "menu",
      menuitem: "menuitem",
      tab: "tab",
      main: "main",
      nav: "navigation",
      form: "form",
      dialog: "dialog",
      iframe: "frame",
      body: "document",
    }[tag] || tag
  );
}

function labelFor(element) {
  const doc = element.ownerDocument;
  const root = element.getRootNode?.() || doc;
  const labelledBy = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean);
  const labelledText = labelledBy
    .map(
      (id) =>
        root.getElementById?.(id)?.textContent ||
        doc.getElementById(id)?.textContent ||
        "",
    )
    .join(" ")
    .trim();
  return (
    element.getAttribute("aria-label") ||
    labelledText ||
    element.getAttribute("label") ||
    [...(element.labels || [])]
      .map((label) => label.textContent)
      .join(" ")
      .trim() ||
    element.getAttribute("alt") ||
    element.getAttribute("title") ||
    element.getAttribute("tooltiptext") ||
    element.getAttribute("placeholder") ||
    element.textContent ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export function describeElement(element, elementId) {
  const rect = element.getBoundingClientRect();
  const result = {
    elementId,
    tag: element.localName,
    role: roleFor(element),
    name: labelFor(element),
    text: (element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
    visible: visibleElement(element),
    disabled: !!element.disabled || element.getAttribute("disabled") === "true",
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  };
  for (const attribute of [
    "id",
    "type",
    "href",
    "aria-expanded",
    "aria-selected",
    "aria-checked",
    "data-l10n-id",
  ]) {
    const value = element.getAttribute(attribute);
    if (value !== null && value !== "") {
      result[attribute] = value;
    }
  }
  if (
    "value" in element &&
    element.type !== "password" &&
    element.type !== "file"
  ) {
    result.value = String(element.value).slice(0, 1000);
  }
  if ("checked" in element) {
    result.checked = !!element.checked;
  }
  if (nativeMenuVisible(element)) {
    result.nativeMenu = true;
  }
  if (
    ["iframe", "frame"].includes(element.localName) &&
    element.browsingContext
  ) {
    result.frameId = String(element.browsingContext.id);
  }
  return result;
}

/** Bounded traversal, including open shadow roots; never enters an iframe. */
export function scanElements(doc, selector, includeHidden = false) {
  const roots = [doc];
  const elements = [];
  let scanned = 0;
  try {
    // Parse before a walk that might encounter no elements.
    doc.querySelector(selector);
    for (let index = 0; index < roots.length; index++) {
      const walker = doc.createTreeWalker(roots[index], 1);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (++scanned > MAX_SCANNED) {
          return { elements, scanned: MAX_SCANNED, scanTruncated: true };
        }
        if (node.shadowRoot) {
          roots.push(node.shadowRoot);
        }
        if (node.matches(selector) && (includeHidden || visibleElement(node))) {
          elements.push(node);
        }
      }
    }
  } catch (error) {
    if (error.name === "SyntaxError") {
      throw new McpToolError("invalid_selector", "selector must be valid CSS");
    }
    throw error;
  }
  return { elements, scanned, scanTruncated: false };
}

export function snapshotDocument(
  win,
  store,
  clientId,
  targetId,
  args = {},
  chrome = false,
) {
  const { elements, scanned, scanTruncated } = scanElements(
    win.document,
    args.selector || (chrome ? CHROME_SELECTOR : PAGE_SELECTOR),
    args.includeHidden === true,
  );
  const page = paginate(elements, args);
  const references = new Map();
  const summaries = page.items.map((element, index) => {
    const elementId = `e${index + 1}`;
    references.set(elementId, {
      reference: new WeakRef(element),
      fingerprint: elementFingerprint(element),
    });
    return describeElement(element, elementId);
  });
  const documentId = documentIdentity(win);
  const snapshotId = store.create(clientId, targetId, documentId, references);
  return {
    documentId,
    snapshotId,
    expiresInMs: 30000,
    url: win.document.documentURI,
    title: win.document.title,
    readyState: win.document.readyState,
    viewport: {
      width: win.innerWidth,
      height: win.innerHeight,
      x: win.scrollX,
      y: win.scrollY,
    },
    elements: summaries,
    total: page.total,
    scanned,
    scanTruncated,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export function takeElement(win, store, clientId, targetId, args) {
  requireValue(
    typeof args.snapshotId === "string" && typeof args.elementId === "string",
    "missing_element",
    "snapshotId and elementId from a fresh snapshot are required",
  );
  requireValue(
    typeof args.documentId === "string",
    "missing_document",
    "documentId from the snapshot is required",
  );
  const documentId = documentIdentity(win);
  requireValue(
    args.documentId === documentId,
    "stale_document",
    "The document changed; inspect it again",
  );
  const references = store.take(
    args.snapshotId,
    clientId,
    targetId,
    documentId,
  );
  const stored = references.get(args.elementId);
  const element = stored?.reference.deref();
  requireValue(
    element?.isConnected && element.ownerDocument === win.document,
    "stale_element",
    "The element was removed; inspect it again",
  );
  requireValue(
    stored.fingerprint === elementFingerprint(element),
    "changed_element",
    "The element changed; inspect it again",
  );
  return element;
}

export const ACTIONS = [
  "click",
  "double_click",
  "context_click",
  "hover",
  "focus",
  "input",
  "key",
  "select",
  "check",
  "scroll",
  "submit",
  "upload",
  "open_menu",
  "close_menu",
];

export function validateAction(args) {
  requireValue(
    ACTIONS.includes(args.action),
    "invalid_action",
    "Unknown element action",
  );
  if (args.action === "input") {
    requireValue(
      typeof args.text === "string" && args.text.length <= 1000000,
      "invalid_text",
      "text must be a string of at most 1000000 characters",
    );
  }
  if (args.action === "key") {
    requireValue(
      typeof args.key === "string" &&
        args.key.length > 0 &&
        args.key.length <= 128,
      "invalid_key",
      "key must be a character or a DOM key name",
    );
    requireValue(
      args.modifiers === undefined ||
        (Array.isArray(args.modifiers) &&
          args.modifiers.every((key) =>
            ["shift", "ctrl", "alt", "meta"].includes(key),
          )),
      "invalid_modifiers",
      "modifiers may contain shift, ctrl, alt and meta",
    );
  }
  if (args.action === "select") {
    requireValue(
      Array.isArray(args.values) &&
        args.values.length > 0 &&
        args.values.length <= 500 &&
        args.values.every((value) => typeof value === "string"),
      "invalid_values",
      "values must be a nonempty list of option values",
    );
  }
  if (args.action === "check") {
    requireValue(
      typeof args.checked === "boolean",
      "invalid_checked",
      "checked must be a boolean",
    );
  }
  if (args.action === "scroll") {
    requireValue(
      [args.deltaX ?? 0, args.deltaY ?? 0].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100000,
      ),
      "invalid_scroll",
      "scroll deltas must be finite and no larger than 100000 CSS pixels",
    );
  }
  if (args.action === "upload") {
    requireValue(
      Array.isArray(args.paths) &&
        args.paths.length <= 100 &&
        args.paths.every(
          (path) =>
            typeof path === "string" &&
            /^(\/|[A-Za-z]:[\\/])/.test(path) &&
            !path.includes("\0"),
        ),
      "invalid_paths",
      "paths must be absolute file paths (at most 100 files)",
    );
  }
}

function clickablePoint(win, element) {
  element.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  });
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left),
    right = Math.min(win.innerWidth, rect.right);
  const top = Math.max(0, rect.top),
    bottom = Math.min(win.innerHeight, rect.bottom);
  requireValue(
    right > left && bottom > top,
    "not_interactable",
    "The element is outside the viewport",
  );
  const point = { x: (left + right) / 2, y: (top + bottom) / 2 };
  let hit = win.document.elementFromPoint(point.x, point.y);
  while (hit?.shadowRoot) {
    const next = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!next || next === hit) {
      break;
    }
    hit = next;
  }
  requireValue(
    hit === element || element.contains(hit),
    "click_intercepted",
    "Another element covers this target; inspect it again",
  );
  return point;
}

function controlEvent(win, element, type) {
  // Ordinary dispatchEvent produces an untrusted event. Privileged PresShell
  // dispatch gives form/file controls the native trusted input/change signal.
  win.windowUtils.dispatchDOMEventViaPresShellForTesting(
    element,
    new win.Event(type, { bubbles: true, composed: type === "input" }),
  );
}

/** Uses Gecko's trusted WebDriver event helpers without starting a remote agent. */
export async function performAction(win, element, args, chrome = false) {
  validateAction(args);
  const expectedDocumentId = documentIdentity(win);
  const expectedDocument = element.ownerDocument;
  const assertCurrent = () =>
    requireValue(
      win.document === expectedDocument &&
        documentIdentity(win) === expectedDocumentId,
      "stale_document",
      "The document changed during the action; inspect the tab before retrying",
    );
  assertCurrent();
  requireValue(
    !element.disabled && element.getAttribute("disabled") !== "true",
    "disabled_element",
    "The element is disabled",
  );
  if (!["upload", "close_menu"].includes(args.action)) {
    requireValue(
      visibleElement(element),
      "hidden_element",
      "The element is hidden",
    );
  }
  const userInput = win.windowUtils.setHandlingUserInput(true);
  try {
    switch (args.action) {
      case "click":
        if (
          chrome &&
          nativeMenuVisible(element) &&
          typeof element.doCommand === "function"
        ) {
          element.doCommand();
        } else if (
          element.namespaceURI ===
          "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"
        ) {
          const point = clickablePoint(win, element);
          await lazy.event.synthesizeMouseAtPoint(point.x, point.y, {}, win);
        } else {
          await lazy.interaction.clickElement(element, false, true);
        }
        break;
      case "double_click":
      case "context_click":
      case "hover": {
        const point = clickablePoint(win, element);
        if (args.action === "context_click") {
          for (const type of ["mousedown", "contextmenu", "mouseup"]) {
            assertCurrent();
            await lazy.event.synthesizeMouseAtPoint(
              point.x,
              point.y,
              { type, button: 2 },
              win,
            );
          }
        } else if (args.action === "double_click") {
          await lazy.event.synthesizeMouseAtPoint(
            point.x,
            point.y,
            { clickCount: 1 },
            win,
          );
          assertCurrent();
          await lazy.event.synthesizeMouseAtPoint(
            point.x,
            point.y,
            { clickCount: 2 },
            win,
          );
        } else {
          await lazy.event.synthesizeMouseAtPoint(
            point.x,
            point.y,
            { type: "mousemove" },
            win,
          );
        }
        break;
      }
      case "focus":
        element.focus();
        break;
      case "input":
        requireValue(
          element.type !== "file",
          "wrong_control",
          "Use upload for file inputs",
        );
        if (args.replace !== false) {
          lazy.interaction.clearElement(element);
        }
        assertCurrent();
        if (["date", "time"].includes(element.type)) {
          element.value = args.text;
          controlEvent(win, element, "input");
          assertCurrent();
          controlEvent(win, element, "change");
        } else {
          await lazy.interaction.sendKeysToElement(element, args.text, {
            webdriverClick: true,
          });
        }
        break;
      case "key": {
        element.focus();
        const modifiers = Object.fromEntries(
          (args.modifiers || []).map((key) => [`${key}Key`, true]),
        );
        const key = args.key.replace(/^KEY_/, "");
        lazy.event.sendSingleKey(
          { key, printable: [...key].length === 1, ...modifiers },
          win,
        );
        break;
      }
      case "select": {
        requireValue(
          element.localName === "select",
          "wrong_control",
          "select needs a select element",
        );
        requireValue(
          element.multiple || args.values.length === 1,
          "wrong_control",
          "This select accepts one value",
        );
        const options = [...element.options];
        requireValue(
          args.values.every((value) =>
            options.some(
              (option) => option.value === value && !option.disabled,
            ),
          ),
          "missing_option",
          "An option is missing or disabled",
        );
        element.focus();
        for (const option of options) {
          option.selected = args.values.includes(option.value);
        }
        controlEvent(win, element, "input");
        assertCurrent();
        controlEvent(win, element, "change");
        break;
      }
      case "check":
        requireValue(
          ["checkbox", "radio"].includes(element.type),
          "wrong_control",
          "check needs a checkbox or radio input",
        );
        requireValue(
          !(element.type === "radio" && !args.checked),
          "wrong_control",
          "A radio input cannot be unchecked with a click",
        );
        if (!!element.checked !== args.checked) {
          await lazy.interaction.clickElement(element, false, true);
        }
        break;
      case "scroll": {
        const point = clickablePoint(win, element);
        await lazy.event.synthesizeWheelAtPoint(
          point.x,
          point.y,
          { deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0, deltaMode: 0 },
          win,
        );
        break;
      }
      case "submit":
        requireValue(
          element.localName === "form" &&
            typeof element.requestSubmit === "function",
          "wrong_control",
          "submit needs a form element",
        );
        element.requestSubmit();
        break;
      case "upload": {
        requireValue(
          element.localName === "input" && element.type === "file",
          "wrong_control",
          "upload needs an input type=file element",
        );
        requireValue(
          element.multiple || args.paths.length <= 1,
          "wrong_control",
          "This input accepts one file",
        );
        const files = [];
        for (const path of args.paths) {
          try {
            files.push(await File.createFromFileName(path));
          } catch {
            throw new McpToolError(
              "file_not_found",
              "An upload path is missing or unreadable",
            );
          }
        }
        assertCurrent();
        element.mozSetFileArray(files);
        controlEvent(win, element, "input");
        assertCurrent();
        controlEvent(win, element, "change");
        break;
      }
      case "open_menu":
        requireValue(
          chrome && typeof element.openMenu === "function",
          "wrong_control",
          "open_menu needs a native menu control",
        );
        element.openMenu(true);
        break;
      case "close_menu": {
        const popup =
          element.localName === "menupopup"
            ? element
            : element.closest("menupopup");
        requireValue(
          chrome && typeof popup?.hidePopup === "function",
          "wrong_control",
          "close_menu needs a native menu popup",
        );
        popup.hidePopup();
        break;
      }
    }
  } finally {
    userInput.destruct();
  }
  return {
    action: args.action,
    documentId: documentIdentity(win),
    url: win.document.documentURI,
    ...(element.isConnected && element.ownerDocument === win.document
      ? { element: describeElement(element, args.elementId) }
      : { elementRemoved: true }),
    scroll: { x: win.scrollX, y: win.scrollY },
  };
}

/** JSON-safe values with explicit loss markers and bounded traversal. */
export function boundedValue(
  input,
  { maxDepth = 8, maxEntries = 1000, maxChars = 1000000 } = {},
) {
  const seen = new WeakSet();
  let entries = 0,
    chars = 0,
    truncated = false;
  function visit(value, depth) {
    if (++entries > maxEntries || depth > maxDepth || chars >= maxChars) {
      truncated = true;
      return { type: "truncated" };
    }
    if (value === undefined) {
      return { type: "undefined" };
    }
    if (typeof value === "bigint") {
      return { type: "bigint", value: String(value) };
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return { type: "number", value: String(value) };
    }
    if (typeof value === "function" || typeof value === "symbol") {
      return { type: typeof value, value: String(value).slice(0, 500) };
    }
    if (typeof value === "string") {
      const text = value.slice(0, Math.max(0, maxChars - chars));
      chars += text.length;
      truncated ||= text.length < value.length;
      return text;
    }
    if (!value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return { type: "circular" };
    }
    seen.add(value);
    try {
      if (typeof value.nodeType === "number") {
        return {
          type: "node",
          name: value.nodeName,
          text: String(value.textContent || "").slice(0, 500),
        };
      }
    } catch {
      return { type: "unreadable" };
    }
    const result = Array.isArray(value) ? [] : {};
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return { type: "unreadable" };
    }
    for (const key of keys) {
      if (entries >= maxEntries || chars + key.length >= maxChars) {
        truncated = true;
        break;
      }
      chars += key.length;
      try {
        Object.defineProperty(result, key, {
          value: visit(value[key], depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } catch {
        Object.defineProperty(result, key, {
          value: { type: "unreadable" },
          enumerable: true,
        });
      }
    }
    return result;
  }
  return { value: visit(input, 0), truncated };
}
