# FoxPilot routing audit

Audited on 2026-10-08 on macOS, against fork commit `c230ad531b6c11cfa2b83c52809f742e1be907f3` and the installed FoxPilot MCP/extension **1.0.22**. This is a source and configuration audit; applying the plan and proving live routing belong to the integration checks.

The ordinary FoxPilot connection and Playground should use **different broker ports**. A remembered `select-browser` action, the macOS default browser, and `DEFAULT_BROWSER` cannot keep a shared broker restricted to main Zen.

## Two independent identities

| Mechanism | Identity and current evidence | Consequence |
| --- | --- | --- |
| macOS external links/files | At audit time, both `/Applications/Zen.app` and `/Applications/Zen Playground.app` had `CFBundleIdentifier=app.zen-browser.zen`, HTTP/HTTPS/file URL declarations and nine document-type entries. | Launch Services cannot distinguish these packages by bundle identifier. The Playground package needs a separate identifier and no ordinary URL/document registrations; main keeps its normal identity. |
| FoxPilot browser commands | The extension generates a UUID in its own `browser.storage.local` configuration. Its hello advertises that ID, type and label to the broker. It does not advertise the app bundle identifier, profile path or visibility. | Broker selection is independent of Launch Services. Distinct app identifiers fix external-link ambiguity, but do not separate FoxPilot drivers. |
| Native `zen-playground` MCP | The repository bridge verifies the isolated launcher state, binary, profile and Marionette session. | Keep this intentionally restricted to Playground. It does not choose the ordinary FoxPilot driver. |

The parent observed distinct main/Playground FoxPilot IDs and, before this audit, only main connected and active. That observation alone does not prove routing after a reconnect or browser restart. No FoxPilot navigation, selection or other browser action was performed by this audit.

## Installed interfaces and selection behavior

The ordinary Codex `mcp_servers.foxpilot` entry runs `/Users/oz/n/bin/node` with `/Users/oz/.codex/integrations/foxpilot-zen/node_modules/foxpilot-mcp/dist/server.js`, and has `EXTENSION_PORT=8089`. A live broker was listening on both loopback families on that port. The Playground-installed XPI has the same digest as the recorded fresh extension package.

`server.js` connects to `ws://localhost:<EXTENSION_PORT>/mcp`, reusing a listening broker. When unavailable, it starts a detached `broker-main.js` with the selected port. The extension connects to `ws://127.0.0.1:<configured-port>/extension`, with IPv6 loopback fallback; HTTP long polling is also an existing transport option. Each entry in the extension's `config.ports` creates a connection, so a list containing both ports would defeat separation.

The broker implements these rules, in this order:

1. No registered browser: no target.
2. Exactly one registered browser: use it automatically, regardless of `DEFAULT_BROWSER`.
3. Two or more and an explicit `activeBrowserId`: use that browser.
4. Otherwise, optionally match `DEFAULT_BROWSER` to a browser **type or label**; otherwise require explicit selection.

`select-browser` changes one broker-wide in-memory `activeBrowserId`, shared by every MCP client connected to that broker. The extension's “select this browser” control changes the same field. No persisted selected-browser preference or strict main-browser-ID environment option was found in the installed entry points.

Replacing a stale socket under the same browser ID preserves the selection. Removing the current selected socket clears it; a later registration does not restore it. A broker restart initializes it to `null`. While main is disconnected, a sole connected Playground becomes the implicit driver. `DEFAULT_BROWSER=firefox` is also ambiguous because both extensions report type `firefox`; an explicit label still cannot override the sole-driver rule or an explicit Playground selection.

The only broker persistence found in these entry points is the control secret and log under `~/.foxpilot/`. Different ports reuse that secret and log by default, but maintain separate connection rosters and active-selection state. Port separation is a routing boundary, not cryptographic attestation of a browser profile.

## Minimal persistent separation

Use the existing extension options and MCP environment interface; no FoxPilot source patch is required for this plan.

| Connection | MCP `EXTENSION_PORT` | Extension's complete `config.ports` |
| --- | --- | --- |
| Ordinary `foxpilot` → main Zen | `8089` | Main: `[8089]` |
| Dedicated `foxpilot-playground` → Playground | `8091` | Playground: `[8091]` |

Port 8091 had no listener at the audit check. Recheck immediately before applying. Avoid 8090 here because FoxPilot's optional native-input sidecar defaults to that port.

1. In the **verified Playground** extension's options, open **WebSocket Ports**, replace the list with `8091`, and use **Save Ports**. This stores the list and reloads the extension. Preserve its browser ID, permissions, tool settings and existing authentication configuration. Confirm main's port list contains only `8089`.
2. Retain the ordinary `foxpilot` configuration. Add a separately named Playground server using the same installed executable and entry point:

   ```toml
   [mcp_servers.foxpilot-playground]
   command = "/Users/oz/n/bin/node"
   args = ["/Users/oz/.codex/integrations/foxpilot-zen/node_modules/foxpilot-mcp/dist/server.js"]
   startup_timeout_sec = 30

   [mcp_servers.foxpilot-playground.env]
   EXTENSION_PORT = "8091"
   ```

3. Preserve the explicit `startup_timeout_sec = 30` when registering the new entry, matching the ordinary connection. Load the updated MCP configuration in the intended client and prove both connections through their separate tool namespaces. Saving the file is not proof that the client loaded it. The dedicated server starts/reuses its own broker automatically. Do not restart unrelated ordinary clients or change `HOME`, profiles, secrets or global Node defaults.
4. Read each broker's browser roster. Ordinary must contain only the main ID; dedicated must contain only the Playground ID. Correlate these IDs with a synthetic page marker and the verified Playground native identity; a label or green badge alone is insufficient.

