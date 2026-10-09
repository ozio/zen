// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import {
  agentConnection,
  agentNames,
  agentSkill,
  codexConfig,
  claudeConfig,
} from "./ZenMcpAgentConfig.sys.mjs";

export class ZenMcpAgentSetup {
  constructor({ io, paths, hash, id, validateCodex, readSkill, service }) {
    Object.assign(this, {
      io,
      paths,
      hash,
      id,
      validateCodex,
      readSkill,
      service,
    });
    this.queue = Promise.resolve();
  }

  serialize(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async registry() {
    const text = await this.io.read(this.paths.registry);
    if (text == null) {
      return { version: 1, agents: {} };
    }
    const data = JSON.parse(text);
    if (
      data.version !== 1 ||
      !data.agents ||
      typeof data.agents !== "object" ||
      Array.isArray(data.agents)
    ) {
      throw new Error("Invalid agent installation registry");
    }
    for (const [agent, record] of Object.entries(data.agents)) {
      if (
        !["codex", "claude"].includes(agent) ||
        !record ||
        typeof record.path !== "string" ||
        typeof record.clientId !== "string" ||
        !/^[a-zA-Z0-9-]{1,64}$/.test(record.owner) ||
        !/^[a-f0-9]{64}$/.test(record.digest) ||
        !["zen", "zen_playground"].includes(record.server)
      ) {
        throw new Error("Invalid agent installation record");
      }
    }
    return data;
  }

  connect(agent) {
    return this.serialize(() => this._connect(agent));
  }

  async _connect(agent) {
    if (!["codex", "claude"].includes(agent)) {
      throw new Error("Unknown MCP client");
    }
    const status = this.service.getStatus();
    const { server } = agentNames(status.kind);
    const path = this.paths[agent];
    const registryBefore = await this.io.read(this.paths.registry);
    const registry = await this.registry();
    const record = registry.agents[agent];
    if (record && (record.path !== path || record.server !== server)) {
      throw new Error("The client configuration location changed");
    }
    const before = await this.io.read(path);
    const owner = record?.owner || this.id();
    const build = (grant) => {
      const connection = agentConnection(grant, status.kind);
      const block = `# BEGIN Zen MCP ${owner}\n${connection.codex}# END Zen MCP ${owner}\n`;
      return {
        text:
          agent === "codex"
            ? codexConfig(before, block, record, this.hash)
            : claudeConfig(before, server, connection.entry, record, this.hash),
        digest: this.hash(
          agent === "codex" ? block : JSON.stringify(connection.entry),
        ),
        entry: connection.entry,
      };
    };
    // Preflight ownership, TOML syntax and the actual installed Codex parser
    // before issuing access. No commands run from page content or shell text.
    const sample = { endpoint: status.endpoint, token: "0".repeat(64) };
    const prepared = build(sample);
    if (agent === "codex") {
      await this.validateCodex(prepared.text, server, prepared.entry);
    }
    const prefix = agent === "codex" ? "Codex" : "Claude Code";
    let name = prefix;
    for (
      let index = 2;
      status.clients.some((client) => client.name === name);
      index++
    ) {
      name = `${prefix} (${index})`;
    }
    const grant = await this.service.addClient(name);
    let written = false;
    let registered = false;
    let output;
    try {
      output = build(grant);
      if (agent === "codex") {
        await this.validateCodex(output.text, server, output.entry);
      }
      if (
        this.service.getStatus().endpoint !== grant.endpoint ||
        !this.service.hasClient(grant.client.id)
      ) {
        throw new Error("Access or endpoint changed during setup");
      }
      await this.io.replace(path, before, output.text, true);
      written = true;
      registry.agents[agent] = {
        owner,
        path,
        server,
        digest: output.digest,
        clientId: grant.client.id,
      };
      await this.io.replace(
        this.paths.registry,
        registryBefore,
        JSON.stringify(registry),
        false,
      );
      registered = true;
    } catch {
      // Never revoke an existing working connection until its replacement is
      // recorded. Roll back only a file whose exact new contents still match.
      if (written && !registered) {
        await this.io.restore(path, output.text, before).catch(() => {});
      }
      await this.service.revokeClient(grant.client.id);
      throw new Error("Could not install the MCP connection");
    }
    if (record?.clientId && this.service.hasClient(record.clientId)) {
      await this.service.revokeClient(record.clientId);
    }
    return { ...grant, installedPath: path };
  }

  installSkill(agent) {
    return this.serialize(async () => {
      if (!["codex", "claude"].includes(agent)) {
        throw new Error("Unknown skill client");
      }
      const kind = this.service.getStatus().kind;
      const path = this.paths.skill(agent, agentNames(kind).skill);
      const text = agentSkill(await this.readSkill(), kind);
      const marker = "<!-- Installed by Zen built-in MCP. -->\n";
      const before = await this.io.read(path);
      const receiptPath = `${path}.zen.json`;
      const receiptBefore = await this.io.read(receiptPath);
      if (
        before != null &&
        (!receiptBefore ||
          JSON.parse(receiptBefore).digest !== this.hash(before))
      ) {
        throw new Error(
          "An existing skill was not installed by Zen or was edited",
        );
      }
      const output = text + "\n" + marker;
      await this.io.replace(path, before, output, false);
      try {
        await this.io.replace(
          receiptPath,
          receiptBefore,
          JSON.stringify({ version: 1, digest: this.hash(output) }),
          false,
        );
      } catch {
        await this.io.restore(path, output, before);
        throw new Error("Could not record skill installation");
      }
      return { installedPath: path };
    });
  }
}

export function createAgentSetup(service, hash, id) {
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
    "resource://gre/modules/Timer.sys.mjs",
  );
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const codexHome =
    Services.env.get("CODEX_HOME") || PathUtils.join(home, ".codex");
  const claudeHome = Services.env.get("CLAUDE_CONFIG_DIR");
  const paths = {
    codex: PathUtils.join(codexHome, "config.toml"),
    claude: claudeHome
      ? PathUtils.join(claudeHome, ".claude.json")
      : PathUtils.join(home, ".claude.json"),
    registry: PathUtils.join(PathUtils.profileDir, "zen-mcp-agent-setup.json"),
    skill: (agent, name) =>
      PathUtils.join(
        agent === "codex"
          ? PathUtils.join(home, ".agents")
          : claudeHome || PathUtils.join(home, ".claude"),
        "skills",
        name,
        "SKILL.md",
      ),
  };

