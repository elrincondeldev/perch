import { expect, test } from "bun:test";
import { FrontApp } from "./front-app.ts";

test("the front app is unknown until an overlay reports it", () => {
  expect(new FrontApp().value).toBe("unknown");
});

test("listeners hear only real changes", () => {
  const front = new FrontApp();
  const heard: string[] = [];
  const off = front.subscribe((app) => heard.push(app));
  front.set("terminal");
  front.set("terminal");
  front.set("other");
  off();
  front.set("desktop");
  expect(heard).toEqual(["terminal", "other"]);
  expect(front.value).toBe("desktop");
});

test("Terminal is asked about only while it is in front or nobody has said what is", () => {
  const front = new FrontApp();
  expect(front.terminalMayRun()).toBe(true); // unknown: an agent without an overlay keeps polling
  front.set("terminal");
  expect(front.terminalMayRun()).toBe(true);
  front.set("other");
  expect(front.terminalMayRun()).toBe(false);
  front.set("desktop");
  expect(front.terminalMayRun()).toBe(false);
});
