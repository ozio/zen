# Development, playground and installation

This is the local workflow for the personal [`ozio/zen`](https://github.com/ozio/zen) fork. It keeps the daily Zen installation separate from experiments and uses the existing `dev` branch. The initial source baseline is `f6a167d80b62a50c0ef5b9eedfb3bb777e0372f4`, Zen `1.23.1b` on Firefox `157.0.1`. This stamp identifies the starting point; it is not a claim that a source build or compatibility test has passed.

Use [AGENTS.md](AGENTS.md) for repository rules, [UPSTREAM.md](UPSTREAM.md) for periodic updates and [PR_WORKFLOW.md](PR_WORKFLOW.md) for external candidates. The command implementation and its `--help` output are authoritative for available flags; keep these instructions synchronized when changing that interface.

The completed first native setup and exact tested/installed package are recorded in [docs/macos-validation.md](docs/macos-validation.md). Its scope notes distinguish actual macOS runtime results, accepted plugin checks and untested Linux/Windows recipes.

## Before building

Run from the repository root:

```sh
git status --short
git branch --show-current
git rev-parse HEAD
git remote -v
python tools/local/dev.py doctor --json
```

Use the repository's Node 22, Python 3.11 and Rust 1.95.0 pins in `.nvmrc`, `.python-version` and `.rust-toolchain`. Select versions locally, with an existing version manager or command-scoped environment. For example, an existing nvm installation can use `nvm use`; the development wrapper selects the Rust pin for its child commands. The `.rust-toolchain` filename is a wrapper input, not rustup's automatic `rust-toolchain` override. Installing a missing Rust version with `rustup toolchain install 1.95.0` does not require changing the global default. Avoid `rustup default`, global Node aliases, system Python replacement and shell configuration edits.

When `python` points elsewhere, invoke `python3.11 tools/local/dev.py ...`. A Python pin is documentation for version managers, not a promise that every shell automatically honors it. Check `doctor` before bootstrap and keep compiler/SDK versions in the build receipt.

Use a clean candidate worktree if current tracked changes are unrelated. Do not discard or automatically stash them. Keep `origin` as the existing fork and `upstream` as Zen's repository; verify any mismatch before a fetch or push.

### Managed toolchain layout

The wrapper deliberately reads a managed Node installation instead of whichever `node` is globally on PATH. Its default root is `.zen-local/toolchains`; `--toolchains PATH` can select an existing managed root. On Unix, `node/bin/node` and the installation's `lib/node_modules/npm/bin/npm-cli.js` must be present. Windows uses `node/node.exe` with its bundled npm directory. A symlink to a complete trusted Node installation is allowed; linking only the executable loses npm.

For a machine with nvm already initialized and Node 22 installed, this prepares the input without changing a global alias:

```sh
nvm use
node --version
mkdir -p .zen-local/toolchains
ln -s "${NVM_BIN%/bin}" .zen-local/toolchains/node
```

Do not replace an existing `node` entry blindly; inspect its target and version first. If Node 22 is missing, install a complete official Node 22 distribution into that layout or link an existing version-manager installation. Verify the archive against the official checksums before extracting it; see the [Node 22 distribution directory](https://nodejs.org/dist/latest-v22.x/). A Windows ZIP's inner installation directory must become `.zen-local/toolchains/node`, not another nested `node-v...` directory.

The wrapper accepts managed Python links under `python/bin/python3` or `python/bin/python` on Unix (`python/python.exe` on Windows), or discovers an existing uv-managed Python 3.11. Rust can use an existing rustup proxy on PATH. These preparation commands install repository versions without changing defaults:

```sh
uv python install 3.11
uv python find --managed-python 3.11
rustup toolchain install 1.95.0 --profile minimal --no-self-update
python3.11 tools/local/dev.py doctor --json
```

Use the exact interpreter path printed by uv when `python3.11` is not on PATH. Do not use `uv python install --default`. The wrapper passes `RUSTUP_TOOLCHAIN=1.95.0` and the selected paths to its child processes. Shared toolchain directories are inputs, while npm/uv/sccache and engine-bootstrap state remain inside the selected checkout's `.zen-local/`.

## Native platform prerequisites

The first validation target is native macOS ARM64. The recipes below define how to prepare other systems; their existence is not build or runtime evidence. Consult the official [Zen build guide](https://docs.zen-browser.app/contribute/desktop/building) and the platform's Firefox guide after an engine upgrade, because host/compiler requirements change.

| Host | Preparation | Evidence required before claiming support |
|---|---|---|
| macOS ARM64 | Compatible macOS, selected Xcode/Command Line Tools and SDK, GNU tar (`gtar`), pinned tools, `sccache` when available | Native full build; fresh-profile and standalone-package run on that Mac; Enpass and browser/native MCP checks |
| Linux x86_64 or ARM64 | Supported 64-bit distribution, native filesystem, Python/venv development support, Git, make and dependencies supplied by the engine bootstrap | Build and clean-profile run on the claimed distro/architecture; extension/native-app/session checks; display system recorded |
| Windows x64 or ARM64 | MozillaBuild shell, Visual Studio C++ workload and matching Windows SDK, 7-Zip and Node/Rust on PATH; short source path without spaces | Native build and packaged executable run on the claimed architecture; extensions, real local Enpass connection and session checks |

### macOS

Use the selected development tools already present on the machine. Inspect their paths before making any system selection change:

```sh
xcode-select -p
xcrun --find clang
xcrun --show-sdk-path
brew install gnu-tar
gtar --version
df -h .
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

The [Mozilla macOS guide](https://firefox-source-docs.mozilla.org/setup/macos_build.html) calls for at least 30 GB of free disk and current development tools. That minimum does not budget for several engine trees, object directories, standalone packages and backups; measure available space for this operation. Start with a bounded job count and increase only after observing memory pressure and disk use. Do not infer an available-space figure from an older session.

Surfer requires GNU tar (`gtar`) for the source archive on macOS; Apple's BSD tar is not a substitute for that prerequisite. Install it before download/bootstrap. Do not extract an unrelated Firefox version to work around a missing tool.

Development signing and notarization are separate from successful compilation. Record the package's actual signature and launch behavior. Features such as passkeys can depend on signing identity. Do not copy release signing credentials into the checkout or claim official notarization for a local package. See Mozilla's [signing guidance](https://firefox-source-docs.mozilla.org/setup/macos_build.html#signing) for an actual signing failure.

### Linux

Use a native Linux filesystem rather than a source tree on NTFS or a network mount. Prepare the basic host dependencies through the supported distribution's package manager; for example, on Ubuntu/Debian:

```sh
sudo apt update
sudo apt install curl git make python3 python3-venv python3-dev
```

Select the repository's Python 3.11, Node 22 and Rust 1.95.0 locally, then use the same root commands:

```sh
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

Do not assume the distro's `python3` is Python 3.11. Let the engine bootstrap supply its supported compiler and remaining packages. Record Wayland/X11 and desktop environment for UI results. Use the [Mozilla Linux guide](https://firefox-source-docs.mozilla.org/setup/linux_build.html) to resolve host dependency errors. Do not reuse a macOS native messaging path or declare an ARM64 result from an x86_64 test.

### Windows

Install MozillaBuild, Visual Studio's Desktop development with C++ workload and Windows SDK, and 7-Zip. Put required tools on the current build shell's PATH. Open `C:\mozilla-build\start-shell.bat` and keep the checkout in a short path without spaces, such as `C:\src\zen`. Use the pinned Python explicitly if MozillaBuild provides another version. Windows ARM64 must use a native ARM64 Python when the engine requires it. These details are described by the [Mozilla Windows guide](https://firefox-source-docs.mozilla.org/setup/windows_build.html).

From the MozillaBuild shell in that checkout:

```sh
python tools/local/dev.py doctor --json
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
python tools/local/dev.py run playground
```

Read the engine's current toolchain requirements instead of substituting a Visual Studio version from an old CI recipe. Investigate missing/quarantined files before restoring source; preserve unrelated changes. A build through WSL produces a Linux target unless explicitly configured otherwise, and cannot stand in for Windows runtime validation.

## Bootstrap and build

```sh
python tools/local/dev.py bootstrap
python tools/local/dev.py build --jobs 8
```

The wrapper installs locked npm dependencies, verifies/downloads the selected source archive, runs the pinned interpreter's `mach --no-interactive bootstrap --application-choice=browser`, imports Zen and overlays the checked-in en-US browser locale files into this engine. `bootstrap --skip-engine` installs npm dependencies only; `bootstrap --skip-system-bootstrap` avoids the native dependency bootstrap while still preparing/importing the engine. Use these only when those prerequisites are already present, and record the choice. Do not use them to hide a failed setup.

Do not invoke `scripts/download-language-packs.sh` as a generic setup step: its current upstream implementation changes global Git configuration and removes home-level tool directories. The local wrapper uses a scoped en-US copy instead. For a deliberate manual refresh of the checked-in en-US overlay, inspect [scripts/copy_language_pack.py](scripts/copy_language_pack.py) and run `python3.11 scripts/copy_language_pack.py en-US` from this checkout only. Additional locales need a reviewed, scoped recipe before claiming their support.

The local configuration in [tools/local/build.py](tools/local/build.py) adds `ac_add_options --disable-updater` to the effective generated `engine/mozconfig`. The managed root `mozconfig` also includes it; an existing custom root config is preserved. Recheck the effective configuration and packaged browser's update behavior after merges/restarts so an upstream automatic update cannot overwrite the fork. A playground profile preference alone does not protect the daily installation. Do not edit the official update hostname merely to make a local test appear isolated.

The wrapper's `--jobs N` bounds compilation parallelism through the effective make flags. It uses `sccache` when an executable is available, including a bootstrapped copy, with `SCCACHE_CACHE_SIZE=4G` and its cache under `.zen-local/cache/sccache`. The supported configuration also uses it for Rust through `RUSTC_WRAPPER`. Check its actual use; do not assume a downloaded compiler is a compilation cache. Logs and cache state remain local.

`build` normally requires 15 GiB free. For a prepared engine with only UI, test, documentation or local-tooling changes, `build --jobs 8 --disk-reserve-gib 4` explicitly lowers the reserve while still running the full CLI build. The wrapper requires clean committed source and a successful full-build baseline with the same host, native object tree, toolchain and effective configuration; it rejects new native patches, preference/build/version/dependency changes or missing baseline objects. The selected reserve and baseline are recorded in the build receipt. This option does not make a new engine or changed native inputs fit into 4 GiB; first/native-change builds retain the normal reserve. Keep additional room for packages and backups.

After a matching full build, compatible JavaScript/CSS/XHTML-only work can use:

```sh
python tools/local/dev.py build --ui
```

Changes to Gecko, native code, Rust, IDL, generated build inputs, Firefox version or toolchain require a full build. If the engine requests a clobber, stop the playground and remove only the relevant generated object directory through the engine's supported operation. Preserve the candidate package, profile and rollback files. Do not respond to a build failure by resetting the entire repository.

Canonical work belongs in `src/`, `prefs/`, `configs/` and the declared patch sources. For a deliberate Firefox edit made in `engine/`, inspect `npm run export -- --help`, export the specific path, review the tracked patch, then import and rebuild. Never count an unexported engine edit as a delivered fix. Re-import can refresh generated service data; inspect resulting tracked changes rather than blindly committing them.

Surfer links existing overlay files on macOS/Linux and normally copies them on Windows. A changed `.patch`, preference YAML, added/deleted overlay file, or Windows overlay edit therefore needs import preparation before the build. Its patch-count warning does not compare patch contents. For an already bootstrapped engine, export any intentional engine edits, then run:

```sh
python tools/local/dev.py bootstrap --skip-system-bootstrap
git status --short
# Review and commit intentional canonical/generated changes before packaging.
python tools/local/dev.py build --jobs 8
python tools/local/dev.py package
```

Before Surfer reimports an external patch, the wrapper temporarily reverses already applied canonical patches that overlap its targets, in reverse order. This prevents a later Zen overlay from blocking the earlier patch's reverse/forward cycle on a prepared engine. Scoped source snapshots and receipts are retained under `.zen-local/import-preparation/`, and the normal import reapplies both layers. If a patch matches neither applied nor unapplied source, preparation refuses rather than discarding engine work. Changing an existing patch can still require reviewing/reversing its previously imported version first; preserve/export intended engine-only changes before doing so.

Do not re-import over unexported work. Ordinary edits to already linked UI files can use `build --ui` for a quick local iteration; the final promotable package still needs a full, usually incremental, CLI build at the committed SHA.

### macOS package signing and Enpass

The packager signs the materialized macOS app before sealing it, then runs `codesign --verify --deep --strict`. The default is a local ad hoc signature, which needs no certificate/private key and does not imply notarization or acceptance by Enpass. To use an already selected development or distribution certificate, pass its exact SHA-1 fingerprint:

```sh
python tools/local/dev.py package --signing-identity EXACT_40_CHARACTER_CERTIFICATE_FINGERPRINT
```

The signing kind and identity are recorded in the immutable artifact manifest. Repackaging the same source SHA with a different signing identity is refused; preserve the existing candidate and its evidence rather than overwriting it. Choose the intended identity before sealing a candidate. Linux/Windows packaging does not use this macOS option.

The macOS packager removes development `.purgecaches` sentinels before signing: Gecko consumes those files at startup, which otherwise breaks the sealed resource signature. Application copies and backups use `ditto --rsrc --extattr` to retain signatures stored in extended attributes on non-Mach-O helpers. File hashes alone cannot check those attributes. Signed artifacts, staged applications and restored backups therefore undergo `codesign --verify --deep --strict`; check the installed application again after normal startup. The wrapper sets `MOZ_NOSPAM=1` for build/package child processes so a desktop notification helper cannot hold a completed command open.

An initial source-built candidate on this Mac reached Enpass but received Error 403, specifically that the requesting browser was not code signed. That response proves contact with the application, but does not pass compatibility. Enpass's [official error guide](https://help.enpass.io/personal/latest/all/other-browser-error-message) also requires an Applications-folder location on macOS. Its [security whitepaper](https://dl.enpass.io/docs/whitepaper/enpass-security-whitepaper.pdf) describes certificate validation, confirmation for a signed browser outside its allowlist, and separate pairing. Test the actual signed candidate; an ad hoc seal alone is not an Enpass success receipt. Do not silently disable the shared Enpass signature-verification setting to make a test pass.

### Detached candidates and shared managed tools

`stage-pr` and `sync-upstream --stage` report the candidate worktree path and manifest. Use that worktree as the root for all of its source/build/run operations. If the primary checkout already has managed toolchains, share that directory explicitly instead of installing another copy:

```sh
python /absolute/path/to/zen/tools/local/dev.py \
  --root "$ZEN_CANDIDATE_WORKTREE" \
  --toolchains /absolute/path/to/zen/.zen-local/toolchains doctor --json
python /absolute/path/to/zen/tools/local/dev.py \
  --root "$ZEN_CANDIDATE_WORKTREE" \
  --toolchains /absolute/path/to/zen/.zen-local/toolchains bootstrap
python /absolute/path/to/zen/tools/local/dev.py \
  --root "$ZEN_CANDIDATE_WORKTREE" \
  --toolchains /absolute/path/to/zen/.zen-local/toolchains build --jobs 8
```

`--root` and `--toolchains` are global options and come before the subcommand; use the same options for `package` and `run playground`. The candidate owns its own state, cache, artifacts and `.zen-local/profiles/playground`. The original managed tools are shared without changing their contents or global defaults. Reuse only the candidate's profile across its persistence restarts, and connect its native MCP server with `--repo` pointing to that candidate root.

## Launch and reset the playground

```sh
python tools/local/dev.py run playground
python tools/local/dev.py run playground --sha FULL_SOURCE_SHA --port 2828
```

The default Marionette port is 2828; an alternate port must be in 1024–65535. Change it explicitly if occupied; do not kill the process owning an unfamiliar port. The launcher requires the verified immutable package for the selected SHA, creates `.zen-local/profiles/playground` without copying any personal data and passes an explicit profile with no-remoting options. It records the live identity in `.zen-local/state.json`. Run `package` first; it does not launch an arbitrary developer bundle from `engine/`.

On macOS the launcher automatically derives a separately signed Playground package in `.zen-local/playground-artifacts/<SHA>/`, then stages it at `/Applications/Zen Playground.app`. It uses the red [Playground icon](configs/playground-branding/zen-playground.png), bundle ID `io.ozio.zen.playground` and display name `Zen Playground`, without URL, document or browsing-activity handlers. The main package under `.zen-local/artifacts/<SHA>/` and `/Applications/Zen.app` keep their normal Zen branding and handler identity. The derivative records the exact base manifest, base and derived binary/tree digests and reuses the base package's selected signing certificate; re-signing can change the executable hash. No feature-code branding switch is needed.

`package-playground --sha FULL_SOURCE_SHA` can prepare the variant explicitly; `run playground` performs the same preparation automatically. Each variant is immutable. Icon changes require a new source commit/package rather than modifying a sealed application. The Applications copy is tied to both packages by `.zen-local/deployments/playground/<SHA>.json`; an existing unowned or modified app is refused. A stopped, owned legacy copy can migrate once after verification. Staging unregisters only the previous Playground path and registers its new identity in Launch Services; it does not change the system default browser. Use `run playground --in-artifact` to omit the Applications copy. This branding/Launch Services recipe is macOS-specific; Linux/Windows continue running their native sealed package with the explicit isolated profile and require their own desktop/installer validation.

Verify binary path, profile path, PID, source SHA and loopback transport before connecting. Check that the main browser's process and application are still unchanged. Reuse the same test profile for restarts; a fresh profile for the first run and a preserved test profile for the second run are both necessary for a persistence claim.

Firefox can leave an unlocked `.parentlock` file after a normal quit. Its filename's presence alone does not mean the profile is still in use. Let the guard verify the process and actual lock state; do not delete the file as a routine restart step or mistake it for failed persistence.

Install each extension independently in this clean profile. An official XPI downloaded for testing is acceptable; copying the personal profile's `extensions/`, storage, preferences, cookies or account data is not. Record extension names, versions, IDs and source/digests using nonsensitive metadata. Browser Sync remains signed out. Enpass can use its existing desktop application and normal local browser connection without cloning vault or browser account state.

Reset is explicit and scoped:

```sh
python tools/local/dev.py reset-playground
python tools/local/dev.py reset-playground --apply
```

First close the identified playground gracefully and verify its process has exited. Read the dry-run scope before applying. Reset never means deleting the main profile, changing `profiles.ini`, terminating main Zen or copying data into a replacement profile. Keep compatibility receipts before resetting; a reset invalidates persistence observations for the new profile.

## Native UI MCP and FoxPilot

The [playground bridge](tools/playground/README.md) provides a stdio MCP server for browser chrome through local Marionette. Start it from the repository root:

```sh
python tools/playground/server.py serve --repo "$PWD"
```

For an MCP client, supply an absolute pinned Python executable and absolute server/repository paths. A stdio launch descriptor has this shape; replace the example paths with this checkout and its interpreter:

```json
{
  "command": "/absolute/path/to/python3.11",
  "args": [
    "/absolute/path/to/zen/tools/playground/server.py",
    "serve", "--repo", "/absolute/path/to/zen"
  ]
}
```

The server uses JSON-lines MCP on stdin/stdout, with diagnostics on stderr. It offers these concrete tools:

| Tool | Use |
|---|---|
| `playground_state` | Verify instance identity and read native chrome windows, tabs and Spaces |
| `playground_inspect` | Inspect chrome DOM; optionally pass `selector`, `include_hidden` and `limit` |
| `playground_click` | Click the fresh `snapshot_id` and `handle` |
| `playground_input` | Input `text` into a fresh handle, optionally `clear`; supplied text is not echoed |
| `playground_tabs` | `open` an HTTP(S)/`about:blank` URL, or `select`/`close` a tab using fresh handles |
| `playground_spaces` | Select an existing `space_id` from the fresh snapshot and verify the active Space |
| `playground_screenshot` | Capture the actual browser chrome viewport as PNG |

Snapshots expire after 30 seconds and are consumed by one action. Refresh with `playground_inspect` before each action; do not reuse stale handles even if an element looks unchanged. Spaces creation/renaming and other settings use inspected real controls: `playground_spaces` selects an existing Space, it does not create one. The bridge has no arbitrary JavaScript evaluator or web-content control API; use FoxPilot for content.

Only one client can own a Marionette automation session at a time. Disconnect a CLI/live harness before attaching the MCP client. A one-shot `inspect` command's handles cannot be used after that process exits; interactions must use one persistent MCP session. The [bridge README](tools/playground/README.md#native-action-acceptance-recipe) provides an action/read-back sequence, and [mcp.example.json](tools/playground/mcp.example.json) is the common client configuration example.

A saved client configuration is not proof that the client loaded the server. Verify live tool discovery and tool calls in the intended client separately from the stdio harness. If project trust or client configuration prevents registration, record that integration as unverified while continuing server/playground checks.

The development launcher supplies the identity contract. The bridge checks source artifact/executable digest, exact process arguments and profile, live Marionette capabilities and the launch's `zen.playground.session_id`/marker preferences. Clients must fail closed if the binary, process, profile or live session does not match.

Read-only CLI checks and a real stdio protocol check are available:

```sh
python tools/playground/server.py check-live --repo "$PWD"
python tools/playground/server.py inspect --repo "$PWD"
mkdir -p .zen-local/receipts
python tools/playground/check_protocol.py --live \
  --screenshot .zen-local/receipts/native-chrome.png
```

The live protocol check verifies identity, native inspection and a viewport screenshot. An actual action/read-back is still required for the native UI compatibility gate. Running `check_protocol.py` without `--live` tests MCP framing and a missing-state refusal; it is not a live-browser test.

Connect only to the local playground. Chrome scripting can access privileged browser state, so never expose the transport on the network or add its launch flags to main Zen. Do not use an arbitrary PID or a reused localhost port as identity. A reconnect after restart must revalidate identity.

For a browser chrome test, take a new snapshot, select a real sidebar/settings/Spaces control from it, perform one action, wait for its observable result, and take a second snapshot and viewport screenshot. Verify `[ZEN PLAYGROUND]` in the actual browser and native window titles; a stored title-modifier property alone is insufficient on Firefox 157. Use browser UI rather than setting the underlying database to make the screenshot look correct. Record the operation and result without private URLs.

FoxPilot handles web content through its extension/MCP. Install it afresh in the playground and verify which browser it controls before testing. Open a synthetic page, read content/snapshot, click or enter a harmless test value, and verify the page result. Do not count working FoxPilot in the daily browser as the playground result. Preserve other tabs and close only the temporary verification tabs after capturing results.

For ordinary user website requests, running Zen/FoxPilot remains the default described in [AGENTS.md](AGENTS.md). Missing FoxPilot uses the internal Codex browser, then Chrome. Native desktop control is for specifically requested native UI work, not a fallback for unavailable web tools.

### Separate ordinary and Playground page MCP

The native `zen-playground` tools always control the isolated browser. Ordinary `foxpilot` webpage tools should connect only to main Zen. FoxPilot 1.0.22 does not select a browser according to the macOS default handler or window visibility: a sole connected extension is an implicit target, and an explicit selection is shared by clients of that broker.

Keep main FoxPilot's complete WebSocket port list `[8089]` and the Playground extension's list `[8091]`. Use the supported extension options **WebSocket Ports → Save Ports** (trusted click), then verify the displayed list after the extension reloads. Do not give Playground both ports. Resolve its options URL from its own active `WebExtensionPolicy` after a reset; never borrow main's profile storage. Register `foxpilot-playground` with the same FoxPilot server entry point and `EXTENSION_PORT=8091`; keep ordinary `foxpilot` on `8089`. The [routing audit](docs/foxpilot-routing-audit.md) provides source evidence and the full configuration. [Official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describes stdio server and environment registration.

After resetting/reinstalling the extension, configure the Playground port again before webpage automation. Saving configuration is not connection proof: check each broker roster, correlate the dedicated driver with the verified native Playground and a synthetic page, and repeat after browser/client restart. Ordinary must have no Playground driver even when main is stopped. Close only temporary verification tabs. These checks are separate from opening a system link with Playground hidden; check the actual application path chosen by Launch Services, not only the shared default handler ID.

## Russian page translation

The page context menu offers **Перевести на русский**, then **Показать оригинал** for an active translation. It calls Firefox's native full-page translation actor with a fixed `ru` target, including when English is a preferred language. Firefox handles its local model download and translation; restoring the original uses its native page reload. The selected-text translation command remains separate. Internal pages, PDFs, unsupported languages and text-input/link/image contexts follow the capability/page-menu restrictions.

Canonical implementation: [ZenPageTranslations.sys.mjs](src/browser/components/translations/content/ZenPageTranslations.sys.mjs), with the context-menu and translation-jar patches under `src/browser/`. Re-import after patch/new-file changes and perform the committed full build before promotion. State tests and wiring checks do not prove that a native model actually translated a page:

```sh
node --test tests/translations/page-translation.test.mjs
node tests/translations/check-wiring.mjs
python tools/compatibility/probe_server.py --port 8765
```

In the identified Playground, open `http://127.0.0.1:8765/translation`, right-click its text, inspect the actual page menu, click the Russian command, and verify Russian text in the document. Reopen the menu, click **Показать оригинал**, and compare the full original text before and after reload. Keep model-loading/error checks distinct from a successful translation, and leave personal pages out of diagnostic output.

## Compatibility gates

All checks apply to the exact source SHA, package digest and host being promoted. Keep the underlying machine-local receipts in `.zen-local/`; the report must distinguish passed, failed and not run. Synthetic sites and values should be used for cookie/session/native-app demonstrations. Never record a personal cookie value, password or vault entry.

The repository includes a [loopback fixture](tools/compatibility/probe_server.py) and [guarded probes](tools/compatibility/probe.py). Its `/pip` page generates an animated local video for [PiP gesture validation](docs/pip-trackpad.md). Start the fixture in a separate terminal, install the separately sourced package bytes listed in `.zen-local/extensions/inventory.json`, and run the seed check in the verified playground:

```sh
python tools/compatibility/probe_server.py --port 8765
# Another terminal, with the packaged Playground already running:
python tools/compatibility/probe.py install-extensions
python tools/compatibility/probe.py seed
# Quit only Playground normally and relaunch with tools/local/dev.py.
python tools/compatibility/probe.py persistence
python tools/compatibility/probe.py extensions
```

The inventory lists extension IDs, versions, absolute package paths and SHA256 digests, with `packages_only: true` and `copied_profile_data: false`. It contains no extension storage. The fixture initially sets a synthetic cookie with Max-Age and replaces the tab URL with `/`, which never sets that cookie; reloading after restart cannot recreate a missing cookie and disguise a persistence failure. These probes produce observations only. They do not write the final compatibility pass receipt, prove Enpass pairing, or substitute for functional extension, Spaces and MCP checks.

| Gate | Procedure and decisive evidence |
|---|---|
| Identity | Record build source SHA, dirty state/configuration, platform, architecture, compiler/SDK, binary/package digest and live profile/PID. A version label alone is insufficient. |
| Clean profile | Prove the first profile was newly created in `.zen-local/profiles/playground`, Sync is signed out and extensions were installed separately. No personal profile was imported. |
| Browser startup | Launch the source-built browser; inspect the real UI and expected version. Check a synthetic web page and diagnostics for startup/runtime failures. |
| Native UI MCP | Connect to the verified instance, snapshot chrome, change an actual settings/sidebar/Spaces control, and read back the effect with a viewport screenshot. Revalidate after restart. |
| FoxPilot | Fresh extension controls the identified playground; content read, snapshot, navigation and a harmless action succeed with a verified page state. |
| Extensions | Every required extension is present and usable in the fresh profile. Close and reopen the same profile and verify it remains installed and functions. Include version/source metadata. |
| Enpass native application | Fresh Enpass extension exchanges a request/valid response with the actual desktop application via its real local protocol. Record extension/desktop versions and a redacted connection/status result; a manifest, process or socket alone does not pass. |
| Cookie persistence | A controlled HTTP page sets a non-session cookie with an explicit expiry/Max-Age. Confirm it, quit gracefully, verify process exit, relaunch the same profile and confirm the cookie in the same origin/container. Record synthetic value and expiry, not personal cookies. |
| Tabs and Spaces | Create two named test Spaces with synthetic tabs, include a pinned/essential tab and a normal tab, switch Spaces and confirm isolation/order/selection. Close and restart, then verify labels, membership, pinned state, URLs, ordering and expected active Space. |
| Session restore | Set the intended restore behavior using real UI; gracefully quit, verify exit and reopen the same test profile. Read the actual restored session, including the prior Spaces test. Do not replace session files to manufacture a pass. |
| Updater protection | Confirm the compiled local build has updater protection and the packaged application cannot silently replace itself from the official channel; recheck after restart. |
| Standalone package | Launch the extracted package from outside the build/object tree with the playground profile and repeat startup, extensions/native-app connection, persistence and MCP checks as relevant. Detect external symlinks or dependencies on the development tree. |

Cookie tests must use a normal, persistent browsing context. A private tab, a session-only cookie or a different container on the second launch cannot demonstrate durable cookies. Preserve the controlled server origin and port across restarts. Report whether normal quitting, crash recovery or both were tested; they exercise different paths.

Enpass is an integration, not a checkbox in the add-on list. Inspect the fresh extension's background connection and determine its actual local integration path without dumping payloads. On the initial Mac, Enpass uses a direct browser-to-application local connection; absence of an Enpass NativeMessagingHosts manifest is not a failure. If the tested extension instead uses WebExtensions native messaging, check its host registration and allowed extension identity as required by the [Mozilla native messaging contract](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging). Use Enpass's observed protocol, not a guessed message to an executable or socket. A valid locked/unlocked status reply can prove transport; desktop pairing, unlock and a dummy autofill workflow need their own evidence. Keep any real vault unlock interaction out of logs and screenshots. If an additional user action is necessary, state the specific blocked operation without weakening the gate.

Functional tests supplement these gates. Inspect the existing `src/zen/tests/` directories and relevant feature tests before choosing a path. After a test-capable build/import, the upstream runner supports scoped tests:

```sh
npm run lint
npm test -- split_view
```

Choose `split_view` only for that feature; use the actual relevant directory for another change, such as `spaces`. `npm test -- all` runs a broader suite. These direct npm commands require the same selected Python/Node and command-scoped Rust pin as the wrapper; for Rust-using commands outside the wrapper, set `RUSTUP_TOOLCHAIN=1.95.0` for the command. The existing native `npm run test:gtest` requires a configuration that builds its tests; release configurations can disable tests. Record that limitation rather than inventing a pass. Read [the test runner](scripts/run_tests.py) and current config when a command fails. Unit/control tests do not replace real native or extension checks.

## Package and promote to daily Zen

Commit the intended canonical source changes on the current branch or candidate worktree, preserving unrelated work. Produce a standalone package only after a successful full build of that exact committed SHA. `package` refuses tracked source dirt and requires the matching full-build receipt; a UI-only receipt cannot create a new promotable artifact. If a commit changes the tested source SHA after a build, perform the final full build again:

```sh
python tools/local/dev.py package
```

`package --bundle PATH` selects this checkout's built engine bundle when discovery is ambiguous; it cannot import an arbitrary external app. The wrapper calls `mach package`, materializes the developer bundle without external build symlinks, verifies the binary's `SourceStamp`, inventories/hashes its files and seals it under `.zen-local/artifacts/FULL_SOURCE_SHA/`. Its `manifest.json` records bundle/binary paths, hashes, host and build receipt. Existing artifacts are immutable and verified rather than overwritten. Verify the output and launch it independently. Mozilla describes why a developer `obj-*/dist` app is insufficient for distribution in its [macOS packaging guidance](https://firefox-source-docs.mozilla.org/setup/macos_build.html#running-outside-the-development-environment).

### Compatibility receipt for installation

After actually performing the gates, save a JSON receipt at `.zen-local/compatibility/FULL_SOURCE_SHA.json` (the default) or pass its path with `--compatibility`. The installer validates these exact fields:

| Field | Required value / source |
|---|---|
| `schema_version` | Integer `1` |
| `source_sha` | The package manifest's full source SHA |
| `artifact_manifest` | Absolute path to this root's `.zen-local/artifacts/SHA/manifest.json` |
| `binary_sha256` | Exact package manifest binary digest |
| `platform` | Exact manifest/host `system` and `machine` object |
| `profile` | Absolute path to this root's `.zen-local/profiles/playground` |
| `result` | `pass`, only when all required gates really passed |
| `verified_at` | Actual UTC time of verification in ISO 8601 form |
| `checks.standalone` | Boolean `true` after standalone startup/integration checks |
| `checks.profile_isolation` | Boolean `true` after proving clean profile origin and main separation |
| `checks.extensions` | Boolean `true` after fresh installation and persistence/function checks |
| `checks.cookies_sessions` | Boolean `true` after same-profile cookie, tabs/Spaces and restore tests |
| `checks.enpass_native_host` | Boolean `true` after an actual native-app response through Enpass's real local protocol; this field name also covers a direct local connection |

For macOS checks performed on the derived package, include `tested_playground` with its exact `artifact_manifest`, `binary_sha256`, `tree_sha256`, `base_artifact_manifest`, `base_binary_sha256` and `base_tree_sha256`. The installer verifies this binding against both sealed packages. Top-level `artifact_manifest`/`binary_sha256` still identify the main package being installed; never claim the two signed executables have the same digest. State which checks ran on the variant and which ran on the main application.

Add redacted evidence references, observed results and separate native UI MCP/FoxPilot/updater check results. The installer's identity/schema checks do not independently perform the browser tests; do not manufacture passing booleans from implementation confidence. The full gate table above remains required even where the minimum machine-readable schema combines checks. A package or profile reset/change requires reviewing which receipts have become stale.

Promotion requires authorization already present in the task or an explicit request to make this candidate the daily browser. Complete compatibility, standalone-package testing and a usable rollback first. Do not ask again when the transition is already authorized and all conditions are met.

On macOS, `/Applications/Zen.app` is the default app target. Supply the actual existing registry root and active registered profile explicitly from `profiles.ini`; keep those private paths in local receipts. The wrapper's root defaults are `~/Library/Application Support/zen` on macOS, `~/.zen` on Linux and `%APPDATA%/zen` on Windows, but verify this installation rather than guessing. An ambiguous profile requires `--profile`; external/symlinked development targets are refused.

Complete preparation first. At the authorized transition point, gracefully quit main Zen and verify it has stopped before the dry run as well as before applying; both refuse a running main app/profile. The command shape is:

```sh
python tools/local/dev.py install-main --sha FULL_SOURCE_SHA \
  --app /Applications/Zen.app \
  --profile-root "$ZEN_MAIN_PROFILE_ROOT" --profile "$ZEN_MAIN_PROFILE" \
  --compatibility "$ZEN_COMPATIBILITY_RECEIPT"
```

Read its dry-run output, then apply the same arguments with `--apply` while main Zen remains stopped. The named shell variables must be set to verified local paths; do not guess a profile from a directory listing or overwrite a running app. A playground profile cannot serve as the main backup source. If the package belongs to a detached candidate, use that candidate's `--root`/manifest and retain its package/backups before later worktree cleanup.

Before replacement, preserve the existing application bundle, the selected original profile and its `profiles.ini`/`installs.ini` registry state while the browser is stopped. Other registered profiles remain untouched. The installer captures these under `.zen-local/backups/BACKUP_ID`, verifies inventories/hashes and seals the snapshot before replacement. Absolute links or links to data outside the app/profile prevent a complete scoped backup and are refused; do not follow or remove them automatically to bypass that boundary. Record the backup ID, prior app identity/source SHA, package hash, target path and restore instructions. Keep backup permissions private. If these backups cannot be completed, do not replace the app.

The installed application must be the tested standalone candidate. Its launch must not depend on `engine/`, an object directory or a developer library path, and main Zen must start without Marionette/privileged automation flags. Check its actual identity after launch; confirm the user's existing tabs, Spaces, extensions and Enpass connection without recording their contents. Cookie/session behavior belongs to the compatibility receipt, with a scoped post-install read-back when authorized. Do not convert a main-profile migration into a playground import.

Linux and Windows require explicit application and profile targets. Inspect `install-main --help` and test backup/restore on the actual OS before using `--apply`. Portability of the Python wrapper does not establish Linux package-manager integration or Windows installer/registry behavior. Keep each platform's install evidence separate.

## Rollback

```sh
python tools/local/dev.py rollback
python tools/local/dev.py rollback --backup BACKUP_ID
python tools/local/dev.py rollback --backup BACKUP_ID --apply
```

Inspect the exact backup/target mapping, stop the affected browser gracefully and verify process exit. If the profile/registries have evolved since the original snapshot, the dry run reports `profile_changed` and `requires_restore_profile_snapshot`. Applying without the explicit restoration flag then refuses. For an authorized return to that original profile state, inspect the point in time being restored and use:

```sh
python tools/local/dev.py rollback --backup BACKUP_ID \
  --restore-profile-snapshot --apply
```

The guarded rollback first backs up the current app, profile and registries, preserving later data separately, then verifies and restores the captured original snapshot. The original backup remains immutable. Keep both backup IDs; later browsing data remains in the new backup rather than in the restored active profile. Restore the matched old app and its pre-upgrade profile backup together; newer profile migrations can be incompatible with an older browser. Never combine an arbitrary old binary with a profile already migrated by a newer version and assume safety.

After restoration, launch normal Zen without playground automation flags. Read back the application identity and check that the original profile/session and required integrations are present. Record rollback status and keep the tested good package until recovery is proven.

To examine an older source commit, use a detached candidate worktree as in [PR_WORKFLOW.md](PR_WORKFLOW.md), build it and test it in the playground. This does not rewrite the published `dev` history. Application rollback uses retained packages/backups; it does not require a rollback branch or force-push.

## Diagnose before changing more

| Symptom | Next check |
|---|---|
| Wrong profile opens | Stop only the identified candidate; inspect explicit profile/no-remoting args and state. Do not repair it by copying the daily profile. |
| Bridge cannot attach | Verify PID, binary, profile, source SHA and local port; inspect launcher/bridge logs. Treat stale state as a refusal, not a reason to attach to any Zen process. |
| Stopped profile still refuses launch/reset/install | Inspect the recorded PID/process arguments and actual lock state. An unlocked `.parentlock` may remain after normal quit and needs no routine deletion. Preserve unknown or held locks and repair the identified cause instead of bypassing the guard. |
| Enpass extension opens but does not connect | Inspect the actual local protocol, desktop application's browser-integration setting, background error and connection/pairing status. If it uses native messaging, also check host registration and extension allowlist. Confirm a real response. Do not print vault data or overwrite shared integration settings without reviewing scope. |
| Cookies vanish | Verify persistence attributes, same origin/port/container, non-private context, clear-on-exit preferences and graceful quit; check the same profile was reused. |
| Tabs/Spaces fail to return | Verify real restore setting, Space/tab membership before quit, session write completion and the reopened profile. Inspect tests before changing storage. |
| Package works only from build tree | Inspect symlinks and library resolution, recreate a standalone package and test it outside the tree. |
| Upstream merge breaks import | Inspect the canonical patch and new Firefox source side by side; resolve semantic conflicts and re-import. Preserve unrelated generated data. |
| Disk or memory pressure | Reduce jobs and inspect candidate/cache/object size. Clean only scoped disposable outputs after preserving good packages and rollback. |

Keep failures and omissions visible. A partial result should name the exact failed check, evidence and next repair; these instructions do not make an unrun check successful.
