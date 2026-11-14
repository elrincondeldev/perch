import { expect, test } from "bun:test";
import { FocusArbiter } from "./focus-arbiter.ts";
import { FrontApp } from "./front-app.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";
const B = "34446bd8-9f71-4831-9f0b-d6094803dee2";

function setup() {
  const front = new FrontApp();
  const applied: (string | null)[] = [];
  const arbiter = new FocusArbiter(front, (id) => applied.push(id));
  return { front, applied, arbiter };
}

test("the desktop log applies directly while the desktop app is in front", () => {
  const { front, applied, arbiter } = setup();
  front.set("desktop");
  arbiter.desktop(A);
  arbiter.desktop(B);
  arbiter.desktop(null);
  expect(applied).toEqual([A, B, null]);
});

test("while Terminal is in front the desktop log is only remembered, and applied when the desktop app returns", () => {
  const { front, applied, arbiter } = setup();
  front.set("terminal");
  arbiter.desktop(A);
  arbiter.desktop(B);
  expect(applied).toEqual([]);
  front.set("desktop");
  expect(applied).toEqual([B]);
});

test("with another app in front the focus is sticky: log events are remembered, not applied", () => {
  const { front, applied, arbiter } = setup();
  front.set("other");
  arbiter.desktop(A);
  expect(applied).toEqual([]);
  front.set("terminal");
  expect(applied).toEqual([]);
  front.set("desktop");
  expect(applied).toEqual([A]);
});

test("returning to the desktop app with nothing focused there keeps the current focus", () => {
  const { front, applied, arbiter } = setup();
  front.set("other");
  arbiter.desktop(null);
  front.set("desktop");
  expect(applied).toEqual([]);
});

test("before any overlay reports, the desktop log applies as it always did", () => {
  const { applied, arbiter } = setup();
  arbiter.desktop(A);
  expect(applied).toEqual([A]);
});
