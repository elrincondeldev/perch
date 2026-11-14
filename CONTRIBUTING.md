# Contributing to Tomari

Thanks for helping. Tomari is small on purpose: an agent in TypeScript, an overlay in Swift and a protocol between them. This guide covers how to set it up, how changes are made and how a pull request gets merged.

## Before you start

- **Bugs and small fixes:** open a pull request directly.
- **New features or behavior changes:** open an issue first, or comment on an existing one. Agreeing on the goal before the code saves both of us a rewrite.
- **Check open pull requests** for work that touches the same area. If yours overlaps another, say so in both.

## Setup

You need macOS 14 or newer, the Command Line Tools for Xcode (`xcode-select --install`) and [Bun](https://bun.sh) 1.3 or newer.

```bash
(cd agent && bun install)
swift build                    # debug overlay: .build/debug/tomari-overlay
```

To try a full build the way users get it:

```bash
bun scripts/release.ts --arch arm64              # npm packages in dist/npm (x64 on Intel)
dist/npm/tomari-darwin-arm64/bin/tomari setup    # installs that build over yours
```

`npx tomari uninstall` removes it again. See [Development](README.md#development) in the README for the site and the release workflow.

## Where things live

| Path | What it is |
|---|---|
| `agent/` | `tomari`: the CLI and the agent (Bun, TypeScript). Hooks, `claude agents` polling, SQLite, opening sessions. |
| `Sources/TomariCore/` | Pure Swift: protocol, session list, status rules, sprites, layout. Everything testable lives here. |
| `Sources/TomariOverlay/` | The AppKit app: strip, menus, menu bar. Kept thin. |
| `shared/protocol.ts` | The contract between agent and overlay. |
| `Tests/TomariCoreTests/` | Swift tests, run as an executable. |
| `npm/` | The `tomari` launcher package. |
| `site/` | The landing page (Astro). |
| `scripts/release.ts` | Builds the npm packages. |

## Making changes

### One concern per pull request

Keep each pull request to one change a reviewer can read in one sitting. A fix, a feature and a refactor are three pull requests. If a change builds on another open pull request, branch from it and say so at the top of the description, with the number of the pull request it depends on.

### Branches

Name branches `<type>/<short-slug>`, for example `feat/collapse-tab`, `fix/visible-states` or `docs/contributing`. Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `chore`, `ci`.

### Commits

Write commits in English, with [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(agent): clear a session's alert when the poll says idle
```

- Scopes: `agent`, `overlay`, `core`, `protocol`, `site`, `npm`, `ci`. Leave it out when a change spans several.
- Summary in the imperative, lowercase, no trailing period, 72 characters or fewer.
- Use the body for the why, when the diff doesn't make it obvious.
- Each commit should build and pass the tests on its own.

### Code

- **Follow the code around you.** Comments say why, not what. Names over abbreviations.
- **Logic goes where it can be tested.** In Swift, put decisions in `TomariCore` as plain types (see `DoneChime` or `StripLayout`) and keep `TomariOverlay` to wiring. In the agent, pass external effects in as options with a real default, as `startPoller`, `startServers` and `watchTerminalFocus` do.
- **Tests never touch the real system.** No real `osascript`, `claude`, `launchctl`, `~/.claude` or desktop app. Use the injectable options and temporary directories.
- **External commands get a timeout.** A hung Terminal or `claude` must not hold the agent.
- **Add tests with the change.** A bug fix comes with a test that failed before it.

### The protocol

`shared/protocol.ts` and `Sources/TomariCore/Protocol.swift` mirror each other. When you change one:

1. Change the other in the same pull request.
2. Keep it additive. New fields are optional, and Swift decodes them with `decodeIfPresent`, so an older overlay keeps working with a newer agent.
3. A new client message also goes in `agent/src/protocol-guard.ts`, with its arguments validated, and in the list of accepted messages under [Privacy](README.md#privacy) in the README.
4. Add tests on both sides: `server.test.ts` and `ProtocolTests.swift`.

### Security and privacy

These are the rules the project is built on. A pull request that breaks one won't be merged without a discussion first.

- **Everything stays on the Mac.** The agent listens on `127.0.0.1` only. No telemetry, no network calls.
- **The WebSocket requires the pairing token.** Compare it in constant time.
- **No session data in script or shell source.** AppleScript gets values only through `argv`, and shell commands are built with `quoted form of`. Never interpolate a path, title or id.
- **Prompts and transcripts stay in memory.** Nothing a user typed is written to disk.
- **Reading from Claude** is listed in the [How it works](README.md#how-it-works) table. If you add a source, add it there and say whether it is documented. An undocumented source must fail softly: only the feature it feeds stops working.

### Characters

New creatures go in `Sources/TomariCore/Resources/characters.json`. The format is in [Customizing the creatures](README.md#customizing-the-creatures). Run `swift run TomariCoreTests` to check the templates, and add a screenshot to the pull request.

## Checks

Run what CI runs before you push:

```bash
(cd agent && bun install --frozen-lockfile && bun run typecheck)
bun test agent npm
swift run TomariCoreTests
bun scripts/release.ts --arch arm64      # when you touch agent/, npm/, shared/, Sources/ or Package.swift
```

If you changed `site/`:

```bash
cd site && bun install && bun test && bun run build
```

Pull requests from forks wait for a maintainer to approve the workflow before CI runs.

If `swift run` fails with a module cache error after moving or renaming the checkout, delete `.build` and run it again.

## Pull requests

Write the title and the description in English, for a reviewer who hasn't seen the work. Everything you claim should trace back to the diff, an issue or a command you ran.

**Title:** imperative, stating the outcome, 72 characters or fewer, no trailing period. For example, `Add an arrow tab that slides the strip off the edge and back`.

**Description:** use these sections, and delete any that has nothing true to say instead of writing "N/A".

- **Summary:** one to three sentences on what changes, outcome first.
- **Why:** the problem or motivation. Link the issue.
- **Changes:** bullets grouped by area, describing behavior rather than files. Put breaking changes, protocol changes, migrations and new dependencies first, in **bold**.
- **How to test:** numbered steps a reviewer can follow, then what you ran and what you saw. List anything you didn't check under **Not verified**.
- **Screenshots:** for anything visible in the strip, menus or site.
- **Risk and rollout:** what could break, for whom, and how to roll back.
- **Reviewer notes:** where to start reading and the tricky parts.
- **Related:** `Closes #123` and linked pull requests.

A one-line fix needs only Summary and How to test.

Open the pull request as a draft while it is still in progress or a check fails. When it's ready, a maintainer reviews it. Address comments with new commits rather than force-pushes, so the review history stays readable.

### With Claude Code

This repository ships Claude Code skills in `.claude/skills`, from [elrincondeldev/skills](https://github.com/elrincondeldev/skills):

- `/create-pr` writes the title and description above from your branch, and shows them to you before opening the pull request.
- `/code-review` reviews a branch against the repository's standards and the issue it addresses.
- `/tdd` builds a feature or a fix test-first.

If an agent writes your change, you are still its author: read the diff and run the checks before asking for review.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
