import { describe, expect, test } from "bun:test";
import { characterNamed } from "./characters.ts";
import { feetRow, outlined, shaded, SPRITE_SIZE, spriteFrame } from "./sprite.ts";

const critter = characterNamed("default");
const robot = characterNamed("robot");
const clay = "#d97757";
// The body's top-left corner inside the 24×24 sprite.
const ox = 4;
const oy = 6;

describe("spriteFrame", () => {
  test("places the body at its offset in a 24×24 sprite, shaded by cell", () => {
    const pixels = spriteFrame(critter, clay, "idle", 1);
    expect(pixels.length).toBe(SPRITE_SIZE);
    expect(pixels.every((row) => row.length === SPRITE_SIZE)).toBe(true);
    expect(pixels[oy + 4]![ox + 3]).toBe(clay);
    expect(pixels[oy + 10]![ox + 3]).toBe(shaded(clay, -0.35));
    expect(pixels[oy]![ox]).toBeNull();
  });

  test("W cells are white whatever the session's color", () => {
    const pou = characterNamed("pou");
    expect(pou.id).toBe("pou");
    for (const color of [clay, "#4f7cff"]) {
      expect(spriteFrame(pou, color, "idle", 1).flat()).toContain("#ffffff");
    }
  });

  test("opens 2×2 eyes and blinks them shut on the first idle frame", () => {
    const eye = "#111216";
    const { y, left } = critter.eyes;
    const open = spriteFrame(critter, clay, "idle", 1);
    expect([open[oy + y]![ox + left], open[oy + y + 1]![ox + left + 1]]).toEqual([eye, eye]);
    const shut = spriteFrame(critter, clay, "idle", 0);
    expect(shut[oy + y]![ox + left]).toBe(clay);
    expect(shut[oy + y + 1]![ox + left]).toBe(eye);
  });

  test("uses a character's own eye color", () => {
    expect(spriteFrame(robot, clay, "idle", 1)[oy + robot.eyes.y]![ox + robot.eyes.left]).toBe(robot.eyeColor!);
  });

  test("hops and swaps in the walk rows while working", () => {
    const pixels = spriteFrame(critter, clay, "working", 1);
    const walk = critter.walk!;
    for (let x = 0; x < 16; x++) {
      const expected = walk.rows[0]![x] === "D" ? shaded(clay, -0.35) : null;
      expect(pixels[oy - 1 + walk.row]![ox + x]).toBe(expected);
    }
  });

  test("adds each mood's mark", () => {
    expect(spriteFrame(critter, clay, "finished", 0)[0]![22]).toBe("#4cd964");
    expect(spriteFrame(critter, clay, "asking", 0)[0]![19]).toBe("#ffffff");
    const asleep = spriteFrame(critter, clay, "sleeping", 0);
    expect(asleep[5]![15]).toBe("#c8d0dc");
    expect(asleep[2]![18]).toBeNull();
  });
});

test("shaded mixes toward black or white", () => {
  expect(shaded("#808080", -1)).toBe("#000000");
  expect(shaded("#808080", 1)).toBe("#ffffff");
  expect(shaded("#000000", 0.5)).toBe("#808080");
});

test("outlined rings the sprite in black without touching it", () => {
  const red = "#ff0000";
  expect(outlined([[null, null, null], [null, red, null], [null, null, null]])).toEqual([
    [null, "#000000", null],
    ["#000000", red, "#000000"],
    [null, "#000000", null],
  ]);
});

test("feetRow is the lowest painted row of a resting creature", () => {
  expect(feetRow(critter)).toBe(oy + 12);
  expect(feetRow(robot)).toBe(oy + 13);
});
