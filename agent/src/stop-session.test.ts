import { expect, test } from "bun:test";
import { stopSession } from "./stop-session.ts";

const ID = "0603472f-b7c5-4dae-b7a1-142468264b30";

test("stops a background session by its short id", async () => {
  const ran: string[][] = [];
  const result = await stopSession(ID, async (command) => {
    ran.push(command);
    return { ok: true, command };
  });
  expect(ran).toEqual([["claude", "stop", "0603472f"]]);
  expect(result.ok).toBe(true);
});

test("a failing command comes back as an error", async () => {
  const result = await stopSession(ID, async () => ({ ok: false, error: "claude exited with 1" }));
  expect(result).toEqual({ ok: false, error: "claude exited with 1" });
});

test("refuses something that is not a session id", async () => {
  const ran: string[][] = [];
  const result = await stopSession("--all", async (command) => (ran.push(command), { ok: true, command }));
  expect(result).toEqual({ ok: false, error: "invalid session id" });
  expect(ran).toEqual([]);
});