  function assertPath(path) {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    for (let parent = file; parent; parent = parent.parent) {
      if (parent.exists() && parent.isSymlink()) {
        throw new Error("Agent installation paths must not be symbolic links");
      }
    }
  }

  async function read(path) {
    assertPath(path);
    if (!(await IOUtils.exists(path))) {
      return null;
    }
    const stat = await IOUtils.stat(path);
    if (stat.type !== "regular" || stat.size > 2 * 1024 * 1024) {
      throw new Error("Invalid agent configuration file");
    }
    return IOUtils.readUTF8(path);
  }

  async function privateWrite(path, text) {
    const temporary = `${path}.zen-${id()}.tmp`;
    try {
      // Create an empty private file before any credential bytes are written.
      await IOUtils.writeUTF8(temporary, "", { mode: "create" });
      await IOUtils.setPermissions(temporary, 0o600);
      await IOUtils.writeUTF8(temporary, text, { flush: true });
      return temporary;
    } catch {
      await IOUtils.remove(temporary, { ignoreAbsent: true }).catch(() => {});
      throw new Error("Could not prepare a private configuration file");
    }
  }

  const io = {
    read,
    async replace(path, before, text, backup) {
      assertPath(path);
      await IOUtils.makeDirectory(PathUtils.parent(path), {
        createAncestors: true,
        permissions: 0o700,
      });
      const temporary = await privateWrite(path, text);
      try {
        if ((await read(path)) !== before) {
          throw new Error("Agent configuration changed during installation");
        }
        if (backup && before != null) {
          const saved = await privateWrite(`${path}.zen-backup`, before);
          await IOUtils.move(saved, `${path}.zen-backup-${id()}`, {
            noOverwrite: true,
          });
        }
        await IOUtils.move(temporary, path, { noOverwrite: before == null });
      } finally {
        await IOUtils.remove(temporary, { ignoreAbsent: true });
      }
    },
    async restore(path, expected, previous) {
      if ((await read(path)) !== expected) {
        throw new Error("Agent configuration changed before recovery");
      }
      if (previous == null) {
        await IOUtils.remove(path);
      } else {
        await this.replace(path, expected, previous, false);
      }
    },
  };

  async function validateCodex(text, server, entry) {
    const search = [
      ...(Subprocess.getEnvironment().PATH?.split(
        Services.appinfo.OS === "WINNT" ? ";" : ":",
      ) || []),
      PathUtils.join(home, ".bun", "bin"),
      PathUtils.join(home, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ];
    let command;
    for (const directory of search) {
      if (!directory || !PathUtils.isAbsolute(directory)) {
        continue;
      }
      const candidate = PathUtils.join(
        directory,
        Services.appinfo.OS === "WINNT" ? "codex.exe" : "codex",
      );
      if (await IOUtils.exists(candidate)) {
        command = candidate;
        break;
      }
    }
    if (!command) {
      throw new Error("Install the Codex CLI or use the manual configuration");
    }
    const tempRoot = Services.dirsvc.get("TmpD", Ci.nsIFile);
    tempRoot.normalize();
    const directory = PathUtils.join(tempRoot.path, `zen-mcp-codex-${id()}`);
    await IOUtils.makeDirectory(directory, { permissions: 0o700 });
    let process;
    let timer;
    try {
      await io.replace(
        PathUtils.join(directory, "config.toml"),
        null,
        text,
        false,
      );
      process = await Subprocess.call({
        command,
        arguments: ["mcp", "get", server, "--json"],
        environment: { CODEX_HOME: directory },
        environmentAppend: true,
        workdir: directory,
        stderr: "pipe",
      });
      const drain = async (pipe) => {
        let result = "";
        for (;;) {
          const chunk = await pipe.readString();
          if (!chunk) {
            return result;
          }
          result += chunk;
          if (result.length > 2 * 1024 * 1024) {
            throw new Error("Codex configuration output exceeded its limit");
          }
        }
      };
      const result = await Promise.race([
        Promise.all([
          process.wait(),
          drain(process.stdout),
          drain(process.stderr),
        ]),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Codex configuration validation timed out")),
            10000,
          );
        }),
      ]);
      const config = JSON.parse(result[1]);
      if (
        result[0].exitCode !== 0 ||
        config.transport?.url !== entry.url ||
        config.transport?.http_headers?.Authorization !==
          entry.headers.Authorization
      ) {
        throw new Error("Codex did not accept this MCP configuration");
      }
    } catch {
      throw new Error(
        "Install the Codex CLI and check its connection configuration",
      );
    } finally {
      clearTimeout(timer);
      if (process) {
        await process.kill().catch(() => {});
      }
      await IOUtils.remove(directory, { recursive: true });
    }
  }

  return new ZenMcpAgentSetup({
    io,
    paths,
    hash,
    id,
    validateCodex,
    service,
    readSkill: async () => {
      const response = await fetch("resource:///modules/zen/mcp/SKILL.md");
      if (!response.ok) {
        throw new Error("The bundled skill is unavailable");
      }
      return response.text();
    },
  });
}
