/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { JSONFile } from "resource://gre/modules/JSONFile.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  normalizeAISettings,
  makeRoutingRequest,
  requestJevRoute,
  routingURL,
} from "resource:///modules/zen/spacerouting/ZenSpaceRoutingPolicy.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  OSKeyStore: "resource://gre/modules/OSKeyStore.sys.mjs",
});

class ZenSpaceRoutingAI {
  #file;
  #key = null;
  #keyWrites = Promise.resolve();
  #revision = 0;
  #requests = new Set();

  constructor() {
    this.#file = new JSONFile({
      path: PathUtils.join(PathUtils.profileDir, "zen-space-routing-ai.json"),
      dataPostProcessor(data) {
        return {
          version: 1,
          settings: normalizeAISettings(data?.settings),
          encryptedKey:
            typeof data?.encryptedKey === "string" ? data.encryptedKey : "",
        };
      },
    });
    this.ready = this.#file.load();
  }

  async getSettings() {
    await this.ready;
    return {
      ...structuredClone(this.#file.data.settings),
      hasKey: !!this.#file.data.encryptedKey,
    };
  }

  async saveSettings(settings) {
    await this.ready;
    this.#file.data.settings = normalizeAISettings(settings);
    this.#changed();
  }

  async saveKey(key) {
    const value = key.trim();
    if (value.length > 4096 || /[\r\n]/.test(value)) {
      throw new Error("Invalid API key");
    }
    // Preserve UI action order even when the operating system takes time to
    // encrypt a key. A later Remove must not be overwritten by an earlier Save.
    const operation = this.#keyWrites.then(async () => {
      await this.ready;
      const encrypted = value ? await lazy.OSKeyStore.encrypt(value) : "";
      this.#file.data.encryptedKey = encrypted;
      this.#key = value;
      this.#changed();
    });
    this.#keyWrites = operation.catch(() => {});
    return operation;
  }

  #changed() {
    this.#revision++;
    for (const controller of this.#requests) {
      controller.abort();
    }
    this.#file.saveSoon();
  }

  async classify(rawURL, spaces, { signal, preview = false } = {}) {
    await this.ready;
    const settings = normalizeAISettings(this.#file.data.settings);
    const skip = reason => ({ reason, spaceId: null });
    if (!settings.enabled && !preview) {
      return skip("disabled");
    }
    const url = routingURL(rawURL);
    if (!url) {
      return skip("excluded-url");
    }
    if (!this.#file.data.encryptedKey) {
      return skip("missing-key");
    }
    if (this.#requests.size >= 4) {
      return skip("busy");
    }
    const request = makeRoutingRequest(url, spaces, settings);
    if (!request) {
      return skip("invalid-spaces");
    }
    const revision = this.#revision;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    this.#requests.add(controller);
    const started = Date.now();
    try {
      const result = await requestJevRoute({
        request,
        settings,
        signal: controller.signal,
        getKey: async () => {
          if (this.#key === null) {
            const encrypted = this.#file.data.encryptedKey;
            const key = await lazy.OSKeyStore.decrypt(
              encrypted,
              "zen_space_routing"
            );
            if (revision !== this.#revision) {
              return "";
            }
            this.#key = key;
          }
          return this.#key;
        },
        fetchImpl: fetch,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });
      if (revision !== this.#revision || controller.signal.aborted) {
        return skip("cancelled");
      }
      return { ...result, elapsedMs: Date.now() - started };
    } finally {
      this.#requests.delete(controller);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export const gZenSpaceRoutingAI = new ZenSpaceRoutingAI();
