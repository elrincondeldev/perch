/**
 * Reads a session's first real prompt back from its Claude Code transcript (JSONL), so a label survives an
 * agent restart. Only a bounded head of the file is read, and only inside ~/.claude/projects.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

const HEAD_BYTES = 256 * 1024;
const PROJECTS = join(homedir(), ".claude", "projects");
const PLAIN_ID = /^[A-Za-z0-9_-]+$/;
// Content the CLI wraps around things the user did not type: slash commands, their output, hooks, reminders.
const WRAPPED = /^<(command-[a-z]+|local-command-[a-z]+|system-reminder|user-prompt-submit-hook|bash-[a-z]+)[\s>]/;

export interface TranscriptOptions {
  /** Hook payload's `transcript_path`; preferred over searching for the file. */
  transcriptPath?: string;
  /** Folder holding the per-project transcript folders. Replaceable for tests. */
  root?: string;
  headBytes?: number;
}

/** The first prompt the user typed in this session, or null if it can't be found or read. Never throws. */
export async function firstPrompt(sessionId: string, { transcriptPath, root = PROJECTS, headBytes = HEAD_BYTES }: TranscriptOptions = {}): Promise<string | null> {
  try {
    if (!PLAIN_ID.test(sessionId)) return null;
    const path = await transcriptFile(sessionId, root, transcriptPath);
    if (!path) return null;
    const head = await Bun.file(path).slice(0, headBytes).text();
    for (const raw of head.split("\n")) {
      const text = userText(raw);
      if (text) return text;
    }
    return null;
  } catch {
    return null;
  }
}

async function transcriptFile(sessionId: string, root: string, given?: string): Promise<string | null> {
  if (given !== undefined) {
    const path = resolve(given);
    const inside = isAbsolute(given) && path.startsWith(resolve(root) + sep) && path.endsWith(".jsonl");
    if (inside && (await Bun.file(path).exists())) return path;
    // A path we won't read falls through to the search, which stays inside `root` by construction.
  }
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const path = join(root, dir.name, `${sessionId}.jsonl`);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

/** The user's own text in one transcript line, or null for anything else (or a line cut off by the size bound). */
function userText(raw: string): string | null {
  let entry: any;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null;
  }
  if (entry?.type !== "user" || entry.isMeta || entry.message?.role !== "user") return null;
  const content = entry.message.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join(" ")
        : "";
  const trimmed = text.trim();
  return trimmed && !WRAPPED.test(trimmed) ? trimmed : null;
}
