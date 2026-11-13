# Tomari

A floating strip of pixel-art creatures on the edge of the macOS screen, one per Codex session; a click opens that session. Scope, requirements and open decisions live in [docs/requirements.md](docs/requirements.md). Read it before planning a feature, changing scope or choosing between options.

Tomari grows out of [Codex-panel](https://github.com/elrincondeldev/claude-panel), a Raspberry Pi version of the same idea. Its agent now lives here (`agent/`, `shared/protocol.ts`); keep the protocol compatible so the Pi panel can connect to a Tomari agent.

## Conventions

- Everything in the repo is in English: code, comments, docs, commit messages and CLI output. The user often writes in Spanish; reply in their language.
- Design follows *A Philosophy of Software Design*:
  - deep modules behind small interfaces;
  - each fact in one place (ports, paths into Codex's files, file formats);
  - errors defined out of existence wherever a sensible behaviour exists.
- Comments carry what the code can't say: an interface's meaning, units, nullability and contract, or the reason behind a non-obvious choice. Explanations meant for the user belong in the chat.
- Pure logic gets unit tests, written first (red, then green). That covers the session state machine, layout, sprite rendering and similar math.

## Layout

- `agent/`: the `tomari` binary (Bun + TypeScript, compiled with `bun build --compile`): the CLI (`setup`, `status`, `uninstall`) and the agent (`tomari agent`). `agent/src/config.ts` holds every path Tomari writes.
- `shared/protocol.ts`: the WebSocket contract; `Sources/TomariCore/Protocol.swift` mirrors it.
- `Sources/`: the overlay, `tomari-overlay`.
- `npm/tomari/`: the npm launcher; `scripts/release.ts` builds it and one binaries package per architecture into `dist/npm/`.

## Build and test

- `(cd agent && bun install)`, then `bun test agent npm` runs the agent, CLI and launcher tests.
- `swift build`, then `.build/debug/tomari-overlay` runs the strip against the installed agent; quit it from its menu bar item.
- `swift run TomariCoreTests` runs the Swift unit tests. Command Line Tools 15 ship no XCTest, so they are a plain executable that exits non-zero on failure; move them to Swift Testing once the toolchain is Swift 6.
- `TomariCore` holds the pure logic (protocol, session list, status rules, sprites, strip geometry); `TomariOverlay` holds AppKit and Core Animation only; SwiftUI stays out to keep the idle cost within NFR-1.
- The creature templates live in `Sources/TomariCore/Resources/characters.json`, the file meant to be shared with Codex-panel's Pi panel.

## Codex integration

- Several integrations are undocumented (table in docs/requirements.md §5). Each lives in a single module and degrades gracefully: if Codex changes it, only that feature disappears.
- Hooks are command hooks that pipe the event to `curl … || true`. With `"type": "http"` hooks, every session's transcript fills with errors whenever the agent is down.
- The desktop app stops the processes of idle sessions. Those sessions vanish from `Codex agents` but still exist in the app, and `claude://code/continue?session=local_…` reopens them.

## Security

- The hook server binds 127.0.0.1 only.
- The WebSocket requires the pairing token, and client messages pass a whitelist parser.
- Processes are spawned with argument arrays, never through a shell string.

## Distribution

Tomari ships through npm (`tomari`, unscoped; its binaries are `@elrincondeldev/tomari-darwin-*`), and later a Homebrew formula in `elrincondeldev/homebrew-tap`. Neither sets macOS's quarantine flag, which is what lets ad-hoc-signed binaries run without an Apple Developer account.

- npm follows esbuild's pattern: the launcher package has an optional dependency per architecture (`@elrincondeldev/tomari-darwin-arm64`, `-x64`) holding `tomari`, `tomari-overlay` and its bundle.
- `tomari setup` copies those into `~/Library/Application Support/tomari/bin`, because the npx cache is temporary, and the LaunchAgents (`com.elrincondeldev.tomari.agent`, `.overlay`) run them from there.
- A `v*` tag runs `.github/workflows/release.yml`, which publishes through npm's Trusted Publishing: each package names `elrincondeldev/tomari` and `release.yml` as its trusted publisher, so there is no token to keep.

That holds only for plain executables installed by a formula. Keep the overlay an executable that runs as an accessory app, not a `.app` bundle: an app would need a cask, and Homebrew quarantines casks.

`tomari-overlay` reads its creature templates from `Tomari_TomariCore.bundle`, which SwiftPM builds next to it. Ship and install the two side by side, or the overlay stops at launch.
