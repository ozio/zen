// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const INTERACTIVE =
  "a[href],area[href],button,input,select,textarea,summary,[contenteditable='true'],[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[role='combobox']";
const CHECK_ROLES = new Set(["checkbox", "radio", "switch"]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function parentOf(node) {
  return (
    node?.assignedSlot || node?.parentElement || node?.getRootNode?.().host
  );
}

export function disabledControl(element) {
  if (element.disabled || element.matches?.(":disabled")) {
    return true;
  }
  for (let node = element; node; node = parentOf(node)) {
    if (node.inert || node.getAttribute?.("aria-disabled") === "true") {
      return true;
    }
  }
  return false;
}

export function renderedElement(element) {
  const win = element.ownerGlobal || element.documentGlobal;
  const style = win.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return (
    !element.hidden &&
    style.display !== "none" &&
    !["hidden", "collapse"].includes(style.visibility) &&
    rect.width > 0 &&
    rect.height > 0 &&
    (!element.checkVisibility ||
      element.checkVisibility({ checkVisibilityCSS: true }))
  );
}

export function checkState(element) {
  if (
    element.localName === "input" &&
    ["checkbox", "radio"].includes(element.type)
  ) {
    return {
      kind: element.type,
      checked: element.indeterminate ? "mixed" : !!element.checked,
    };
  }
  const kind = element.getAttribute("role");
  if (CHECK_ROLES.has(kind)) {
    const state = element.getAttribute("aria-checked");
    let checked = null;
    if (state === "mixed") {
      checked = "mixed";
    } else if (state === "true" || state === "false") {
      checked = state === "true";
    }
    return { kind, checked };
  }
  return null;
}

/* Only HTML's actual label association delegates activation. ARIA naming and
 * aria-controls do not establish that clicking another node activates a widget. */
export function semanticControl(element, action) {
  let control = element.localName === "label" ? element.control : element;
  requireValue(
    control,
    "missing_control",
    "The label has no associated control"
  );
  if (
    action === "input" &&
    ["combobox", "textbox", "searchbox"].includes(
      control.getAttribute("role")
    ) &&
    !["input", "textarea"].includes(control.localName) &&
    !control.isContentEditable
  ) {
    const editables = [
      ...control.querySelectorAll("input,textarea,[contenteditable='true']"),
    ].filter(item => item.type !== "hidden" && renderedElement(item));
    requireValue(
      editables.length === 1,
      "ambiguous_control",
      "The widget must expose exactly one editable control; inspect its children"
    );
    [control] = editables;
  }
  return control;
}

export function activationTargets(control) {
  return [control, ...(control.labels || [])].filter(
    (item, index, all) => all.indexOf(item) === index
  );
}

function deepHit(win, x, y) {
  let hit = win.document.elementFromPoint(x, y);
  for (let depth = 0; hit?.shadowRoot && depth < 32; depth++) {
    const next = hit.shadowRoot.elementFromPoint(x, y);
    if (!next || next === hit) {
      break;
    }
    hit = next;
  }
  return hit;
}

function acceptsHit(target, control, hit) {
  for (let node = hit; node; node = parentOf(node)) {
    if (node === target) {
      return true;
    }
    // Never turn a semantic action into activation of an embedded link/button.
    if (node !== control && node.matches?.(INTERACTIVE)) {
      return false;
    }
  }
  return false;
}

function clippedRect(win, rect) {
  const left = Math.max(0, rect.left ?? rect.x);
  const top = Math.max(0, rect.top ?? rect.y);
  const right = Math.min(win.innerWidth, rect.right ?? rect.x + rect.width);
  const bottom = Math.min(win.innerHeight, rect.bottom ?? rect.y + rect.height);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/* A bounded search over actual client rectangles. Sampling label descendants
 * finds small painted proxies without guessing class names or DOM positions. */
export function probePointer(win, target, control = target) {
  if (!renderedElement(target)) {
    return { reason: "hidden_element" };
  }
  const rects = [
    ...(target.getClientRects?.() || [target.getBoundingClientRect()]),
  ].slice(0, 16);
  if (target.localName === "label") {
    for (const child of [...(target.querySelectorAll?.("*") || [])].slice(
      0,
      48
    )) {
      if (!child.matches(INTERACTIVE) && renderedElement(child)) {
        rects.push(child.getBoundingClientRect());
      }
    }
  }
  let inViewport = false;
  for (const rect of rects) {
    const clip = clippedRect(win, rect);
    if (!clip) {
      continue;
    }
    inViewport = true;
    for (const [fx, fy] of [
      [0.5, 0.5],
      [0.1, 0.5],
      [0.9, 0.5],
      [0.5, 0.1],
      [0.5, 0.9],
      [0.1, 0.1],
      [0.9, 0.1],
      [0.1, 0.9],
      [0.9, 0.9],
    ]) {
      const x = clip.left + (clip.right - clip.left) * fx;
      const y = clip.top + (clip.bottom - clip.top) * fy;
      if (acceptsHit(target, control, deepHit(win, x, y))) {
        return { point: { x, y }, rect: target.getBoundingClientRect() };
      }
    }
  }
  return { reason: inViewport ? "click_intercepted" : "outside_viewport" };
}

export function describeActionability(element) {
  const win = element.ownerGlobal || element.documentGlobal;
  const self = probePointer(win, element);
  const control = element.localName === "label" ? element.control : element;
  const label =
    control &&
    activationTargets(control).find(
      item => item !== control && probePointer(win, item, control).point
    );
  return {
    inViewport: !!clippedRect(win, element.getBoundingClientRect()),
    receivesPointer: !!self.point,
    activation: self.point ? "self" : (label && "label") || "unavailable",
    ...(self.point ? {} : { reason: self.reason }),
  };
}

const REASONS = {
  hidden_element: "The control has no rendered activation target",
  outside_viewport: "No activation target can be scrolled into the viewport",
  click_intercepted:
    "An overlay or another interactive element intercepts the activation target",
  unstable_element: "The activation target did not reach a stable position",
};

/* Waits and probes only. Once this returns, the caller emits exactly one input
 * sequence. A timeout never triggers a second activation. */
export async function preparePointer(
  win,
  control,
  { timeoutMs, assertCurrent }
) {
  const deadline = Date.now() + timeoutMs;
  let previous;
  let reason = "hidden_element";
  do {
    assertCurrent();
    requireValue(
      !disabledControl(control),
      "disabled_element",
      "The control is disabled or inert"
    );
    let found;
    for (const target of activationTargets(control)) {
      if (!renderedElement(target) || disabledControl(target)) {
        continue;
      }
      target.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
      assertCurrent();
      const probe = probePointer(win, target, control);
      reason = probe.reason || "unstable_element";
      if (probe.point) {
        found = {
          ...probe,
          target,
          via: target === control ? "self" : "label",
        };
        break;
      }
    }
    if (
      found &&
      previous?.target === found.target &&
      ["x", "y", "width", "height"].every(
        key => Math.abs(found.rect[key] - previous.rect[key]) < 0.5
      ) &&
      Math.abs(found.point.x - previous.point.x) < 0.5 &&
      Math.abs(found.point.y - previous.point.y) < 0.5
    ) {
      return found;
    }
    previous = found;
    if (Date.now() >= deadline) {
      break;
    }
    await pause(32);
  } while (Date.now() <= deadline);
  throw new McpToolError(
    reason,
    `${REASONS[reason]}; no activation was dispatched`
  );
}

export async function verifyState(read, matches, { timeoutMs, assertCurrent }) {
  const deadline = Date.now() + timeoutMs;
  let previousMatch = false;
  // Give controlled widgets a turn to apply or reject their input first.
  await pause(32);
  do {
    assertCurrent();
    const matched = matches(read());
    if (matched && previousMatch) {
      return;
    }
    previousMatch = matched;
    if (Date.now() >= deadline) {
      break;
    }
    await pause(32);
  } while (Date.now() <= deadline);
  throw new McpToolError(
    "state_mismatch",
    "Input was dispatched once, but the requested state was not retained; inspect current state before retrying"
  );
}

export function interactionError(error) {
  if (error instanceof McpToolError) {
    return error;
  }
  const known = {
    ElementNotInteractableError: [
      "not_interactable",
      "The control cannot receive this input",
    ],
    ElementClickInterceptedError: [
      "click_intercepted",
      "Another element intercepts the target",
    ],
    InvalidElementStateError: [
      "invalid_control_state",
      "The control is not editable or enabled",
    ],
    StaleElementReferenceError: [
      "stale_element",
      "The control was replaced; inspect it again",
    ],
  }[error?.name];
  return known ? new McpToolError(...known) : error;
}
