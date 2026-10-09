import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ZenMcpAgentSetup } from "../../src/zen/mcp/ZenMcpAgentSetup.sys.mjs";
import {
  agentConnection,
  agentSkill,
} from "../../src/zen/mcp/ZenMcpAgentConfig.sys.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const template = await readFile(
  new URL("../../src/zen/mcp/skills/zen-browser/SKILL.md", import.meta.url),
  "utf8",
);

function harness(kind = "main") {
  const files = new Map();
  const clients = new Map();
  const operations = [];
  const validations = [];
  const paths = {
    codex: "/codex/config.toml",
    claude: "/home/.claude.json",
    registry: "/profile/agents.json",
    skill: (agent, name) => `/${agent}/skills/${name}/SKILL.md`,
  };
  let id = 0;
  const service = {
    getStatus: () => ({
      kind,
      endpoint: `http://127.0.0.1:${kind === "main" ? 3923 : 3924}/mcp`,
      clients: [...clients.values()],
      enabled: false,
    }),
    hasClient: (key) => clients.has(key),
    async addClient(name) {
      const client = { id: `client-${++id}`, name };
      clients.set(client.id, client);
      operations.push(["create", client.id]);
      return {
        client,
        token: id.toString(16).padStart(64, "0"),
        endpoint: service.getStatus().endpoint,
      };
    },
    async revokeClient(key) {
      clients.delete(key);
      operations.push(["revoke", key]);
    },
  };
  const io = {
    read: async (path) => files.get(path) ?? null,
    async replace(path, before, text) {
      assert.equal(
        files.get(path) ?? null,
        before,
        "compare contents before replacing",
      );
      files.set(path, text);
    },
    async restore(path, expected, before) {
      assert.equal(files.get(path), expected);
      if (before == null) files.delete(path);
      else files.set(path, before);
    },
  };
  const setup = new ZenMcpAgentSetup({
    io,
    paths,
    hash,
    id: () => `owner-${++id}`,
    service,
    readSkill: async () => template,
    validateCodex: async (text, server, entry) =>
      validations.push({ text, server, entry }),
  });
  return { files, clients, operations, validations, paths, io, setup, service };
}

test("Codex setup preserves other settings, records only ownership hashes and replaces its own grant", async () => {
  const h = harness();
  const original =
    'model = "synthetic-model"\n[mcp_servers.other]\nurl = "http://127.0.0.1:1234/mcp"\n';
  h.files.set(h.paths.codex, original);
  const first = await h.setup.connect("codex");
  assert.ok(h.files.get(h.paths.codex).startsWith(original));
  assert.match(
    h.files.get(h.paths.codex),
    /\[mcp_servers\.zen\.http_headers\]/,
  );
  assert.ok(h.files.get(h.paths.codex).includes(first.token));
  assert.ok(!h.files.get(h.paths.registry).includes(first.token));
  assert.equal(h.service.getStatus().enabled, false);
  const second = await h.setup.connect("codex");
  assert.notEqual(first.client.id, second.client.id);
  assert.ok(h.files.get(h.paths.codex).startsWith(original));
  assert.equal(h.files.get(h.paths.codex).match(/BEGIN Zen MCP/g).length, 1);
  assert.equal(h.clients.size, 1);
  assert.ok(h.clients.has(second.client.id));
  assert.equal(h.validations.length, 4);
});

test("Claude setup preserves profile fields, unrelated servers, and independent client access", async () => {
  const h = harness();
  const unrelated = {
    theme: "dark",
    projects: { synthetic: { value: 17 } },
    mcpServers: { other: { type: "http", url: "http://localhost:1234/mcp" } },
  };
  h.files.set(h.paths.claude, JSON.stringify(unrelated));
  const claude = await h.setup.connect("claude");
  const codex = await h.setup.connect("codex");
  const data = JSON.parse(h.files.get(h.paths.claude));
  assert.deepEqual(data.projects, unrelated.projects);
  assert.deepEqual(data.mcpServers.other, unrelated.mcpServers.other);
  assert.equal(
    data.mcpServers.zen.headers.Authorization,
    `Bearer ${claude.token}`,
  );
  assert.notEqual(claude.token, codex.token);
  assert.equal(h.clients.size, 2);
  assert.equal(h.service.getStatus().enabled, false);
});

test("foreign Claude connections and edited managed configurations fail before granting access", async () => {
  const h = harness();
  const foreign = JSON.stringify({
    mcpServers: { zen: { type: "http", url: "http://localhost:4321/mcp" } },
  });
  h.files.set(h.paths.claude, foreign);
  await assert.rejects(h.setup.connect("claude"));
  assert.equal(h.clients.size, 0);
  assert.equal(h.files.get(h.paths.claude), foreign);
  h.files.delete(h.paths.claude);
  await h.setup.connect("claude");
  const data = JSON.parse(h.files.get(h.paths.claude));
  data.mcpServers.zen.url = "http://127.0.0.1:9999/mcp";
  const changed = JSON.stringify(data);
  h.files.set(h.paths.claude, changed);
  await assert.rejects(h.setup.connect("claude"));
  assert.equal(h.clients.size, 1);
  assert.equal(h.files.get(h.paths.claude), changed);
});

test("edited Codex blocks fail ownership checks without changing an existing client", async () => {
  const h = harness();
  await h.setup.connect("codex");
  const changed = h.files.get(h.paths.codex).replace("3923", "9999");
  h.files.set(h.paths.codex, changed);
  await assert.rejects(h.setup.connect("codex"));
  assert.equal(h.clients.size, 1);
  assert.equal(h.files.get(h.paths.codex), changed);
});

