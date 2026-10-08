# Native Zen Playground control

This bridge inspects and operates actual Zen browser chrome: its sidebar, tabs, toolbar controls, panels and Spaces. It connects to the source-built browser launched by `tools/local/dev.py` with the dedicated `.zen-local/profiles/playground` profile. Python 3.9 or newer is sufficient; there are no third-party dependencies.

The bridge does not start or stop browsers. Start the playground using the launcher described in [DEVELOPMENT.md](../../DEVELOPMENT.md), then connect one control client. Marionette supports one active automation session. Disconnect a temporary CLI/harness session before asking an MCP client to connect.

## Quick verification

Run from the repository root:

```sh
python3 -m unittest discover -s tools/playground/tests -v
python3 tools/playground/check_protocol.py
python3 tools/playground/server.py check-live
python3 tools/playground/server.py inspect --selector 'toolbarbutton,tab,input' --limit 100
python3 tools/playground/check_protocol.py --live --screenshot .zen-local/native-chrome.png
```

The default protocol harness starts only stdio server processes. It checks initialization, the exact tool inventory, invalid dispatch, and refusal when launcher state is missing. It never opens a browser connection. A successful default run prints `MCP PROTOCOL VERIFIED`.

`check-live` returns identity and browser state. `inspect` returns native chrome elements, but its handles expire when the command exits. Use a persistent MCP session for interaction. The live stdio harness reads state and chrome elements and captures a viewport PNG; it prints `MCP LIVE VERIFIED` only after those reads succeed. These reads and the native action sequence below are separate acceptance evidence. No browser-runtime claim follows from unit tests alone.

## MCP setup

