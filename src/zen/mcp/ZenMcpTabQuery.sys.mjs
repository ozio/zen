// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  McpToolError,
  requireValue,
} from "resource:///modules/zen/mcp/ZenMcpUtils.sys.mjs";

// Pure descriptor operations. Never pass native tabs, windows or callbacks here.
const BOOLEAN_FIELDS = new Set([
  "selected",
  "loaded",
  "pending",
  "discarded",
  "pinned",
  "essential",
  "muted",
  "hidden",
  "playing",
  "audible",
  "pictureInPicture",
  "pinChanged",
]);
const EXACT_FIELDS = new Set(["spaceId", "groupId", "containerId", "windowId"]);
const TEXT_FIELDS = new Set([
  "domain",
  "registrableDomain",
  "url",
  "title",
  "savedUrl",
]);
const LIST_FIELDS = new Set(["tabIds", "spaceIds", "containerIds", "domains"]);
const FILTER_FIELDS = new Set([
  ...BOOLEAN_FIELDS,
  ...EXACT_FIELDS,
  ...TEXT_FIELDS,
  ...LIST_FIELDS,
  "all",
  "any",
  "not",
  "folderId",
  "recursive",
  "duplicates",
]);
const SORT_FIELDS = new Set([
  "domain",
  "registrableDomain",
  "title",
  "url",
  "lastAccessed",
  "createdAt",
  "index",
  "containerId",
  "savedUrl",
  "customTitle",
]);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function invalid(message) {
  throw new McpToolError("invalid_filter", message);
}

function textMatcher(value) {
  if (typeof value === "string") {
    return text =>
      String(text ?? "")
        .toLocaleLowerCase()
        .includes(value.toLocaleLowerCase());
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(
      "Text conditions must be a string or {equals|contains|glob|regex, caseSensitive?}"
    );
  }
  const modes = ["equals", "contains", "glob", "regex"].filter(key =>
    own(value, key)
  );
  if (
    modes.length !== 1 ||
    Object.keys(value).some(key => ![...modes, "caseSensitive"].includes(key))
  ) {
    invalid("Choose exactly one text matcher: equals, contains, glob or regex");
  }
  if (
    value.caseSensitive !== undefined &&
    typeof value.caseSensitive !== "boolean"
  ) {
    invalid("caseSensitive must be boolean");
  }
  const mode = modes[0];
  const pattern = value[mode];
  if (typeof pattern !== "string" || pattern.length > 4096) {
    invalid("Text patterns must be strings of at most 4096 characters");
  }
  const fold = text =>
    value.caseSensitive
      ? String(text ?? "")
      : String(text ?? "").toLocaleLowerCase();
  if (mode === "equals") {
    return text => fold(text) === fold(pattern);
  }
  if (mode === "contains") {
    return text => fold(text).includes(fold(pattern));
  }
  // Regex execution happens in the same terminable worker as arbitrary lambdas.
  // This module is also used by tests; callers must not run untrusted regex on UI.
  let re;
  try {
    re = new RegExp(
      mode === "glob"
        ? `^${pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".")}$`
        : pattern,
      value.caseSensitive ? "" : "i"
    );
  } catch {
    invalid("Invalid regular expression");
  }
  return text => re.test(String(text ?? ""));
}

export function duplicateKey(item, options = {}) {
  let url = item.url;
  try {
    const parsed = new URL(url);
    if (options.ignoreHash) {
      parsed.hash = "";
    }
    for (const name of options.ignoreParams ?? []) {
      parsed.searchParams.delete(name);
    }
    url = parsed.href;
  } catch {
    // Nonstandard internal URLs still have exact-match duplicate semantics.
  }
  return JSON.stringify([
    options.acrossContainers ? null : item.containerId,
    url,
  ]);
}

/**
 * Compile a bounded predicate; duplicate membership uses its input scope.
 *
 * @param {object} filter Declarative conditions.
 * @param {object[]} items The descriptor scope for duplicate detection.
 * @param {number} depth Current nesting depth.
 * @returns {Function} A predicate over a tab descriptor.
 */
export function compileFilter(filter = {}, items = [], depth = 0) {
  if (
    !filter ||
    typeof filter !== "object" ||
    Array.isArray(filter) ||
    depth > 8
  ) {
    invalid("filter must be an object with at most eight nested levels");
  }
  const tests = [];
  for (const [key, value] of Object.entries(filter)) {
    if (!FILTER_FIELDS.has(key)) {
      invalid(`Unknown filter field: ${key}`);
    }
    if (key === "all" || key === "any") {
      if (!Array.isArray(value) || value.length > 64) {
        invalid(`${key} must be an array of at most 64 filters`);
      }
      const children = value.map(child =>
        compileFilter(child, items, depth + 1)
      );
      tests.push(item =>
        children[key === "all" ? "every" : "some"](child => child(item))
      );
    } else if (key === "not") {
      const child = compileFilter(value, items, depth + 1);
      tests.push(item => !child(item));
    } else if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value !== "boolean") {
        invalid(`${key} must be boolean`);
      }
      tests.push(item => !!item[key] === value);
    } else if (EXACT_FIELDS.has(key)) {
      if (
        !(
          typeof value === "string" ||
          value === null ||
          (key === "containerId" && Number.isInteger(value))
        )
      ) {
        invalid(`${key} must be an exact ID`);
      }
      tests.push(item => item[key] === value);
    } else if (TEXT_FIELDS.has(key)) {
      const match = textMatcher(value);
      tests.push(item => match(item[key]));
    } else if (LIST_FIELDS.has(key)) {
      if (
        !Array.isArray(value) ||
        value.length > 10000 ||
        !value.every(
          entry =>
            typeof entry === (key === "containerIds" ? "number" : "string")
        )
      ) {
        invalid(`${key} must be an array of IDs or domains`);
      }
      const values = new Set(value);
      const field = {
        tabIds: "tabId",
        spaceIds: "spaceId",
        containerIds: "containerId",
        domains: "domain",
      }[key];
      tests.push(item => values.has(item[field]));
    } else if (key === "folderId") {
      if (typeof value !== "string") {
        invalid("folderId must be a string");
      }
      tests.push(item =>
        filter.recursive === false
          ? item.groupId === value
          : item.folderPath.some(folder => folder.groupId === value)
      );
    } else if (key === "recursive") {
      if (typeof value !== "boolean" || !own(filter, "folderId")) {
        invalid("recursive requires folderId and a boolean");
      }
    }
  }
  if (own(filter, "duplicates")) {
    const scopedItems = items.filter(item => tests.every(check => check(item)));
    tests.push(duplicateMatcher(filter.duplicates, scopedItems));
  }
  return item => tests.every(check => check(item));
}

