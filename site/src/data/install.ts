/** What `tomari setup` prints, as in agent/src/install.ts. */
export const installOutput: readonly { tone: "ok" | "dim"; text: string }[] = [
  { tone: "ok", text: "Tomari is installed and running." },
  { tone: "dim", text: "  binaries : ~/Library/Application Support/tomari/bin" },
  { tone: "dim", text: "  data     : ~/Library/Application Support/tomari" },
  { tone: "dim", text: "  logs     : ~/Library/Logs/tomari" },
  { tone: "dim", text: "  hooks    : added to ~/.claude/settings.json" },
];

/** HTML: may hold <code>. */
export const requirements: readonly string[] = [
  "macOS 14 or newer",
  "The Claude desktop app, with sessions in its Code tab",
  "Claude Code CLI 2.1.285 or newer",
  "Node.js 18 or newer, for <code>npx</code>",
];

export const commands: readonly { command: string; does: string }[] = [
  { command: "npx tomari status", does: "What's installed and running" },
  { command: "npx tomari uninstall", does: "Removes everything; asks before deleting your pins" },
];
