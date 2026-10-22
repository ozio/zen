// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout, clearTimeout } from "node:timers";
import {
  DEFAULT_AI_SETTINGS,
  UNKNOWN_SPACE,
  JEV_ENDPOINT,
  normalizeAISettings,
  routingURL,
  fallbackSpace,
  matchURLMask,
  makeRoutingRequest,
  readRoutingAnswer,
  requestJevRoute,
} from "../../src/zen/space-routing/ZenSpaceRoutingPolicy.sys.mjs";

const spaces = [
  { uuid: "common", name: "Common", containerTabId: 0 },
  { uuid: "work", name: "Work", containerTabId: 4 },
];
const settings = normalizeAISettings({
  ...DEFAULT_AI_SETTINGS,
  descriptions: { work: "Work projects" },
});
const request = makeRoutingRequest(
  "https://github.com/org/project",
  spaces,
  settings
);
function answer(
  probabilities = { common: 0.02, work: 0.95, [UNKNOWN_SPACE]: 0.03 },
  choice = "work"
) {
  return {
    model: settings.model,
    answers: {
      space: { type: "choice", choice, probabilities, confidence: 0.9 },
    },
  };
}

test("AI is off by default; persisted settings are bounded and normalized", () => {
  assert.equal(normalizeAISettings(null).enabled, false);
  const value = normalizeAISettings({
    enabled: "true",
    timeoutMs: 99999,
    minProbability: NaN,
    minMargin: -5,
    prompt: "",
    model: "https://attacker.example",
    descriptions: { x: "x".repeat(1200), y: 9 },
  });
  assert.equal(value.enabled, false);
  assert.equal(value.timeoutMs, 5000);
  assert.equal(value.minProbability, DEFAULT_AI_SETTINGS.minProbability);
  assert.equal(value.minMargin, 0);
  assert.equal(value.model, DEFAULT_AI_SETTINGS.model);
  assert.equal(value.descriptions.x.length, 1000);
  assert.equal(value.descriptions.y, undefined);
});

test("the provider only receives host/path; the original URL remains intact", () => {
  const original =
    "https://GitHub.com/Onigo/project?token=SECRET&q=private#password";
  assert.equal(routingURL(original), "https://github.com/Onigo/project");
  assert.ok(original.includes("SECRET"));
  for (const url of [
    "https://user:pass@github.com/a",
    "file:///tmp/private",
    "about:config",
    "data:text/plain,private",
    "https://localhost/a",
    "http://127.0.0.1/",
    "http://0x7f000001/",
    "https://[::1]/",
    "https://192.168.1.1/",
    "https://intranet/",
    "http://device.local/",
    "http://device.home.arpa/",
    "http://a.onion/",
    "https://example.test/",
    "nonsense",
  ]) {
    assert.equal(routingURL(url), null, url);
  }
});

test("URL masks match complete hosts and preserve path case", () => {
  assert.equal(
    matchURLMask("https://github.com/Onigo/repo?x=1", "github.com/Onigo/*"),
    true
  );
  assert.equal(
    matchURLMask(
      "https://github.com.attacker.com/Onigo/repo",
      "github.com/Onigo/*"
    ),
    false
  );
  assert.equal(
    matchURLMask("https://github.com/onigo/repo", "github.com/Onigo/*"),
    false
  );
  assert.equal(
    matchURLMask("https://docs.unity3d.com/6000/a", "*.unity3d.com/*"),
    true
  );
  assert.equal(matchURLMask("https://github.com/a", "github.com"), true);
  assert.equal(matchURLMask("file://github.com/a", "github.com/*"), false);
  assert.equal(
    matchURLMask(
      "https://example.com/" + "a".repeat(5000),
      "example.com/*a*a*a*z"
    ),
    false
  );
});

test("fallback follows current order or a stable explicit ID", () => {
  assert.equal(fallbackSpace(spaces, "first-space", "work"), "common");
  assert.equal(
    fallbackSpace([...spaces].reverse(), "first-space", "common"),
    "work"
  );
  assert.equal(fallbackSpace(spaces, "work", "common"), "work");
  assert.equal(fallbackSpace(spaces, "removed", "work"), "common");
  assert.equal(fallbackSpace(spaces, "most-recent-space", "work"), "work");
  assert.equal(fallbackSpace([], "removed"), null);
});