function duplicateMatcher(condition, items) {
  const options = condition === true ? {} : condition;
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      key =>
        !["keep", "ignoreHash", "ignoreParams", "acrossContainers"].includes(
          key
        )
    )
  ) {
    invalid(
      "duplicates must be true or {keep,ignoreHash,ignoreParams,acrossContainers}"
    );
  }
  if (
    ![undefined, "all", "first", "last"].includes(options.keep) ||
    ["ignoreHash", "acrossContainers"].some(
      key => own(options, key) && typeof options[key] !== "boolean"
    ) ||
    (own(options, "ignoreParams") &&
      (!Array.isArray(options.ignoreParams) ||
        options.ignoreParams.length > 100 ||
        !options.ignoreParams.every(name => typeof name === "string")))
  ) {
    invalid("Invalid duplicate options");
  }
  const groups = new Map();
  for (const item of items) {
    const key = duplicateKey(item, options);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item.tabId);
  }
  const ids = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    let chosen = group;
    if (options.keep === "first") {
      chosen = group.slice(1);
    } else if (options.keep === "last") {
      chosen = group.slice(0, -1);
    }
    chosen.forEach(id => ids.add(id));
  }
  return item => ids.has(item.tabId);
}

export function filterTabs(items, filter) {
  return items.filter(compileFilter(filter, items));
}

/**
 * Ignore elapsed media position and focus when comparing layout receipts.
 *
 * @param {object[]} items Ordered tab descriptors.
 * @param {object} options Revision controls.
 * @param {boolean} options.selection Include transient selection state.
 * @param {boolean} options.layout Exclude document identity and page title.
 * @returns {string} Serialized relevant descriptor state.
 */
export function revision(items, options = {}) {
  const { selection = false, layout = false } = options;
  return JSON.stringify(
    items.map(item => [
      item.tabId,
      item.windowId,
      ...(layout ? [] : [item.documentId]),
      item.url,
      ...(layout ? [] : [item.title]),
      item.spaceId,
      item.containerId,
      item.groupId,
      item.folderPath,
      item.pinned,
      item.essential,
      item.savedUrl,
      item.customTitle,
      ...(selection
        ? [
            item.selected,
            item.loaded,
            item.pending,
            item.discarded,
            item.playing,
            item.audible,
            item.muted,
            item.pictureInPicture,
          ]
        : []),
    ])
  );
}

export function sortTabs(items, sort = { by: "domain-title" }, keys = null) {
  let fields;
  if (Array.isArray(sort)) {
    fields = sort;
  } else {
    requireValue(
      sort && typeof sort === "object",
      "invalid_sort",
      "sort must be a preset or field list"
    );
    const presets = {
      "domain-title": ["registrableDomain", "domain", "title"],
      title: ["title"],
      "last-used": ["lastAccessed"],
      url: ["url"],
      index: ["index"],
    };
    requireValue(
      presets[sort.by ?? "domain-title"],
      "invalid_sort",
      "Unknown sort preset"
    );
    fields = presets[sort.by ?? "domain-title"].map(field => ({
      field,
      direction: sort.direction ?? (sort.by === "last-used" ? "desc" : "asc"),
    }));
  }
  requireValue(
    fields.length &&
      fields.length <= 8 &&
      fields.every(
        value =>
          value &&
          SORT_FIELDS.has(value.field) &&
          [undefined, "asc", "desc"].includes(value.direction)
      ),
    "invalid_sort",
    "Sort fields or directions are invalid"
  );
  if (keys) {
    requireValue(
      keys.length === items.length && keys.every(validSortKey),
      "invalid_lambda_result",
      "sortKey must return finite scalar values or scalar tuples"
    );
  }
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const compare = (a, b) => {
    if (a === b) {
      return 0;
    }
    if (a === null || a === undefined) {
      return 1;
    }
    if (b === null || b === undefined) {
      return -1;
    }
    if (typeof a === "number" && typeof b === "number") {
      return a - b;
    }
    return collator.compare(String(a), String(b));
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ak = keys
        ? [].concat(keys[a.index])
        : fields.map(value => a.item[value.field]);
      const bk = keys
        ? [].concat(keys[b.index])
        : fields.map(value => b.item[value.field]);
      for (let i = 0; i < Math.max(ak.length, bk.length); i++) {
        const result = compare(ak[i], bk[i]);
        if (result) {
          return result * (!keys && fields[i].direction === "desc" ? -1 : 1);
        }
      }
      return a.index - b.index;
    })
    .map(value => value.item);
}

export function validSortKey(value) {
  const scalar = entry =>
    entry === null ||
    typeof entry === "string" ||
    typeof entry === "boolean" ||
    (typeof entry === "number" && Number.isFinite(entry));
  return (
    scalar(value) ||
    (Array.isArray(value) && value.length <= 8 && value.every(scalar))
  );
}