The server uses standard newline-delimited UTF-8 JSON-RPC on stdin/stdout. It emits diagnostics only on stderr. It negotiates the supported MCP versions and advertises only its tools. This follows the official [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [initialization lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle).

For Codex, register the command after choosing an absolute Python executable and checkout path:

```sh
codex mcp add zen-playground -- /absolute/path/to/python3 /absolute/path/to/Zen/tools/playground/server.py serve --repo /absolute/path/to/Zen
codex mcp get zen-playground --json
```

The first command writes the user's Codex MCP configuration. The repository tools do not perform that configuration change. Start a new Codex session after registration. The command form was checked with the installed CLI's `mcp add --help`; configuration details are documented in the official [Codex MCP guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The equivalent Codex TOML entry is:

```toml
[mcp_servers.zen-playground]
command = "/absolute/path/to/python3"
args = ["/absolute/path/to/Zen/tools/playground/server.py", "serve", "--repo", "/absolute/path/to/Zen"]
startup_timeout_sec = 10
tool_timeout_sec = 60
```

For MCP clients using the common `mcpServers` JSON format, adapt [mcp.example.json](mcp.example.json). Replace both checkout placeholders and choose the local Python executable. On Windows use `python.exe` and absolute Windows paths; JSON backslashes must be escaped, or use forward slashes accepted by Python. No system-access environment variable belongs in the MCP server config: only the isolated browser launcher receives it.

Remove a Codex registration with `codex mcp remove zen-playground`. This removes the MCP registration; the launcher owns browser shutdown and profile lifecycle.

## Tools and freshness

| Tool | Arguments | Result / action |
| --- | --- | --- |
| `playground_state` | none | Verified PID, binary, profile, source SHA and launch session; current browser windows, tabs and Spaces |
| `playground_inspect` | optional CSS `selector`, `include_hidden`, `limit` (1–2000) | Native chrome DOM metadata, `snapshot_id`, element `handle`s, and browser state; default visible controls, at most 300 |
| `playground_click` | `snapshot_id`, `handle` | Native WebDriver pointer click, or XUL command for an open native menu; state read-back |
| `playground_input` | `snapshot_id`, `handle`, `text`, optional `clear` (default true) | Native WebDriver clear/send-keys; state read-back; supplied text is not echoed |
| `playground_tabs` | `action`: `open`, `select`, `close`; optional `url`; `snapshot_id` and `handle` required for select/close | Open HTTP(S) or `about:blank`; select native tab; close that tab while preserving the final tab |
| `playground_spaces` | `snapshot_id`, `space_id` from that inspection's `browser.spaces` | Select an existing Space using Zen's browser API and confirm its active ID |
| `playground_screenshot` | none | MCP PNG image of the native chrome viewport |

Get a new `playground_inspect` snapshot before every click, input, tab select/close or Space selection. Handles are backed by Marionette native element references and kept only in that MCP process. A snapshot expires after 30 seconds, is replaced by the next inspection, and is consumed by one action. Before dispatch, the bridge checks document identity, connection, visibility, enabled state and the element's identity attributes. Unknown, replaced, disabled, expired or consumed elements refuse interaction. The action is never retried automatically.

Example calls within one initialized MCP connection:

```json
{"name":"playground_inspect","arguments":{"selector":"tab"}}
{"name":"playground_tabs","arguments":{"action":"select","snapshot_id":"RETURNED_SNAPSHOT","handle":"RETURNED_TAB_HANDLE"}}
{"name":"playground_inspect","arguments":{"selector":"#urlbar-input"}}
{"name":"playground_input","arguments":{"snapshot_id":"RETURNED_SNAPSHOT","handle":"RETURNED_INPUT_HANDLE","text":"https://example.com\uE007"}}
```

The `\uE007` WebDriver key means Enter. Resolve identifiers from the returned live inspection rather than assuming an element exists. CSS inspection includes open shadow roots in the current chrome document, including Firefox's extension permission buttons. Open macOS native menu items are identified with `native_menu=true`; their zero DOM rectangle is expected. The bridge rechecks that their containing popup is open before dispatching the XUL command. Other clicks use actual pointer down/up events and refuse an obscured target. Native window IDs come from Firefox 157's `windowGlobalChild.outerWindowId`.

Separate operating-system modal windows need an appropriate native app tool. Spaces switch only when the running Zen API supports it; creation, deletion and naming can be operated through inspected native UI controls. There is no caller-provided JavaScript evaluator, page-content API, profile selector or browser-quit tool.

## Native action acceptance recipe

Use one persistent stdio connection, for example `check_protocol.Session` from a short local Python script. Capture the identity, source SHA and image alongside observations under ignored `.zen-local/`.

1. `playground_state`: verify the intended source and clean profile; check `[ZEN PLAYGROUND]` in the actual `browser.title` and listed window titles.
2. `playground_tabs` with `action=open,url=about:blank`; read back the new tab count.
3. `playground_inspect` with `selector=tab`; choose the newly opened tab handle, then select it with `playground_tabs` and read back `selected`.
4. Inspect `#urlbar-input`, send a harmless URL plus `\uE007` through `playground_input`, and read back the selected tab URL. Take a screenshot to inspect the visible result.
5. Inspect again, close only the temporary tab, and verify the original tab count. Confirm a reuse of the consumed snapshot returns a tool error.
6. If there are at least two Spaces, inspect, switch to another returned Space ID, and confirm `active`. Inspect again before restoring the prior Space. If there is only one Space, record that runtime switching was not exercised.

The protocol test and live-read harness do not substitute for these actual native actions. Extension/native-host compatibility is a separate launcher/integration acceptance task.

## Identity boundary

`--repo` must be an absolute canonical checkout path. There is no `--state` override: the only state file is that checkout's `.zen-local/state.json`.

Before connecting, the bridge requires schema v1 and a `playground` record containing exact `binary`, `profile`, positive integer `pid`, lowercase 40-character `source_sha`, `marionette_host` equal to `127.0.0.1`, integer `marionette_port`, `marker` equal to `ZEN PLAYGROUND`, a per-launch UUID `session_id`, and `artifact_manifest`. The launcher also records optional `app_bundle` and `started_at`; those are not identity substitutes.

The macOS launcher selects the separately branded manifest in `.zen-local/playground-artifacts/<source_sha>/`. The bridge binds its exact main origin in `.zen-local/artifacts/<source_sha>/manifest.json`, checks base and derived hashes/signing metadata against launch state, and requires `io.ozio.zen.playground`, the red icon digest, and no URL/document/activity handlers in the actual artifact and deployed app. The two binary digests may differ because of re-signing. Legacy base artifacts and Linux/Windows use the exact `.zen-local/artifacts/<source_sha>/manifest.json` path; arbitrary manifest copies are refused.

On macOS the deployed executable must be exactly `/Applications/Zen Playground.app/Contents/MacOS/zen`, with this checkout's matching `.zen-local/deployments/playground/<source_sha>.json` tied to both manifests and binary/tree hashes. No other external executable, including the daily `/Applications/Zen.app`, is accepted. The profile must be exactly `.zen-local/profiles/playground`, and its `zen-playground.json` ownership marker must match the checkout and launch session. Paths, profile preferences and identity files refuse symlinks/reparse points. Identity files must belong to the current Unix user and must not be writable by other users. Full package inventory and codesign verification are performed by packaging/staging, and runtime signature checks remain required; the bridge's per-action guard does not replace them.

The running process must use the exact binary and explicit `--no-remote --profile <exact playground path> --marionette` arguments. macOS reads exact arguments with `KERN_PROCARGS2` and the executable with `proc_pidpath`; Linux reads `/proc`; Windows uses `Win32_Process` and `CommandLineToArgvW`. Unsupported hosts refuse control.

Only after that process proof does the bridge open IPv4 loopback. Marionette's returned process/profile capabilities must match before entering chrome context. A fixed read-only identity script then verifies browser PID, profile, executable, marker, launch UUID, port and actual `RemoteAgent.allowSystemAccess`. Every tool repeats process/state and in-browser checks; changing launch identity invalidates the connection and handles. The only subsequent bootstrap effect is a visible `[ZEN PLAYGROUND]` title preface maintained across title changes and newly opened browser windows in that process. Firefox 157's title implementation consumes `titlepreface`; a legacy `titlemodifier` alone would be insufficient. The live harness checks the actual resulting titles.

The isolated launcher sets `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` for that child browser only. Mozilla's [RemoteAgent implementation](https://github.com/mozilla-firefox/firefox/blob/main/remote/components/RemoteAgent.sys.mjs) defines the system-access environment switch, and the [Marionette driver](https://github.com/mozilla-firefox/firefox/blob/main/remote/marionette/driver.sys.mjs) enforces privileged-context access. The default [Marionette port](https://firefox-source-docs.mozilla.org/remote/marionette/Prefs.html) is 2828. No remote listener, tunnel, global environment export or personal browser configuration is needed.

The stdlib transport implements Gecko Marionette protocol 3 with byte-counted `length:JSON` frames and matched response IDs, following the official [Marionette protocol](https://firefox-source-docs.mozilla.org/remote/marionette/Protocol.html) and [reference client transport description](https://firefox-source-docs.mozilla.org/python/marionette_driver.html#module-marionette_driver.transport). It rejects malformed, oversized, truncated and mis-sequenced packets. This boundary protects accidental targeting and local path/process mixups; it is not a sandbox against another process running as the same operating-system user.

## Validation scope

Unit tests exercise framing against sockets and a fake loopback server, actual host process argument inspection, MCP JSON-lines lifecycle/dispatch/errors, exact artifact/profile identity, personal-browser refusal, tampered hashes, symlink preferences/state/profile, freshness and consumed handles. The suite and stdio harness run on the host's Python 3.9 without pip. Linux and Windows process adapters are provided; actual browser runtime proof remains platform-specific and must be recorded by integration runs.

For a refusal, check the launcher state and log through `tools/local/dev.py`; do not weaken the guard or repoint the profile to bypass an error. A busy Marionette session needs its existing control client to disconnect. After an action reports an error, inspect/read back the browser before deciding whether to take another action.

Ordinary webpage `foxpilot` uses only main Zen on broker port 8089. Dedicated `foxpilot-playground` uses only the Playground extension on 8091. Native `zen-playground` remains this guarded Marionette bridge. Configure and reverify the extension after a reset as described in [DEVELOPMENT.md](../../DEVELOPMENT.md#separate-ordinary-and-playground-page-mcp).
