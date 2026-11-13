import { copyFile } from "node:fs/promises";
import { CLAUDE_SETTINGS } from "./config.ts";
import { hasPanelHooks, mergeHooks, type Settings } from "./hooks-config.ts";
import { hasOwnStatusLine, mergeStatusLine } from "./statusline-config.ts";

async function readSettings(): Promise<Settings> {
  const file = Bun.file(CLAUDE_SETTINGS);
  return (await file.exists()) ? await file.json() : {};
}

/**
 * Adds or removes our hooks, and our statusline unless `statusline` is false, in ~/.claude/settings.json,
 * backing the file up first. False when nothing changed.
 */
export async function writeHooks({ install, statusline = true }: { install: boolean; statusline?: boolean }): Promise<boolean> {
  const exists = await Bun.file(CLAUDE_SETTINGS).exists();
  const before = await readSettings();
  const hooked = mergeHooks(before, { install });
  const after = statusline ? mergeStatusLine(hooked, { install }) : hooked;
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  if (exists) await copyFile(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.bak-tomari-${Date.now()}`);
  await Bun.write(CLAUDE_SETTINGS, JSON.stringify(after, null, 2) + "\n");
  return true;
}

export async function statuslineInstalled() {
  return hasOwnStatusLine(await readSettings());
}

export async function hooksInstalled() {
  return hasPanelHooks(await readSettings());
}
