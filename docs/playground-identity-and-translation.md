# Playground identity and Russian page translation, 2026-10-08

The source candidate is `47e576d02d5542475eb4c3b092abd7e99dccf5f2` on `dev`. It was fully built, packaged and tested on macOS 26.6.2 ARM64, then installed as `/Applications/Zen.app`. The existing personal profile and all 301 tab URLs were preserved across normal shutdown and restart; only their count and a multiset hash were recorded.

## Application separation

| Application | Bundle identifier | Icon | HTTP/HTTPS, document and browsing-activity registration |
|---|---|---|---|
| Daily `/Applications/Zen.app` | `app.zen-browser.zen` | Original Zen icon | Retained |
| `/Applications/Zen Playground.app` | `io.ozio.zen.playground` | Same ring design in red | Removed |

The Playground branding is applied to a derived package after the main package is sealed. It does not change Zen feature source or the daily icon. `run playground` creates this variant automatically on macOS, preserves signing entitlements, signs its new identity with the selected certificate and verifies it before and after startup. Its manifest binds the exact immutable main package. Native MCP verifies the derived application, explicit managed profile, process and base/variant receipts; its main-app refusals remain covered by the native guard tests.

The red image and ICNS are tracked under [configs/playground-branding](../configs/playground-branding/README.md), outside Surfer's complete build-brand directories. The README records the built-in image-generation edit mode, prompt and asset provenance. The installed application's icon was rendered through `NSWorkspace`; it is red while the daily app retains the original icon digest.

The previous collision was confirmed: both applications had `app.zen-browser.zen`, and Launch Services resolved HTTP/HTTPS to Playground. The owned legacy Playground registration was removed during guarded replacement, the new distinct application was registered, and the daily application was registered explicitly. The system's default browser identifier was preserved. A normal external `open URL`, without an application override and with Playground hidden, reached daily Zen and loaded the synthetic fixture. It created no Playground tab.

## MCP routing

Changing the macOS bundle identifier does not select a FoxPilot driver. The installed broker automatically uses its sole connected extension, and its explicit selection is shared across clients. The solution uses separate connection rosters:

| Connection | Server port | Extension's complete stored port list |
|---|---|---|
| Ordinary `foxpilot`, daily websites | 8089 | `[8089]` |
| `foxpilot-playground`, test websites | 8091 | `[8091]` |
| `zen-playground`, test browser chrome | Verified loopback Marionette state | Managed Playground only |

The dedicated FoxPilot entry is registered in the local Codex configuration and its tools are available in this chat. Playground's port was saved through the extension's trusted options UI and read back after the extension reloaded. Ordinary configuration was preserved. Both real stdio MCP clients and the loaded Codex tool namespaces reported different drivers; synthetic page snapshots, counter clicks and read-backs correlated each driver with the correct instance.

The same separation passed after a normal Playground restart. During daily Zen's installation shutdown, the ordinary roster became empty and an ordinary open-tab request failed without creating a Playground tab; the dedicated driver remained connected. Daily FoxPilot reconnected after the main application restarted. No one-time driver selection is needed for this separation. See [the source and routing audit](foxpilot-routing-audit.md) for reset/reinstallation instructions.

## Page context menu

Right-click ordinary page text or background to select **Перевести на русский**. Once translation has started, that item becomes **Показать оригинал**, including while models are loading. It uses Firefox's native translation actor with target `ru`; native page restoration reloads the original. Source/preferred languages cannot silently change the target to English. Selection, link, image, editable, iframe and internal-page menus retain their existing behavior.

The loopback `/translation` fixture contains a long English page, one heading and five paragraphs. A real pointer right-click and native menu command translated every paragraph into Russian: 1,202 Cyrillic characters, native language pair `en → ru`, engine ready and visible content changed. A second right-click showed **Показать оригинал** and restored the exact original text and title. Original and restored text SHA-256 both equal `ceb2661fec38b656cdfffe08c5f344212722b3d673240d4548ebcb1d4af25560`.

The initial Playground test found a user override disabling `browser.translations.enable` in that test profile. Removing only that override restored the native enabled default. The daily profile had no disabling override. The implementation still respects disabled or policy-managed translation; it does not silently turn on translation whenever a context menu opens.

## Exact artifacts and verification

