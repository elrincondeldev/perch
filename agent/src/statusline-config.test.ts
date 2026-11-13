import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { hasOwnStatusLine, mergeStatusLine, STATUSLINE_URL, unwrapStatusline, wrapStatusline } from "./statusline-config.ts";

const theirs = "~/.claude/statusline.sh";
const same = (a: unknown, b: unknown) => expect(JSON.stringify(a)).toBe(JSON.stringify(b)); // key order counts too

describe("wrapStatusline / unwrapStatusline", () => {
  test("the wrapper posts to the agent's statusline route", () => {
    expect(wrapStatusline(null)).toContain(STATUSLINE_URL);
  });

  test("unwrap gives back exactly what was wrapped, however odd", () => {
    const commands = [
      theirs,
      "jq -r '.model.display_name'",
      "echo \"a}\"\n}\n# trailing comment",
      "line one\nline two\n",
      "  padded  ",
      "printf '%s' \"$input\" | {\n}",
    ];
    for (const command of commands) expect(unwrapStatusline(wrapStatusline(command))).toBe(command);
    expect(unwrapStatusline(wrapStatusline(null))).toBeNull();
  });

  test("anything else is not ours", () => {
    for (const command of [theirs, "", undefined, 42, null, wrapStatusline("x").replace("tomari", "other")]) {
      expect(unwrapStatusline(command)).toBeUndefined();
    }
    expect(unwrapStatusline(wrapStatusline("x") + " extra")).toBeUndefined();
    expect(unwrapStatusline(wrapStatusline("x"), "http://127.0.0.1:1/other")).toBeUndefined();
  });
});

describe("mergeStatusLine", () => {
  test("with no statusline of theirs, install adds ours and keeps everything else", () => {
    const merged = mergeStatusLine({ theme: "dark", hooks: {} }, { install: true });
    expect(merged).toEqual({ theme: "dark", hooks: {}, statusLine: { type: "command", command: wrapStatusline(null) } });
  });

  test("with theirs, install wraps it and keeps its other fields", () => {
    const merged = mergeStatusLine({ statusLine: { type: "command", command: theirs, padding: 2 } }, { install: true });
    expect(merged.statusLine).toEqual({ type: "command", command: wrapStatusline(theirs), padding: 2 });
  });

  test("installing again changes nothing, so it never nests", () => {
    const once = mergeStatusLine({ statusLine: { type: "command", command: theirs } }, { install: true });
    expect(mergeStatusLine(once, { install: true })).toBe(once);
  });

  test("uninstall restores their statusline exactly, key order included", () => {
    for (const original of [
      { model: "opus", statusLine: { type: "command", command: theirs, padding: 2 }, theme: "dark" },
      { statusLine: { type: "command", command: "a\n}\nb" } },
    ]) {
      const installed = mergeStatusLine(original, { install: true });
      same(mergeStatusLine(installed, { install: false }), original);
    }
  });

  test("uninstall removes ours when they had none, then the key", () => {
    const installed = mergeStatusLine({ theme: "dark" }, { install: true });
    same(mergeStatusLine(installed, { install: false }), { theme: "dark" });
  });

  test("a blank command of theirs counts as none", () => {
    const merged = mergeStatusLine({ statusLine: { type: "command", command: "  " } }, { install: true });
    expect((merged.statusLine as { command: string }).command).toBe(wrapStatusline(null));
  });

  test("a statusline that isn't a plain command is left alone, installing and removing", () => {
    for (const statusLine of [{ type: "other", command: theirs }, { type: "command" }, { type: "command", command: 7 }, "text", null]) {
      const settings = { statusLine };
      expect(mergeStatusLine(settings, { install: true })).toBe(settings);
      expect(mergeStatusLine(settings, { install: false })).toBe(settings);
    }
  });

  test("uninstall leaves a statusline of theirs alone, and settings without one", () => {
    const withTheirs = { statusLine: { type: "command", command: theirs } };
    expect(mergeStatusLine(withTheirs, { install: false })).toBe(withTheirs);
    expect(mergeStatusLine({}, { install: false })).toEqual({});
  });
});

test("hasOwnStatusLine", () => {
  expect(hasOwnStatusLine({})).toBe(false);
  expect(hasOwnStatusLine({ statusLine: { type: "command", command: theirs } })).toBe(false);
  expect(hasOwnStatusLine(mergeStatusLine({}, { install: true }))).toBe(true);
  expect(hasOwnStatusLine(mergeStatusLine({ statusLine: { type: "command", command: theirs } }, { install: true }))).toBe(true);
});

describe("the installed command, run in a real shell", () => {
  async function run(command: string, input: string) {
    const proc = Bun.spawn(["/bin/sh", "-c", command], { stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out;
  }

  test("their command still gets the same input and its output is what Claude Code shows", async () => {
    // Port 1 refuses at once, so the forwarding step fails quietly, as it does with the agent down.
    const url = "http://127.0.0.1:1/statusline";
    expect(await run(wrapStatusline("tr a-z A-Z", url), '{"a":"b"}')).toBe('{"A":"B"}');
    expect(await run(wrapStatusline("echo one; echo two", url), "{}")).toBe("one\ntwo\n");
    expect(await run(wrapStatusline(null, url), '{"a":"b"}')).toBe("");
  });

  test.skipIf(!existsSync("/usr/bin/curl"))("and the agent receives the input untouched", async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push(await req.text());
        return new Response(null, { status: 204 });
      },
    });
    try {
      const input = '{"session_id":"x","n":1}\n';
      const out = await run(wrapStatusline("cat", `http://127.0.0.1:${server.port}/statusline`), input);
      expect(received).toEqual([input.trimEnd()]);
      expect(out).toBe(input.trimEnd());
    } finally {
      server.stop(true);
    }
  });
});
