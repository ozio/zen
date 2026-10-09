// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

export function agentNames(kind) {
  if (!["main", "playground"].includes(kind)) {
    throw new Error("Unknown browser instance kind");
  }
  return {
    server: kind === "playground" ? "zen_playground" : "zen",
    skill: kind === "playground" ? "zen-playground" : "zen-browser",
  };
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function agentConnection({ endpoint, token }, kind) {
  if (
    !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(endpoint) ||
    typeof token !== "string" ||
    !token ||
    /[\r\n\0]/.test(token)
  ) {
    throw new Error("Invalid local connection");
  }
  const { server } = agentNames(kind);
  const entry = {
    type: "http",
    url: endpoint,
    headers: { Authorization: `Bearer ${token}` },
  };
  const variable =
    kind === "playground" ? "ZEN_PLAYGROUND_MCP_TOKEN" : "ZEN_MCP_TOKEN";
  return {
    entry,
    json: JSON.stringify({ mcpServers: { [server]: entry } }, null, 2),
    codex:
      `[mcp_servers.${server}]\nurl = ${JSON.stringify(endpoint)}\n\n` +
      `[mcp_servers.${server}.http_headers]\nAuthorization = ${JSON.stringify(entry.headers.Authorization)}\n`,
    codexCommand:
      `export ${variable}=${quote(token)}\n` +
      `codex mcp add ${server} --url ${quote(endpoint)} --bearer-token-env-var ${variable}`,
    claudeCommand:
      `claude mcp add --transport http --scope user ${server} ${quote(endpoint)} ` +
      `--header ${quote(entry.headers.Authorization)}`,
  };
}

export function agentSkill(template, kind) {
  const { server, skill } = agentNames(kind);
  return template
    .replace(/^name: zen-browser$/m, `name: ${skill}`)
    .replaceAll(
      "main Zen browser",
      kind === "playground" ? "Zen Playground browser" : "main Zen browser",
    )
    .replaceAll("server `zen`", `server \`${server}\``)
    .replaceAll(
      "the main Zen instance",
      kind === "playground"
        ? "the Zen Playground instance"
        : "the main Zen instance",
    );
}

// Managed blocks are compared to a hash saved in the browser profile. A
// foreign/edited block must never be removed or overwritten based on its name.
export function codexConfig(previous, block, record, hash) {
  let prefix = previous ?? "";
  if (record) {
    const start = `# BEGIN Zen MCP ${record.owner}\n`;
    const end = `# END Zen MCP ${record.owner}\n`;
    const index = prefix.indexOf(start);
    const finish = prefix.indexOf(end, index + start.length);
    if (
      index < 0 ||
      finish < index ||
      (index !== 0 && prefix[index - 1] !== "\n") ||
      prefix.includes(start, index + start.length) ||
      hash(prefix.slice(index, finish + end.length)) !== record.digest
    ) {
      throw new Error("The connection configuration was changed outside Zen");
    }
    prefix = prefix.slice(0, index) + prefix.slice(finish + end.length);
  }
  return prefix + (prefix && !prefix.endsWith("\n") ? "\n" : "") + block;
}

export function claudeConfig(previous, server, entry, record, hash) {
  const data = previous == null ? {} : JSON.parse(previous);
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    (data.mcpServers != null &&
      (typeof data.mcpServers !== "object" || Array.isArray(data.mcpServers)))
  ) {
    throw new Error("Invalid Claude Code configuration");
  }
  const existing = data.mcpServers?.[server];
  if (
    (existing &&
      (!record || hash(JSON.stringify(existing)) !== record.digest)) ||
    (record && !existing)
  ) {
    throw new Error(
      "The connection configuration belongs to another client or was edited",
    );
  }
  data.mcpServers ??= {};
  data.mcpServers[server] = entry;
  return JSON.stringify(data, null, 2) + "\n";
}
