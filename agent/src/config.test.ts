import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { saveHost, savedHost, savedWorkspace } from "./config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFile(content?: object) {
  const dir = mkdtempSync(`${tmpdir()}/tomari-config-`);
  dirs.push(dir);
  const path = `${dir}/config.json`;
  if (content) writeFileSync(path, JSON.stringify(content));
  return path;
}

test("without a saved host, or with one it doesn't know, the agent uses the Claude app", async () => {
  expect(await savedHost(configFile())).toBe("desktop");
  expect(await savedHost(configFile({ token: "t" }))).toBe("desktop");
  expect(await savedHost(configFile({ token: "t", host: "iterm" }))).toBe("desktop");
  expect(await savedHost(configFile({ token: "t", host: "ghostty" }))).toBe("ghostty");
});

test("saving the host keeps the rest of the file, and keeps it private", async () => {
  const path = configFile({ token: "s3cret", workspace: "~/work" });
  await saveHost("ghostty", path);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ token: "s3cret", workspace: "~/work", host: "ghostty" });
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(await savedHost(path)).toBe("ghostty");
});

test("the workspace is optional, and may start at the home folder", async () => {
  expect(await savedWorkspace(configFile())).toBeNull();
  expect(await savedWorkspace(configFile({ token: "t" }))).toBeNull();
  expect(await savedWorkspace(configFile({ workspace: "" }))).toBeNull();
  expect(await savedWorkspace(configFile({ workspace: 42 }))).toBeNull();
  expect(await savedWorkspace(configFile({ workspace: "/Users/dev/work" }))).toBe("/Users/dev/work");
  expect(await savedWorkspace(configFile({ workspace: "~/work" }))).toBe(`${homedir()}/work`);
});