| Item | Value |
|---|---|
| Zen / Gecko | 1.23.1b / 157.0.1 |
| Compiler / SDK / deployment target | Clang 22.1.8 / MacOSX26.5.sdk / 11.0 |
| Node / Python / Rust | 22.23.3 / 3.11.15 / 1.95.0 |
| Full-build mozconfig SHA-256 | `0cc6a82c383b035e2b67c39073b1ecd477e7f5db6931d6b74398e82ee98e111e` |
| Main executable SHA-256 | `4cd01b153aa0caec9c28f7b5ac26df83d3d1442142382e7973cceee333bfb9d5` |
| Main tree SHA-256 | `9209b88de7f82e429e6cdfb396558b58d2f994064d0e34a1d4908620ba348f49` |
| Playground executable SHA-256 | `561989dc39b23a2364340e0997143f53f2a765921c48ba294516e46b639ab5e5` |
| Playground tree SHA-256 | `9961013b7a0252f97acec60cbbea1acdaa54976868c1ae5e99bf46c13e9660f6` |
| Playground ICNS SHA-256 | `6fa434e52a21a85e0b41da5c1f3c437a253bab9ec67d7e0c1a3af13d09139ad0` |

Both applications use the authorized Apple Development certificate, have complete deep/strict signatures verified after startup, and are not notarized. The differently signed executables intentionally have different digests.

Passed checks include the full native build; independently reviewed packaging, translation and routing changes; 68 development-control, 45 native-bridge and 53 translation tests; canonical translation wiring; and a repeat import with identical translation/PiP hashes. The import control reverses only identified previously applied canonical overlays, retains a scoped recovery receipt and refuses mismatched engine changes. It preserves the existing PiP customization.

The same originally fresh Playground profile retained the synthetic persistent cookie, localStorage counter `42`, pinned tabs and Space membership after upgrading and restarting. All five separately installed signed extensions remained active at their accepted versions. Native stdio MCP performed actual chrome/tab/Spaces actions and a live inspection/screenshot. Compiled updating and Playground update preferences remain disabled; Sync remains signed out.

Enpass 6.12.7 (2787), through the fresh extension 6.11.18.2, returned a real native `greetings` response and reported authentication not required, without a browser-trust rejection. Only protocol/status evidence was collected; raw logs, vault contents and keys were not exported. The user's earlier plugin acceptance remains applicable. Vault unlock/autofill and the cancelled Keepa CAPTCHA check were not repeated.

Linux and Windows setup recipes remain available, but these application-identity, integration and translation runtime checks were performed only on macOS. The macOS derived-package implementation does not establish Linux/Windows application registration or packaging behavior.

## Launch and rollback

Documentation commits may advance HEAD beyond the retained binary. Launch this exact candidate with:

```sh
source .zen-local/env.sh
python3 tools/local/dev.py run playground --sha 47e576d02d5542475eb4c3b092abd7e99dccf5f2
```

Close the identified Playground normally before starting another instance. Use the wrapper rather than opening its app directly: the wrapper establishes the explicit profile and native MCP identity. After resetting or reinstalling FoxPilot, restore Playground's `[8091]` port list before test website automation. Run native Marionette probes sequentially; separate simultaneous clients can disrupt the single automation session.

Check the loopback fixture's `/health` response before repeating a website probe after a long pause. Its server process can stop while browser tabs retain the original HTTP URL. Firefox may then report a misleading host-permission error when FoxPilot tries to inject into the error document. Restart the owned fixture and verify the actual page; changing extension permissions is not a remedy for a refused HTTP connection.

The default rollback now points to the most recent working fork, source `4a2e584bfb591f134f81d183adcc3bf483476ef8`, and its immediately pre-update personal profile/registries. Backup `2026-10-08T08-36-14.517769_00-00-f7eca68c` passed full integrity/signature verification and a guarded rollback preview before the updated main app started. The original official-release backup `2026-10-08T05-58-32.696876_00-00-287e3d1f` is also retained and verified.

After closing daily Zen normally, inspect the rollback scope:

```sh
python3 tools/local/dev.py rollback --backup 2026-10-08T08-36-14.517769_00-00-f7eca68c
```

Follow [the guarded rollback procedure](../DEVELOPMENT.md#rollback) before adding `--apply`. If the personal profile has evolved, the command requires `--restore-profile-snapshot` after reviewing the receipt; it preserves the current app/profile in another backup first. A rollback was previewed and verified, not performed against the newly installed daily app.

Machine-local receipts remain ignored under `.zen-local/`: `builds/47e576d02d5542475eb4c3b092abd7e99dccf5f2/build.json`, both artifact manifests, `compatibility/47e576d02d5542475eb4c3b092abd7e99dccf5f2.json`, `page-translation-live.json`, `icon-identity-after.json`, `separated-routing-live.json`, `identity-runtime-probe.json`, `identity-playground-restart.json`, `identity-native-live.txt`, `enpass-variant-native-status.json`, `ordinary-mcp-main-stopped.json`, `identity-main-post-install.json` and `identity-rollback-preview.json`.