test("a parser rejection does not issue access and a write failure revokes only the new grant", async () => {
  const h = harness();
  h.setup.validateCodex = async () => {
    throw new Error("bad TOML");
  };
  await assert.rejects(h.setup.connect("codex"));
  assert.equal(h.clients.size, 0);
  const first = await h.setup.connect("claude");
  const before = h.files.get(h.paths.claude);
  h.io.replace = async () => {
    throw new Error("concurrent update");
  };
  await assert.rejects(h.setup.connect("claude"));
  assert.equal(h.clients.size, 1);
  assert.ok(h.clients.has(first.client.id));
  assert.equal(h.files.get(h.paths.claude), before);
});

test("registry write failure restores the old file and retains its valid access", async () => {
  const h = harness();
  const first = await h.setup.connect("claude");
  const before = h.files.get(h.paths.claude);
  const replace = h.io.replace;
  h.io.replace = async (path, ...args) => {
    if (path === h.paths.registry) throw new Error("registry unavailable");
    return replace(path, ...args);
  };
  await assert.rejects(h.setup.connect("claude"));
  assert.equal(h.files.get(h.paths.claude), before);
  assert.deepEqual([...h.clients.keys()], [first.client.id]);
});

test("an externally revoked grant or changed endpoint cannot be installed", async () => {
  for (const invalidate of [
    (h) => h.clients.clear(),
    (h) => {
      h.service.getStatus = () => ({
        kind: "main",
        endpoint: "http://127.0.0.1:4444/mcp",
        clients: [],
      });
    },
  ]) {
    const h = harness();
    const add = h.service.addClient;
    h.service.addClient = async (name) => {
      const grant = await add(name);
      invalidate(h);
      return grant;
    };
    await assert.rejects(h.setup.connect("claude"));
    assert.equal(h.clients.size, 0);
    assert.equal(h.files.has(h.paths.claude), false);
  }
});

test("skills are separate for Playground, contain no token, update owned versions and preserve edits", async () => {
  const main = harness();
  const playground = harness("playground");
  for (const agent of ["codex", "claude"]) {
    const a = await main.setup.installSkill(agent);
    const b = await playground.setup.installSkill(agent);
    assert.notEqual(a.installedPath, b.installedPath);
    const text = playground.files.get(b.installedPath);
    assert.match(text, /^name: zen-playground$/m);
    assert.match(text, /server `zen_playground`/);
    assert.doesNotMatch(text, /[a-f0-9]{64}/);
    await main.setup.installSkill(agent);
    main.files.set(
      a.installedPath,
      main.files.get(a.installedPath) + "\nUser instructions\n",
    );
    await assert.rejects(main.setup.installSkill(agent));
    assert.match(main.files.get(a.installedPath), /User instructions/);
  }
  assert.equal(main.clients.size + playground.clients.size, 0);
  assert.match(agentSkill(template, "main"), /the main Zen instance/);
});

test("a foreign skill is not overwritten", async () => {
  const h = harness();
  const path = h.paths.skill("codex", "zen-browser");
  h.files.set(path, "User's existing skill");
  await assert.rejects(h.setup.installSkill("codex"));
  assert.equal(h.files.get(path), "User's existing skill");
});

test("connection strings use supported transports, correct instance names and safe shell quoting", () => {
  const result = agentConnection(
    { endpoint: "http://127.0.0.1:3924/mcp", token: "synthetic'quote" },
    "playground",
  );
  assert.equal(JSON.parse(result.json).mcpServers.zen_playground.type, "http");
  assert.match(
    result.codexCommand,
    /--bearer-token-env-var ZEN_PLAYGROUND_MCP_TOKEN/,
  );
  assert.match(result.codexCommand, /synthetic'\\''quote/);
  assert.match(
    result.claudeCommand,
    /--transport http --scope user zen_playground/,
  );
  for (const endpoint of [
    "https://example.test/mcp",
    "http://localhost:3923/mcp",
  ]) {
    assert.throws(() => agentConnection({ endpoint, token: "token" }, "main"));
  }
  assert.throws(() =>
    agentConnection(
      { endpoint: "http://127.0.0.1:3923/mcp", token: "token\nline" },
      "main",
    ),
  );
});

test("installed Codex parser accepts generated TOML and rejects an existing conflicting entry", async (t) => {
  try {
    execFileSync("codex", ["--version"], { stdio: "pipe" });
  } catch {
    t.skip("Codex CLI is not installed on this test host");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "zen-agent-config-test-"));
  const data = agentConnection(
    { endpoint: "http://127.0.0.1:3923/mcp", token: "a".repeat(64) },
    "main",
  );
  try {
    await writeFile(join(directory, "config.toml"), data.codex, {
      mode: 0o600,
    });
    const value = JSON.parse(
      execFileSync("codex", ["mcp", "get", "zen", "--json"], {
        cwd: directory,
        env: { ...process.env, CODEX_HOME: directory },
        encoding: "utf8",
        stdio: "pipe",
      }),
    );
    assert.equal(value.transport.url, data.entry.url);
    assert.equal(
      value.transport.http_headers.Authorization,
      data.entry.headers.Authorization,
    );
    await writeFile(join(directory, "config.toml"), data.codex + data.codex, {
      mode: 0o600,
    });
    assert.throws(() =>
      execFileSync("codex", ["mcp", "get", "zen", "--json"], {
        cwd: directory,
        env: { ...process.env, CODEX_HOME: directory },
        stdio: "pipe",
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
