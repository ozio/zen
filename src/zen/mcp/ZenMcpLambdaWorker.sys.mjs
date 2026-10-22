// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

/* eslint-disable mozilla/reject-globalThis-modification -- This module runs only in a disposable worker, never in the browser's shared module global. */

import { filterTabs, validSortKey } from "./ZenMcpTabQuery.sys.mjs";

// A disposable worker per request. The parent enforces wall time and terminates
// it even when a lambda or regular expression never returns. No native handles
// enter this realm. Remove ambient capabilities *before* evaluating user code.
const send = globalThis.postMessage.bind(globalThis);
const listen = globalThis.addEventListener.bind(globalThis);
const define = Object.defineProperty;
const ownKeys = Reflect.ownKeys;
const getPrototype = Object.getPrototypeOf;
const allowed = new Set([
  "globalThis",
  "self",
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Math",
  "JSON",
  "Date",
  "RegExp",
  "Intl",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
  "escape",
  "unescape",
  "URL",
  "URLSearchParams",
  "TextEncoder",
  "TextDecoder",
]);

export function lockdown() {
  // Resolve lazy platform constructors before removing capabilities they may
  // consult while first materializing. Thereafter expose only the data value.
  const builtins = new Map();
  for (const name of allowed) {
    if (name in globalThis) {
      builtins.set(name, globalThis[name]);
    }
  }
  for (const [name, value] of builtins) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!descriptor || descriptor.configurable) {
      define(globalThis, name, { value, writable: false, configurable: false });
    }
  }
  // Disable constructor-based compilation as well as global eval/Function.
  for (const fn of [
    function () {},
    async function () {},
    function* () {},
    async function* () {},
  ]) {
    define(getPrototype(fn), "constructor", {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
  const surfaces = [];
  for (
    let object = globalThis;
    object && object !== Object.prototype;
    object = getPrototype(object)
  ) {
    surfaces.push([
      object,
      ownKeys(object).map(key => [
        key,
        Object.getOwnPropertyDescriptor(object, key),
      ]),
    ]);
  }
  for (const [object, descriptors] of surfaces) {
    for (const [key, descriptor] of descriptors) {
      if (typeof key === "string" && allowed.has(key)) {
        continue;
      }
      if (descriptor.configurable) {
        define(object, key, {
          value: undefined,
          writable: false,
          configurable: false,
        });
      } else if (descriptor.writable) {
        define(object, key, { value: undefined, writable: false });
      } else if (descriptor.value !== undefined) {
        throw new Error("Worker capability could not be removed");
      }
    }
  }
}

export function serve(predicate, key) {
  listen(
    "message",
    event => {
      try {
        if (
          (predicate !== null && typeof predicate !== "function") ||
          (key !== null && typeof key !== "function")
        ) {
          throw new Error("Lambda must evaluate to a synchronous function");
        }
        const { items, filter } = event.data;
        const selected = filterTabs(items, filter);
        const ids = [];
        const keys = [];
        const freeze = value => {
          if (value && typeof value === "object") {
            Object.values(value).forEach(freeze);
            Object.freeze(value);
          }
          return value;
        };
        for (const item of selected) {
          freeze(item);
          if (predicate) {
            const matches = predicate(item);
            if (typeof matches !== "boolean") {
              throw new Error("filterLambda must return boolean");
            }
            if (!matches) {
              continue;
            }
          }
          ids.push(item.tabId);
          if (key) {
            const value = key(item);
            if (!validSortKey(value) || JSON.stringify(value).length > 8192) {
              throw new Error(
                "sortKeyLambda must return a bounded scalar or scalar tuple"
              );
            }
            keys.push(value);
          }
        }
        send({ ids, keys: key ? keys : null });
      } catch (error) {
        send({ error: String(error?.message ?? error).slice(0, 512) });
      }
    },
    { once: true }
  );
}