This persists through profile/extension and client restarts because each extension stores its port list and each MCP entry supplies its port. Removing/reinstalling the extension, resetting Playground or restoring older extension settings may restore the default 8089; reapply and verify the separation after those operations. If an additional browser extension joins the ordinary port, the stock broker can select it; the plan specifically prevents Playground from joining that port.

### Fresh options URL and safe read-back

The options page is `moz-extension://<profile-specific-extension-UUID>/options.html`. Resolve it again after a reset/reinstall; the UUID is different from FoxPilot's own broker browser ID. In an already identity-verified Playground chrome diagnostic context, Firefox exposes this read-only lookup:

```javascript
const policy = WebExtensionPolicy.getByID("foxpilot@balakumar.dev");
if (!policy?.active) throw new Error("FoxPilot is not active in this instance");
policy.getURL("options.html");
```

Prefer the real extension options UI. Inspect fresh controls, enter `8091` into `#ports-input`, then click `#save-ports` through a trusted browser interaction. Setting the value and calling a DOM-generated click alone does not meet the save handler's `event.isTrusted` requirement. After the extension reload, re-open/refresh its options page and verify the displayed field contains only `8091`; main's displayed field must contain only `8089`.

For a separate storage read-back **inside that extension's own origin**, the actual API is:

```javascript
const { config = {} } = await browser.storage.local.get("config");
({ ports: config.ports ?? [8089], browserId: config.browserId ?? null });
```

Read back only these routing fields. Never dump the whole config, secret or audit log. This setting is WebExtension local storage, not a Firefox preference; `user.js`/`prefs.js` edits cannot replace the supported save operation. A storage/field read-back is still insufficient without the corresponding broker roster and synthetic-marker checks.

Do not rely on a one-time `select-browser`, a changed macOS default handler, `DEFAULT_BROWSER`, a renamed application, or a disabled visual badge as the routing fix. Do not give Playground `[8089, 8091]`.

## Source evidence

The installed MCP package root is `/Users/oz/.codex/integrations/foxpilot-zen/node_modules/foxpilot-mcp`. The extension sources below are members of `.zen-local/extensions/foxpilot@balakumar.dev.xpi` and the identical Playground-installed XPI.

| Source pointer in the audited 1.0.22 artifact | What it establishes |
| --- | --- |
| XPI `dist/background.js:330–365` | `browser.storage.local` config, UUID generation, stored browser label and default `firefox` type. |
| XPI `dist/background.js:449–462`, `489–525` | Hello identity and WebSocket extension endpoint with loopback fallback. |
| XPI `dist/background.js:656–668`, `6801–6806` | The extension can request broker-wide active selection. |
| XPI `dist/background.js:6845–6859` | The extension connects every configured port. |
| XPI `dist/options.js:270–277`, `1075–1094`; `options.html:1293–1310` | Existing port setting UI, persistence, validation and extension reload. |
| MCP `dist/server.js:34144–34203`, `34256–34291`, `34820–34824` | Port selection, reuse/auto-spawn, `/mcp` endpoint and broker log. |
| MCP `dist/server.js:35319–35368` | Public `list-browsers` and `select-browser` tools. |
| MCP `dist/broker-main.js:4174`, `4440–4478`, `4538–4549` | In-memory active field, same-ID replacement, disconnect reset, extension selection. |
| MCP `dist/broker-main.js:4615–4637`, `4741–4764` | Target resolution and broker-wide MCP selection. |
| MCP `dist/broker-main.js:5017–5066`, `5090–5111` | Secret storage, supported broker config and loopback binding. |
| Prepared Firefox `engine/dom/chrome-webidl/WebExtensionPolicy.webidl:265`, `294` | Read-only active-extension lookup and generated options URL API. |
| Both installed apps' `Contents/Info.plist` | Pre-fix shared bundle ID and URL/document registrations, inspected independently of broker settings. |

Digests for reproducing this audit:

```text
FoxPilot XPI:         dc02acefbc4e22d10a8829357a651c8fc069f376a90d6c739ea34b7ab8e50394
MCP dist/server.js:   62a79d9cdb1f0120c77e088d978c0ddb82a49e588b6eeffb81975c09ddf6ffe4
MCP broker-main.js:   67e58523610c70802d318120432d0692283edd70b90c356c41b16e8c44eb9c03
```

An isolated harness executed the installed broker's extracted `resolveTarget`, `registerExtension`, `removeExtension` and `listBrowserInfo` methods with synthetic connections. Sole-Playground fallback, explicit-selection precedence, same-ID replacement and disconnect/reconnect behavior passed. This test created no broker or socket and changed no configuration/profile. It proves the source behavior, not live client integration.

## Integration acceptance still required

After applying, use synthetic URLs only and retain the same isolated Playground profile. Prove ordinary FoxPilot opens/reads/acts on a temporary page in main while Playground is running and hidden; prove the dedicated namespace acts only in Playground. Restart Playground and then restart/reconnect the relevant MCP clients and repeat roster/marker checks. Check the ordinary roster while main is unavailable: it must have no Playground driver. Preserve unrelated tabs and close only the temporary verification tabs.

Separately, verify the derived Playground package has its unique identity and no HTTP/HTTPS/file or document registration, main still owns the default handlers, and a real external link opens in main. Broker checks and Launch Services checks have separate pass/fail outcomes. Packaged-binary, extension and native integration compatibility remain the integration owner's acceptance work.