test("request contains current names/descriptions under IDs plus an unknown option", () => {
  assert.deepEqual(Object.keys(request.questions.space.criteria), [
    "common",
    "work",
    UNKNOWN_SPACE,
  ]);
  assert.equal(
    request.questions.space.criteria.work.description,
    "Work projects"
  );
  assert.equal(request.questions.space.criteria.work.name, "Work");
  assert.deepEqual(request.state, { url: "https://github.com/org/project" });
  assert.equal(JSON.stringify(request).includes("containerTabId"), false);
  assert.equal(makeRoutingRequest("https://example.com", [], settings), null);
  assert.equal(
    makeRoutingRequest(
      "https://example.com",
      Array(255).fill(spaces[0]),
      settings
    ),
    null
  );
});

test("clear winners pass; close candidates and unknown use fallback", () => {
  assert.equal(readRoutingAnswer(answer(), request, settings).spaceId, "work");
  assert.equal(
    readRoutingAnswer(
      answer({ common: 0.45, work: 0.48, [UNKNOWN_SPACE]: 0.07 }),
      request,
      settings
    ).reason,
    "uncertain"
  );
  assert.equal(
    readRoutingAnswer(
      answer({ common: 0.28, work: 0.71, [UNKNOWN_SPACE]: 0.01 }),
      request,
      settings
    ).reason,
    "uncertain"
  );
  assert.equal(
    readRoutingAnswer(
      answer({ common: 0, work: 0, [UNKNOWN_SPACE]: 1 }, UNKNOWN_SPACE),
      request,
      settings
    ).spaceId,
    null
  );
});

test("invalid, incomplete, fabricated, unnormalized or mismatched answers are rejected", () => {
  const bad = [
    null,
    {},
    answer({ common: 0, work: 1 }),
    answer({ common: 0, work: NaN, [UNKNOWN_SPACE]: 0 }),
    answer({ common: 0, work: "1", [UNKNOWN_SPACE]: 0 }),
    answer({ common: 0.5, work: 0.9, [UNKNOWN_SPACE]: 0 }),
    answer(undefined, "nonexistent"),
    answer(undefined, "common"),
    { ...answer(), model: "another-model" },
  ];
  for (const value of bad) {
    assert.equal(
      readRoutingAnswer(value, request, settings).reason,
      "invalid-response"
    );
  }
});

const run = (overrides = {}) =>
  requestJevRoute({
    request,
    settings,
    getKey: async () => "synthetic-key",
    fetchImpl: async () => Response.json(answer()),
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    ...overrides,
  });

test("request uses only the fixed provider endpoint, omits cookies and forbids redirects", async () => {
  let calls = 0;
  const result = await run({
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, JEV_ENDPOINT);
      assert.equal(init.headers.Authorization, "Bearer synthetic-key");
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.deepEqual(
        JSON.parse(init.body),
        JSON.parse(JSON.stringify(request))
      );
      return Response.json(answer());
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.spaceId, "work");
});

test("missing key never makes a request; HTTP failures are not retried", async () => {
  assert.equal(
    (
      await run({
        getKey: async () => "",
        fetchImpl: () => assert.fail("network"),
      })
    ).reason,
    "missing-key"
  );
  for (const status of [401, 403, 429, 529]) {
    let calls = 0;
    const result = await run({
      fetchImpl: async () => {
        calls++;
        return new Response("", { status });
      },
    });
    assert.equal(result.reason, status < 429 ? "invalid-key" : "service-error");
    assert.equal(calls, 1);
  }
});

test("deadline covers key access, response headers and body even when abort is ignored", async () => {
  const short = { ...settings, timeoutMs: 15 };
  for (const overrides of [
    { getKey: () => new Promise(() => {}) },
    { fetchImpl: () => new Promise(() => {}) },
    { fetchImpl: async () => new Response(new ReadableStream({ start() {} })) },
  ]) {
    const start = Date.now();
    const result = await run({ ...overrides, settings: short });
    assert.equal(result.reason, "timeout");
    assert.ok(Date.now() - start < 300);
  }
});

test("late answers are ignored and an already cancelled request never starts fetch", async () => {
  let resolve;
  const result = await run({
    settings: { ...settings, timeoutMs: 10 },
    fetchImpl: () =>
      new Promise(r => {
        resolve = r;
      }),
  });
  assert.equal(result.reason, "timeout");
  resolve(Response.json(answer()));
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (
      await run({
        signal: controller.signal,
        fetchImpl: () => assert.fail("cancelled network"),
      })
    ).reason,
    "cancelled"
  );
});

test("malformed JSON and oversized responses fall back", async () => {
  assert.equal(
    (await run({ fetchImpl: async () => new Response("not json") })).spaceId,
    null
  );
  assert.equal(
    (await run({ fetchImpl: async () => new Response("x".repeat(70000)) }))
      .reason,
    "invalid-response"
  );
});
