# Tomari

<p align="center">
  <img src="images/creatures.gif" alt="Eight pixel-art creatures, one per session state: working, needs permission, asking you, compacting, done, asleep, error and closed" width="100%">
</p>

A floating strip on the edge of your Mac's screen with one animated pixel-art creature per Claude Code session. Each creature shows what its session is doing, and the ones waiting for you are hard to miss. Click a creature and its session opens in the Claude desktop app.

> **Not an official Anthropic project.** It is not affiliated with or endorsed by Anthropic. "Claude" is a trademark of Anthropic, PBC.

> **Early development.** Expect rough edges. macOS 14 or newer only.

## Install

```bash
npx tomari setup
```

That's all: the strip appears on the right edge with a **+** to pin your sessions, and it comes back at every login. Setup:

- copies Tomari's binaries into `~/Library/Application Support/tomari/bin`;
- adds hooks to `~/.claude/settings.json`, after backing it up, so Claude Code reports each event to Tomari's agent;
- starts the agent and the strip now and at every login, as LaunchAgents;
- replaces [claude-panel](https://github.com/elrincondeldev/claude-panel)'s agent if you have it, keeping its pinned sessions and their looks;
- moves an install from when Tomari was called Perch (`@elrincondeldev/perch`) into Tomari's places, keeping its pins, icons and token.

```bash
npx tomari status             # what's installed and running
npx tomari uninstall          # remove everything; asks before deleting pins and icons
```

You need the Claude desktop app (sessions in its Code tab), the Claude Code CLI 2.1.285 or newer, and Node.js 18 or newer for `npx`.

## Features

- **The sessions you choose**: the **+** at the end of the strip lists every session in the Claude desktop app, recent or old, running or stopped, plus the running sessions Tomari sees in your terminals; pick one to pin it. Its last item, **New Terminal tab**, opens a plain shell in Terminal.app, without Claude: a tab of the front window when macOS is set to prefer tabs, a new window otherwise. Sessions you haven't pinned show up only while they work or wait for you, and for five minutes after they finish, so a fresh install starts with just the +.
- **One creature per session**, animated by its state: working, needs permission, asking you, compacting, done, error or closed. Finished sessions fall asleep after five minutes.
- **Hard to miss when it needs you**: a permission request blinks the creature's tile in orange; a question rings it in orange. A working creature hops with typing dots over its head, and one that finished its turn holds up a green check, ringed in green, until you reply or it falls asleep.
- **Hover** for the session's name and status, e.g. `Bash: npm test` or `done · 5m`.
- **Click** to open the session in the Claude desktop app, even one the app has stopped. A session running in Terminal.app brings its tab to the front instead. Without the desktop app, a closed session resumes with `claude --resume` in a new Terminal tab, in the folder where it ran. The session in front is ringed in white.
- **Which session is in front**: while Terminal is in front, the selected Terminal tab decides; while the Claude desktop app is in front, the session it shows does; with any other app in front the ring stays where it was. The first time Terminal is in front, macOS asks to let Tomari control Terminal, which it uses to read which tab is selected; Tomari doesn't ask Terminal anything while another app is in front.
- **Background sessions** (`claude --bg`) run in a terminal the Claude daemon owns, so clicking one attaches it with `claude attach` in a new Terminal tab. Right-click one and choose **Stop session** to run `claude stop` (it asks first if the session is busy); the conversation is kept.
- **Right-click** (or control-click) to pin or unpin the session, open its folder in Finder (shown only while the folder exists) and pick its character and color.
- **Sound when done**: off by default; turn it on from the menu bar icon to hear a short chime when a session finishes working. It stays quiet for the session you are looking at in Terminal.
- **Stays out of the way**: the strip floats over every Space and full-screen app and never takes focus from the app you're using. The arrow tab beside it slides the strip off the edge, leaving just the tab, which blinks orange when a session needs you; click it again to bring the strip back.
- **Menu bar item** to show or hide the strip, move it to the left or right edge, and see how many sessions are waiting for you. Quit Tomari there; it starts again at your next login.

## How it works

```
Claude Code ─ hooks ─▶ tomari agent ◀─ WebSocket (127.0.0.1:7778, token) ─ tomari-overlay ─ menu bar
claude agents ─ poll ─▶  └ SQLite: pins, icons
```

- **`tomari`** (`agent/`, Bun and TypeScript compiled into one binary) holds the CLI and the agent. The agent tracks every session's state from Claude Code hooks and `claude agents --json`, keeps pins and icons in SQLite, and opens sessions in the desktop app. It listens on 127.0.0.1 only.
- **`tomari-overlay`** (`Sources/`, Swift) is a native AppKit and Core Animation app that runs as an accessory: no Dock icon, just the strip and a menu bar item. It costs about 0.5 % of one CPU core and 13 MB of memory while it animates.
- **`shared/protocol.ts`** is the contract between them.

| What the agent reads from Claude | Used for | Documented? |
|---|---|---|
| Hooks in `~/.claude/settings.json` | Instant state changes | Yes |
| `claude agents --json` | Names, who is alive, corrections for missed hooks | Yes |
| `claude --desktop --resume <id>` | Opening a session the desktop app doesn't know; without the app, `claude --resume <id>` in a new Terminal tab | Yes |
| `claude://code/continue?session=local_…` | Opening any desktop-app session, running or stopped | No |
| `~/Library/Application Support/Claude/claude-code-sessions/` | The app's sessions, and their `local_…` ids | No |
| `setFocusedSession` in `~/Library/Logs/Claude/main.log` | Which session is in front | No |

If a Claude update breaks an undocumented source, only the feature it feeds stops working.

## Customizing the creatures

The characters are 16×16 text templates in [`Sources/TomariCore/Resources/characters.json`](Sources/TomariCore/Resources/characters.json):

| Field | Meaning |
|---|---|
| `body` | 16 rows of 16 cells: `B` body (the session's color), `D` darker, `L` lighter, `F` face plate, `P` pink, `W` white, `.` empty |
| `walk` | Optional rows that replace the body from `row` down on alternate frames while the session works |
| `eyes` | Top-left corners of the two 2×2 eyes, which blink, close and squint on their own |
| `eyeColor` | Optional `#rrggbb` |

After editing, check the templates with `swift run TomariCoreTests` and rebuild.

## Development

You need the Command Line Tools for Xcode (`xcode-select --install`) and [Bun](https://bun.sh) 1.3 or newer.

```bash
(cd agent && bun install)
bun test agent npm             # agent, CLI and npm launcher
swift run TomariCoreTests       # protocol, session list, status rules, sprites and layout
swift build                    # debug overlay: .build/debug/tomari-overlay
bun scripts/release.ts --arch arm64      # npm packages in dist/npm
dist/npm/tomari-darwin-arm64/bin/tomari setup   # install that build
```

The Command Line Tools for Xcode 15 ship without XCTest, so the Swift tests are a plain executable that exits non-zero when a check fails.

Pushing a `v*` tag runs `.github/workflows/release.yml`: it tests, builds for Apple Silicon and Intel, publishes the three npm packages through npm's Trusted Publishing, with no token, and attaches the binaries to a GitHub release. Pull requests that touch what ships run the same build without publishing.

The landing page is an Astro site in `site/`. It draws the creatures from the same `characters.json`, through a TypeScript port of the overlay's sprite renderer in `site/src/domain`.

```bash
cd site && bun install
bun run dev                    # http://localhost:4321
bun test                       # the sprite port and the page's other pure logic
bun run build                  # type-checks, then builds into site/dist
```

On Vercel, import the repository and set its Root Directory to `site`; Vercel detects Astro and builds it with Bun.

## Privacy

- Everything stays on your Mac: the overlay only talks to the agent on 127.0.0.1, and the agent only listens there. No telemetry.
- The WebSocket needs the pairing token in `~/Library/Application Support/tomari/config.json`, and accepts only `open`, `pin`, `icon`, `stop`, `library`, `terminal` and `frontApp` (which of Terminal, the Claude desktop app or another app is in front, nothing more), with validated arguments.
- Tomari keeps its data in `~/Library/Application Support/tomari/`, its logs in `~/Library/Logs/tomari/`, and the strip's edge in the `com.elrincondeldev.tomari` defaults.
- When several untitled sessions share a folder name, the strip tells them apart with the first 24 characters of each one's first prompt. It is kept in memory only, never written to disk, but it is visible on screen like the hover label below.
- The hover label can show tool details such as a shell command, so anyone who can see your screen can read them.

## Roadmap

- Homebrew: `brew install elrincondeldev/tap/tomari`, from the same release binaries.
- Drag the strip to any edge, global shortcuts to open sessions, and notifications when a session needs you.

## License

[MIT](LICENSE)
