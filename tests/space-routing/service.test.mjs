// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as policy from "../../src/zen/space-routing/ZenSpaceRoutingPolicy.sys.mjs";

let persisted = {},
  lastFile,
  encryptCalls = 0,
  decryptCalls = 0,
  sends = [];
const keyStore = {
  async encrypt(value) {
    encryptCalls++;
    return `sealed:${Buffer.from(value).toString("base64")}`;
  },
  async decrypt(value) {
    decryptCalls++;
    return Buffer.from(value.slice(7), "base64").toString();
  },
};
globalThis.ChromeUtils = {
  defineESModuleGetters(target) {
    target.OSKeyStore = keyStore;
  },
};
globalThis.PathUtils = {
  profileDir: "/synthetic",
  join: (...parts) => parts.join("/"),
};
globalThis.testJSONFile = class {
  constructor(options) {
    this.options = options;
    lastFile = this;
  }
  async load() {
    this.data = this.options.dataPostProcessor(structuredClone(persisted));
  }
  saveSoon() {
    persisted = structuredClone(this.data);
  }
};
globalThis.routingPolicy = policy;
const asModule = value =>
  `data:text/javascript;base64,${Buffer.from(value).toString("base64")}`;
const source = (
  await readFile(
    new URL(
      "../../src/zen/space-routing/ZenSpaceRoutingAI.sys.mjs",
      import.meta.url
    ),
    "utf8"
  )
)
  .replace(
    "resource://gre/modules/JSONFile.sys.mjs",
    asModule("export const JSONFile = globalThis.testJSONFile;")
  )
  .replace("resource://gre/modules/Timer.sys.mjs", "node:timers")
  .replace(
    "resource:///modules/zen/spacerouting/ZenSpaceRoutingPolicy.sys.mjs",
    asModule(
      "export const { normalizeAISettings, makeRoutingRequest, requestJevRoute, routingURL } = globalThis.routingPolicy;"
    )
  );
const { ZenSpaceRoutingAI: Service } = await import(
  asModule(source + "\nexport { ZenSpaceRoutingAI };")
);
const spaces = [
  { uuid: "common", name: "Common" },
  { uuid: "work", name: "Work" },
];
function response(request) {
  return Response.json({
    model: request.model,
    answers: {
      space: {
        type: "choice",
        choice: "work",
        probabilities: {
          common: 0.02,
          work: 0.96,
          [policy.UNKNOWN_SPACE]: 0.02,
        },
        confidence: 0.94,
      },
    },
  });
}
async function setup() {
  persisted = {};
  encryptCalls = 0;
  decryptCalls = 0;
  sends = [];
  globalThis.fetch = async (url, options) => {
    sends.push({ url, options });
    return response(JSON.parse(options.body));
  };
  const service = new Service();
  await service.ready;
  return service;
}

test("the key is sealed before persistence and omitted from settings readback", async () => {
  const service = await setup();
  await service.saveKey("synthetic-test-key");
  assert.equal(encryptCalls, 1);
  assert.equal(JSON.stringify(persisted).includes("synthetic-test-key"), false);
  assert.equal((await service.getSettings()).hasKey, true);
  assert.equal("encryptedKey" in (await service.getSettings()), false);
  assert.equal("key" in (await service.getSettings()), false);
  await service.saveSettings({ enabled: true, descriptions: { work: "Code" } });
  const restarted = new Service();
  await restarted.ready;
  assert.equal(
    (
      await restarted.classify(
        "https://github.com/Onigo?secret=x#secret",
        spaces
      )
    ).spaceId,
    "work"
  );
  assert.equal(decryptCalls, 1);
  const request = JSON.parse(sends[0].options.body);
  assert.equal(request.state.url, "https://github.com/Onigo");
  assert.equal(request.questions.space.criteria.work.description, "Code");
  assert.equal(
    sends[0].options.headers.Authorization,
    "Bearer synthetic-test-key"
  );
  await restarted.saveKey("");
  assert.equal((await restarted.getSettings()).hasKey, false);
  assert.equal(
    (await restarted.classify("https://github.com", spaces)).reason,
    "missing-key"
  );
});

test("disabled and excluded URLs never read a key or send requests", async () => {
  const service = await setup();
  await service.saveKey("synthetic-test-key");
  assert.equal(
    (await service.classify("https://github.com", spaces)).reason,
    "disabled"
  );
  await service.saveSettings({ enabled: true });
  for (const url of [
    "http://localhost/",
    "http://10.0.0.1/",
    "https://user:password@example.com/",
  ]) {
    assert.equal((await service.classify(url, spaces)).reason, "excluded-url");
  }
  assert.equal(sends.length, 0);
  assert.equal(decryptCalls, 0);
  await assert.rejects(service.saveKey("invalid\nkey"));
});

test("editing settings or replacing the key invalidates pending provider answers", async () => {
  for (const change of [
    service => service.saveSettings({ enabled: false }),
    service => service.saveKey("new-synthetic-key"),
  ]) {
    const service = await setup();
    await service.saveKey("synthetic-test-key");
    await service.saveSettings({ enabled: true });
    let release, started;
    const fetched = new Promise(resolve => {
      started = resolve;
    });
    globalThis.fetch = (_url, options) => {
      started();
      return new Promise(resolve => {
        release = () => resolve(response(JSON.parse(options.body)));
      });
    };
    const pending = service.classify("https://github.com", spaces);
    await fetched;
    await change(service);
    release();
    assert.equal((await pending).reason, "cancelled");
  }
});

test("request concurrency is bounded and slots are released", async () => {
  const service = await setup();
  await service.saveKey("synthetic-test-key");
  await service.saveSettings({ enabled: true });
  const releases = [];
  globalThis.fetch = (_url, options) =>
    new Promise(resolve =>
      releases.push(() => resolve(response(JSON.parse(options.body))))
    );
  const pending = Array.from({ length: 4 }, () =>
    service.classify("https://github.com", spaces)
  );
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  assert.equal(releases.length, 4);
  assert.equal(
    (await service.classify("https://github.com", spaces)).reason,
    "busy"
  );
  releases.forEach(release => release());
  assert.equal(
    (await Promise.all(pending)).every(result => result.spaceId === "work"),
    true
  );
});

test("corrupt persisted settings recover to opt-in defaults", async () => {
  await setup();
  persisted = { settings: null, encryptedKey: 123 };
  const service = new Service();
  const settings = await service.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.hasKey, false);
  assert.equal(lastFile.data.version, 1);
});

test("a queued Remove wins over a slower earlier key encryption", async () => {
  const service = await setup();
  const encrypt = keyStore.encrypt;
  let release, started;
  const encrypting = new Promise(resolve => {
    started = resolve;
  });
  keyStore.encrypt = async value => {
    started();
    await new Promise(resolve => {
      release = resolve;
    });
    return encrypt(value);
  };
  try {
    const saving = service.saveKey("synthetic-slow-key");
    await encrypting;
    const removing = service.saveKey("");
    release();
    await Promise.all([saving, removing]);
    assert.equal((await service.getSettings()).hasKey, false);
    assert.equal(persisted.encryptedKey, "");
  } finally {
    keyStore.encrypt = encrypt;
  }
});
