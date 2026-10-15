// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  paginate,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import {
  activationTargets,
  checkState,
  describeActionability,
  disabledControl,
  interactionError,
  preparePointer,
  renderedElement,
  semanticControl,
  verifyState,
} from "resource:///actors/ZenMcpActionability.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  event: "chrome://remote/content/shared/webdriver/Event.sys.mjs",
  interaction: "chrome://remote/content/marionette/interaction.sys.mjs",
});

const PAGE_SELECTOR =
  "body,a[href],button,input,label,textarea,select,option,[role],[aria-label],[contenteditable],h1,h2,h3,h4,h5,h6,main,nav,header,footer,section,article,form,dialog,summary,details,iframe,[tabindex]";
const CHROME_SELECTOR =
  "button,toolbarbutton,menu,menuitem,menulist,menupopup,input,textarea,select,checkbox,radio,tab,[role],[aria-label],[data-l10n-id],[command],a[href]";
const MAX_SCANNED = 20000;

export function documentIdentity(win) {
  return String(
    win.windowGlobalChild?.innerWindowId ?? win.windowUtils.currentInnerWindowID
  );
}

export function elementFingerprint(element) {
  return JSON.stringify([
    element.localName,
    element.id,
    element.getAttribute("role"),
    element.getAttribute("type"),
    element.getAttribute("for"),
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
    const style = (
      element.ownerGlobal ?? element.documentGlobal
    ).getComputedStyle(node);
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
  return renderedElement(element);
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
      id =>
        root.getElementById?.(id)?.textContent ||
        doc.getElementById(id)?.textContent ||
        ""
    )
    .join(" ")
    .trim();
  return (
    element.getAttribute("aria-label") ||
    labelledText ||
    element.getAttribute("label") ||
    [...(element.labels || [])]
      .map(label => label.textContent)
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
    disabled: disabledControl(element),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    actionability: describeActionability(element),
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
  const state = checkState(element);
  if (state) {
    result.checkable = state.kind;
    result.checked = state.checked;
  } else if ("checked" in element) {
    result.checked = !!element.checked;
  }
  if (element.localName === "label" && element.control) {
    result.controlId = element.control.id || null;
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

/**
 * Bounded traversal, including open shadow roots; never enters an iframe.
 *
 * @param {Document} doc The explicit document to inspect.
 * @param {string} selector A CSS selector for observed elements.
 * @param {boolean} [includeHidden=false] Include hidden controls.
 */
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
        if (
          node.matches(selector) &&
          (includeHidden ||
            visibleElement(node) ||
            activationTargets(node).some(
              target => target !== node && visibleElement(target)
            ))
        ) {
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
  chrome = false
) {
  const { elements, scanned, scanTruncated } = scanElements(
    win.document,
    args.selector || (chrome ? CHROME_SELECTOR : PAGE_SELECTOR),
    args.includeHidden === true
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
    "snapshotId and elementId from a fresh snapshot are required"
  );
  requireValue(
    typeof args.documentId === "string",
    "missing_document",
    "documentId from the snapshot is required"
  );
  const documentId = documentIdentity(win);
  requireValue(
    args.documentId === documentId,
    "stale_document",
    "The document changed; inspect it again"
  );
  const references = store.take(
    args.snapshotId,
    clientId,
    targetId,
    documentId
  );
  const stored = references.get(args.elementId);
  const element = stored?.reference.deref();
  requireValue(
    element?.isConnected && element.ownerDocument === win.document,
    "stale_element",
    "The element was removed; inspect it again"
  );
  requireValue(
    stored.fingerprint === elementFingerprint(element),
    "changed_element",
    "The element changed; inspect it again"
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
    "Unknown element action"
  );
  if (args.timeoutMs !== undefined) {
    requireValue(
      Number.isInteger(args.timeoutMs) &&
        args.timeoutMs >= 64 &&
        args.timeoutMs <= 10000,
      "invalid_timeout",
      "timeoutMs must be an integer from 64 to 10000"
    );
  }
  if (args.action === "input") {
    requireValue(
      typeof args.text === "string" && args.text.length <= 1000000,
      "invalid_text",
      "text must be a string of at most 1000000 characters"
    );
  }
  if (args.action === "key") {
    requireValue(
      typeof args.key === "string" &&
        !!args.key.length &&
        args.key.length <= 128,
      "invalid_key",
      "key must be a character or a DOM key name"
    );
    requireValue(
      args.modifiers === undefined ||
        (Array.isArray(args.modifiers) &&
          args.modifiers.every(key =>
            ["shift", "ctrl", "alt", "meta"].includes(key)
          )),
      "invalid_modifiers",
      "modifiers may contain shift, ctrl, alt and meta"
    );
  }
  if (args.action === "select") {
    requireValue(
      Array.isArray(args.values) &&
        !!args.values.length &&
        args.values.length <= 500 &&
        args.values.every(value => typeof value === "string"),
      "invalid_values",
      "values must be a nonempty list of option values"
    );
  }
  if (args.action === "check") {
    requireValue(
      typeof args.checked === "boolean",
      "invalid_checked",
      "checked must be a boolean"
    );
  }
  if (args.action === "scroll") {
    requireValue(
      [args.deltaX ?? 0, args.deltaY ?? 0].every(
        value => Number.isFinite(value) && Math.abs(value) <= 100000
      ),
      "invalid_scroll",
      "scroll deltas must be finite and no larger than 100000 CSS pixels"
    );
  }
  if (args.action === "upload") {
    requireValue(
      Array.isArray(args.paths) &&
        args.paths.length <= 100 &&
        args.paths.every(
          path =>
            typeof path === "string" &&
            /^(\/|[A-Za-z]:[\\/])/.test(path) &&
            !path.includes("\0")
        ),
      "invalid_paths",
      "paths must be absolute file paths (at most 100 files)"
    );
  }
}

function controlEvent(win, element, type) {
  // Ordinary dispatchEvent produces an untrusted event. Privileged PresShell
  // dispatch gives form/file controls the native trusted input/change signal.
  win.windowUtils.dispatchDOMEventViaPresShellForTesting(
    element,
    new win.Event(type, { bubbles: true, composed: type === "input" })
  );
}

async function performPointerAction(
  win,
  element,
  args,
  chrome,
  assertCurrent,
  point
) {
  switch (args.action) {
    case "click":
      if (
        chrome &&
        nativeMenuVisible(element) &&
        typeof element.doCommand === "function"
      ) {
        element.doCommand();
      } else {
        await lazy.event.synthesizeMouseAtPoint(point.x, point.y, {}, win);
      }
      break;
    case "double_click":
    case "context_click":
    case "hover": {
      if (args.action === "context_click") {
        for (const type of ["mousedown", "contextmenu", "mouseup"]) {
          assertCurrent();
          await lazy.event.synthesizeMouseAtPoint(
            point.x,
            point.y,
            { type, button: 2 },
            win
          );
        }
      } else if (args.action === "double_click") {
        await lazy.event.synthesizeMouseAtPoint(
          point.x,
          point.y,
          { clickCount: 1 },
          win
        );
        assertCurrent();
        await lazy.event.synthesizeMouseAtPoint(
          point.x,
          point.y,
          { clickCount: 2 },
          win
        );
      } else {
        await lazy.event.synthesizeMouseAtPoint(
          point.x,
          point.y,
          { type: "mousemove" },
          win
        );
      }
      break;
    }
  }
}

async function uploadFiles(win, element, args, assertCurrent) {
  requireValue(
    element.localName === "input" && element.type === "file",
    "wrong_control",
    "upload needs an input type=file element"
  );
  requireValue(
    element.multiple || args.paths.length <= 1,
    "wrong_control",
    "This input accepts one file"
  );
  const files = [];
  for (const path of args.paths) {
    try {
      files.push(await File.createFromFileName(path));
    } catch {
      throw new McpToolError(
        "file_not_found",
        "An upload path is missing or unreadable"
      );
    }
  }
  assertCurrent();
  element.mozSetFileArray(files);
  controlEvent(win, element, "input");
  assertCurrent();
  controlEvent(win, element, "change");
}

async function fillControl(win, control, args, options) {
  const { assertCurrent } = options;
  requireValue(
    ["input", "textarea"].includes(control.localName) ||
      control.isContentEditable,
    "wrong_control",
    "input needs an editable input, textarea or contenteditable control"
  );
  requireValue(
    control.type !== "file",
    "wrong_control",
    "Use upload for file inputs"
  );
  requireValue(
    !control.readOnly && control.getAttribute("aria-readonly") !== "true",
    "readonly_control",
    "The control is read-only"
  );
  const read = () =>
    control.isContentEditable ? control.textContent : control.value;
  const expected = args.replace !== false ? args.text : read() + args.text;
  if (args.replace !== false) {
    lazy.interaction.clearElement(control);
  }
  assertCurrent();
  if (["date", "time"].includes(control.type)) {
    control.value = args.text;
    controlEvent(win, control, "input");
    assertCurrent();
    controlEvent(win, control, "change");
  } else {
    await lazy.interaction.sendKeysToElement(control, args.text, {
      webdriverClick: true,
    });
  }
  await verifyState(read, value => value === expected, options);
}

async function sendControlKey(win, control, args) {
  control.focus();
  requireValue(
    (control.getRootNode?.() || win.document).activeElement === control,
    "not_focusable",
    "The requested control did not receive keyboard focus"
  );
  const modifiers = Object.fromEntries(
    (args.modifiers || []).map(key => [`${key}Key`, true])
  );
  const key = args.key.replace(/^KEY_/, "");
  lazy.event.sendSingleKey(
    { key, printable: [...key].length === 1, ...modifiers },
    win
  );
}

async function selectControl(win, control, args, options) {
  const { assertCurrent } = options;
  requireValue(
    control.localName === "select",
    "wrong_control",
    "select needs a select element"
  );
  requireValue(
    control.multiple || args.values.length === 1,
    "wrong_control",
    "This select accepts one value"
  );
  const choices = [...control.options];
  requireValue(
    args.values.every(value =>
      choices.some(option => option.value === value && !option.disabled)
    ),
    "missing_option",
    "An option is missing or disabled"
  );
  control.focus();
  for (const option of choices) {
    option.selected = args.values.includes(option.value);
  }
  controlEvent(win, control, "input");
  assertCurrent();
  controlEvent(win, control, "change");
  await verifyState(
    () =>
      [...control.options]
        .filter(option => option.selected)
        .map(option => option.value),
    values =>
      values.every(value => args.values.includes(value)) &&
      args.values.every(value => values.includes(value)),
    options
  );
}

async function prepareActivation(
  win,
  control,
  args,
  chrome,
  options,
  noChange
) {
  let activation;
  const pointerActions = [
    "click",
    "double_click",
    "context_click",
    "hover",
    "scroll",
  ];
  const nativeMenu = chrome && nativeMenuVisible(control);
  if (
    !noChange &&
    !nativeMenu &&
    (pointerActions.includes(args.action) ||
      ["check", "input", "select"].includes(args.action))
  ) {
    try {
      activation = await preparePointer(win, control, options);
    } catch (error) {
      // Keyboard activation is useful for focusable offscreen controls, but it
      // must not bypass a covering modal/overlay or a display:none control.
      if (
        args.action !== "check" ||
        error.code !== "outside_viewport" ||
        !renderedElement(control) ||
        !(control.tabIndex >= 0)
      ) {
        throw error;
      }
      control.focus();
      requireValue(
        (control.getRootNode?.() || win.document).activeElement === control,
        "not_focusable",
        "The control did not receive keyboard focus"
      );
      activation = { via: "keyboard" };
    }
  }
  if (
    !nativeMenu &&
    !activation &&
    !["check", "upload", "close_menu"].includes(args.action)
  ) {
    requireValue(
      visibleElement(control),
      "hidden_element",
      "The control is hidden"
    );
  }
  return activation;
}

async function prepareAction(win, element, args, chrome, signal) {
  validateAction(args);
  const control = ["close_menu", "open_menu", "submit", "scroll"].includes(
    args.action
  )
    ? element
    : semanticControl(element, args.action);
  const expectedDocumentId = documentIdentity(win);
  const expectedDocument = element.ownerDocument;
  const fingerprint = elementFingerprint(control);
  let dispatched = false;
  const assertCurrent = () => {
    requireValue(
      !signal?.aborted,
      "cancelled",
      "The action was cancelled; inspect current state before retrying"
    );
    requireValue(
      win.document === expectedDocument &&
        documentIdentity(win) === expectedDocumentId,
      "stale_document",
      "The document changed during the action; inspect the tab before retrying"
    );
    requireValue(
      control.isConnected &&
        control.ownerDocument === expectedDocument &&
        element.isConnected,
      "stale_element",
      "The control was replaced; inspect current state before retrying"
    );
    requireValue(
      dispatched ||
        (fingerprint === elementFingerprint(control) &&
          (element.localName !== "label" || element.control === control)),
      "changed_element",
      "The control changed during preparation; inspect it again"
    );
  };
  assertCurrent();
  const options = { timeoutMs: args.timeoutMs ?? 1500, assertCurrent };
  requireValue(
    !disabledControl(control),
    "disabled_element",
    "The control is disabled or inert"
  );
  const state = checkState(control);
  if (args.action === "check") {
    requireValue(
      state && state.checked !== null,
      "wrong_control",
      "check needs a native checkbox/radio or an ARIA checkbox/radio/switch with aria-checked"
    );
    requireValue(
      !(state.kind === "radio" && !args.checked),
      "wrong_control",
      "A radio control cannot be unchecked by activation"
    );
  }
  let activation;
  const noChange = args.action === "check" && state.checked === args.checked;
  activation = await prepareActivation(
    win,
    control,
    args,
    chrome,
    options,
    noChange
  );
  assertCurrent();
  return {
    control,
    options,
    state,
    noChange,
    activation,
    assertCurrent,
    markDispatched(value) {
      dispatched = value;
    },
  };
}

function actionResult(win, element, args, activation, verification) {
  return {
    action: args.action,
    verification,
    ...(activation ? { activation: { via: activation.via } } : {}),
    documentId: documentIdentity(win),
    url: win.document.documentURI,
    ...(element.isConnected && element.ownerDocument === win.document
      ? { element: describeElement(element, args.elementId) }
      : { elementRemoved: true }),
    scroll: { x: win.scrollX, y: win.scrollY },
  };
}

/**
 * Uses Gecko's trusted WebDriver event helpers without starting a remote agent.
 *
 * @param {Window} win The owning document's window.
 * @param {Element} element A validated, fresh element.
 * @param {object} args The validated action arguments.
 * @param {boolean} [chrome=false] Whether native chrome controls are allowed.
 * @param {AbortSignal} [signal] Cancels waiting before any late input can fire.
 */
export async function performAction(
  win,
  element,
  args,
  chrome = false,
  signal
) {
  const context = await prepareAction(win, element, args, chrome, signal);
  const { control, options, state, noChange, activation, assertCurrent } =
    context;
  let verification = "not_applicable";
  const userInput = win.windowUtils.setHandlingUserInput(true);
  try {
    context.markDispatched(!noChange);
    switch (args.action) {
      case "click":
      case "double_click":
      case "context_click":
      case "hover":
        await performPointerAction(
          win,
          control,
          args,
          chrome,
          assertCurrent,
          activation?.point
        );
        if (args.action === "click" && state && state.checked !== null) {
          const expected =
            state.kind === "radio" ? true : state.checked !== true;
          await verifyState(
            () => checkState(control)?.checked,
            value => value === expected,
            options
          );
          verification = "verified";
        }
        break;
      case "focus":
        control.focus();
        await verifyState(
          () => (control.getRootNode?.() || win.document).activeElement,
          value => value === control,
          options
        );
        verification = "verified";
        break;
      case "input":
        await fillControl(win, control, args, options);
        verification = "verified";
        break;
      case "key":
        await sendControlKey(win, control, args, options);
        break;
      case "select":
        await selectControl(win, control, args, options);
        verification = "verified";
        break;
      case "check":
        if (!noChange) {
          assertCurrent();
          if (activation.via === "keyboard") {
            lazy.event.sendSingleKey({ key: " ", printable: true }, win);
          } else {
            await lazy.event.synthesizeMouseAtPoint(
              activation.point.x,
              activation.point.y,
              {},
              win
            );
          }
          await verifyState(
            () => checkState(control)?.checked,
            value => value === args.checked,
            options
          );
        }
        verification = noChange ? "already_satisfied" : "verified";
        break;
      case "scroll": {
        const { point } = activation;
        await lazy.event.synthesizeWheelAtPoint(
          point.x,
          point.y,
          { deltaX: args.deltaX ?? 0, deltaY: args.deltaY ?? 0, deltaMode: 0 },
          win
        );
        break;
      }
      case "submit":
        requireValue(
          element.localName === "form" &&
            typeof element.requestSubmit === "function",
          "wrong_control",
          "submit needs a form element"
        );
        element.requestSubmit();
        break;
      case "upload":
        await uploadFiles(win, control, args, assertCurrent);
        break;
      case "open_menu":
        requireValue(
          chrome && typeof element.openMenu === "function",
          "wrong_control",
          "open_menu needs a native menu control"
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
          "close_menu needs a native menu popup"
        );
        popup.hidePopup();
        break;
      }
    }
  } catch (error) {
    throw interactionError(error);
  } finally {
    userInput.destruct();
  }
  return actionResult(win, element, args, activation, verification);
}

/**
 * JSON-safe values with explicit loss markers and bounded traversal.
 *
 * @param {*} input The value to serialize.
 * @param {object} [options] Traversal bounds.
 * @param {number} [options.maxDepth=8] Maximum nested depth.
 * @param {number} [options.maxEntries=1000] Maximum total entries.
 * @param {number} [options.maxChars=1000000] Maximum text length.
 */
export function boundedValue(
  input,
  { maxDepth = 8, maxEntries = 1000, maxChars = 1000000 } = {}
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
