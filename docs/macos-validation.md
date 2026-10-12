# macOS validation, 2026-10-08

Workflow note, 2026-10-12: FoxPilot has been removed by the user. Current validation uses the built-in full Zen MCP with independent main/Playground endpoints and grants. Earlier FoxPilot results below are historical evidence for their original artifacts, not a current prerequisite. See [DEVELOPMENT.md](../DEVELOPMENT.md#native-ui-and-built-in-zen-mcp).

The current installed candidate is `45b730cc0d8ea47284bd691c905a57cfd3ec5efd`, adding Library release/visibility and inactive-Space layout improvements on top of frame-coalesced Space swipes. It retains standalone packaging, built-in MCP with Codex/Claude Code setup and skills, Move Tab, automatic PiP, Tab site search, the red Playground identity, separate FoxPilot connections and Russian page translation. It is signed with Developer ID Application; notarization was declined by the user. See [the latest daily-installation checks, package root and rollback](mcp-validation.md) and [the swipe measurements and pending physical acceptance](space-swipe-performance.md). Use [MAIN_UPDATE.md](../MAIN_UPDATE.md) for routine promotion. The rest of this document records the earlier initial setup candidate and its original-release rollback.

The personal fork is [ozio/zen](https://github.com/ozio/zen), on `dev`. Its native build is installed at `/Applications/Zen.app` and uses the existing personal profile. The separate `/Applications/Zen Playground.app` runs the managed `.zen-local/profiles/playground` profile. No personal profile, cookies, account state or extension storage were imported into it.

## Exact tested candidate

| Item | Verified value |
|---|---|
| Built and packaged source | `4a2e584bfb591f134f81d183adcc3bf483476ef8` |
| Zen / Gecko | `1.23.1b` / `157.0.1` |
| Host | macOS 26.6.2, ARM64 |
| Actual compiler / SDK / deployment target | Clang 22.1.8 / MacOSX26.5.sdk / 11.0 |
| Selected repository tools | Node 22.23.3, Python 3.11.15, Rust 1.95.0 |
| Compilation cache | sccache, bounded to 4 GB |
| Signing | Existing Apple Development certificate; full deep signature verified after copying and startup; no notarization |
| Binary SHA-256 | `f4e433f12229b469d530ffc07a1314b41abb15b6077bfe082a2f01569f48513a` |
| Package tree SHA-256 | `aeca94394e5524264716e65e2335c18aaa734a5307c956e1f974771a5f6c5d15` |

The artifact is sealed at `.zen-local/artifacts/4a2e584bfb591f134f81d183adcc3bf483476ef8/`. Its manifest, full-build receipt and runtime identity identify that exact commit. Later documentation commits can advance repository HEAD; they do not change this installed binary. Build the new committed source before packaging a later candidate.

## Proven behavior and accepted scope

- A full native source build and standalone package passed. The daily app's complete file inventory matches the package after startup. It opens the original registered personal profile, without Marionette or privileged automation flags. FoxPilot observed 291 current personal tabs; their contents were not saved in the validation report.
- The same clean Playground profile retained its synthetic persistent cookie, localStorage counter `42`, four synthetic tabs, pinning and Space membership across the signed candidate update. All five independently installed signed extensions remained active: uBlock Origin, Keepa, Return YouTube Dislike, Enpass and FoxPilot.
- Native stdio MCP inspected actual chrome, opened and closed only its own verification tab, and switched/restored Spaces. Live screenshot/inspection checks passed. FoxPilot connected to the correct Playground, took a fresh synthetic-page snapshot and read back the stored counter and cookie result, then the main browser selection was restored.
- uBlock blocked an actual synthetic loopback request; Return YouTube Dislike rendered its public video integration. Keepa injected its Amazon frame, but its price chart was blocked by CAPTCHA. The user explicitly cancelled that remaining check and accepted plugin testing as complete.
- The signed Applications-folder candidate reached Enpass's actual native authentication/unlock UI, and the user confirmed Enpass works. That human acceptance is retained for the packaging-only correction. Agent-driven vault access and autofill were not tested; no vault content was copied or logged.
- Automatic browser updating is disabled in the compiled configuration. Playground update preferences are disabled and browser Sync remains signed out.
- 75 focused tests passed: 36 development-control tests and 39 native-bridge tests. The macOS regressions use real code signing to check extended attributes and consumed cache sentinels. The packaging/copy/rollback correction also received an independent source review.

Linux and Windows have portable commands and native setup recipes in [DEVELOPMENT.md](../DEVELOPMENT.md). Their builds and runtime integrations have not been run on those operating systems.

## Daily work

Use [AGENTS.md](../AGENTS.md) for agent instructions. Change canonical source, commit on `dev`, build/package the exact committed SHA, test in Playground, then promote with the guarded installation command after compatibility and any required authorization. [UPSTREAM.md](../UPSTREAM.md) describes merging upstream while retaining local changes. [PR_WORKFLOW.md](../PR_WORKFLOW.md) describes pinned external PR review, comment analysis, local repair and Playground testing. No particular external PR was supplied or applied during this setup.

On this prepared Mac, launch the current retained candidate from [the latest validation](mcp-validation.md) with:

```sh
python3.11 tools/local/dev.py \
  --root /Users/oz/Projects/Zen \
  --toolchains /Users/oz/Projects/Zen/.zen-local/toolchains \
  run playground --sha 45b730cc0d8ea47284bd691c905a57cfd3ec5efd
```

Close the existing Playground normally before restarting it. Always launch it through this command with the explicit profile. Opening `Zen Playground.app` directly from Finder/Dock invokes Firefox's ordinary default-profile selection; it does not establish the managed Playground identity. The native bridge refuses a mismatched instance rather than attaching to it. Preserve any unrelated profile such a manual launch creates.

The `zen-playground` stdio MCP is registered in the local Codex configuration. Its real protocol and native actions were verified; a new Codex session is needed for an already open chat to load the newly registered tool catalog. The command and server work independently of that catalog refresh. FoxPilot provides webpage control separately.

## Rollback and local evidence

On 11 October 2026, all retained backups were deleted at the user's explicit request, including the original official-release backup `2026-10-08T05-58-32.696876_00-00-287e3d1f` and the intermediate fork snapshots. Recovery from those app/profile/registry snapshots is unavailable. The current daily app, personal profile, clean Playground profile and candidate packages were preserved; see [the current backup status](mcp-validation.md#retained-backups).

During initial setup, the original-release copy had source stamp `f6a167d80b62a50c0ef5b9eedfb3bb777e0372f4`, a verified signature and was selected as the default rollback. Those historical checks do not establish present availability.

Machine-local evidence is ignored by Git. Primary receipts are `.zen-local/main-post-install.json`, `main-install.json`, `final-runtime-probe.json`, `final-fox-observation.json`, `final-mcp-live.txt`, and `compatibility/4a2e584bfb591f134f81d183adcc3bf483476ef8.json`. Original plugin/session observations are referenced by that compatibility receipt, with the human acceptance and cancelled Keepa check stated explicitly. Profiles, private browsing data, local logs and signing credentials are not committed.
