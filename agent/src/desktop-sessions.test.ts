import { expect, test } from "bun:test";
import { desktopProbe, desktopSessionsLister } from "./desktop-sessions.ts";

test("the desktop app's presence is checked at most once per interval", () => {
  let now = 0;
  let present = false;
  let checks = 0;
  const probe = desktopProbe({
    ttlMs: 1000,
    now: () => now,
    exists: () => {
      checks++;
      return present;
    },
  });
  expect(probe()).toBe(false);
  present = true; // the app gets installed
  now = 999;
  expect(probe()).toBe(false);
  expect(checks).toBe(1);
  now = 1000;
  expect(probe()).toBe(true);
  expect(checks).toBe(2);
});

test("without the desktop app the sessions are not even listed", async () => {
  let listed = 0;
  const list = async () => {
    listed++;
    return [];
  };
  expect(await desktopSessionsLister(() => false, list)()).toEqual([]);
  expect(listed).toBe(0);
  await desktopSessionsLister(() => true, list)();
  expect(listed).toBe(1);
});
