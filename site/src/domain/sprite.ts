// A port of Sources/TomariCore/Sprites/Sprite.swift, so the site draws the overlay's own creatures.
import type { CharacterTemplate } from "./characters.ts";

/** "#rrggbb" */
export type Hex = string;
/** SPRITE_SIZE rows of SPRITE_SIZE cells, null where empty. */
export type Pixels = (Hex | null)[][];

export type Mood = "idle" | "working" | "alert" | "asking" | "compacting" | "error" | "sleeping" | "finished";

/** A 16×16 character plus room above and to the right for its marks. */
export const SPRITE_SIZE = 24;

const BODY_X = 4;
const BODY_Y = 6;
const Z_SPOTS: readonly [number, number][] = [[15, 5], [18, 2], [20, 0]];

const COLORS = {
  bang: "#ffd23f",
  question: "#ffffff",
  cross: "#ff4d4d",
  z: "#c8d0dc",
  dotOn: "#ffffff",
  dotOff: "#4a4f5a",
  face: "#16171c",
  pink: "#ff8fb1",
  white: "#ffffff",
  check: "#4cd964",
  eye: "#111216",
} as const;

const GLYPHS = {
  bang: ["X", "X", "X", ".", "X"],
  question: ["XXX", "..X", ".XX", "...", ".X."],
  cross: ["X.X", ".X.", "X.X"],
  z: ["XXXX", "..X.", ".X..", "XXXX"],
  dot: ["X"],
  check: [".....X", "....XX", "X..XX.", "XXXX..", ".XX..."],
} as const;

type EyeStyle = "open" | "closed" | "squint";
interface Mark {
  glyph: keyof typeof GLYPHS;
  x: number;
  y: number;
  color: Hex;
}
interface Pose {
  dx: number;
  dy: number;
  eyes: EyeStyle;
  walk: boolean;
  marks: Mark[];
}

export function rgbOf(hex: Hex): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function hexOf(rgb: readonly number[]): Hex {
  return `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Mixed toward black (amount < 0) or white (amount > 0); |amount| is 0…1. */
export function shaded(hex: Hex, amount: number): Hex {
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return hexOf(rgbOf(hex).map((v) => Math.round(v + (target - v) * t)));
}

function cycle<T>(values: readonly T[], frame: number): T {
  return values[((frame % values.length) + values.length) % values.length]!;
}

const blink = (frame: number): EyeStyle => cycle<EyeStyle>(["closed", ...Array<EyeStyle>(15).fill("open")], frame);

function pose(mood: Mood, frame: number): Pose {
  const p: Pose = { dx: 0, dy: 0, eyes: "open", walk: false, marks: [] };
  switch (mood) {
    case "idle":
      p.eyes = blink(frame);
      break;
    case "working": {
      p.dy = cycle([0, -1, -2, -1], frame);
      p.walk = cycle([false, true], frame);
      const raised = cycle([0, 1, 2], frame);
      p.marks = [0, 1, 2].map((i) => ({ glyph: "dot", x: 17 + i * 2, y: i === raised ? 3 : 4, color: COLORS.dotOn }));
      break;
    }
    case "alert":
      p.dy = cycle([0, -2, -3, -2], frame);
      p.marks = cycle<Mark[]>([[{ glyph: "bang", x: 21, y: 0, color: COLORS.bang }], []], frame);
      break;
    case "asking":
      p.dy = cycle([0, 0, -1, -1], frame);
      p.marks = [{ glyph: "question", x: 19, y: 0, color: COLORS.question }];
      break;
    case "compacting": {
      p.dy = cycle([0, 1], frame);
      p.eyes = "squint";
      const lit = cycle([0, 1, 2], frame);
      p.marks = [0, 1, 2].map((i) => ({ glyph: "dot", x: 17 + i * 2, y: 3, color: i === lit ? COLORS.dotOn : COLORS.dotOff }));
      break;
    }
    case "error":
      p.dx = cycle([-1, 1, -1, 0, 0, 0, 0, 0], frame);
      p.eyes = "squint";
      p.marks = [{ glyph: "cross", x: 19, y: 1, color: COLORS.cross }];
      break;
    case "finished":
      p.eyes = blink(frame);
      p.marks = [{ glyph: "check", x: 17, y: 0, color: COLORS.check }];
      break;
    case "sleeping": {
      const count = cycle([1, 1, 2, 2, 3, 3, 0, 0], frame);
      p.eyes = "closed";
      p.marks = Z_SPOTS.slice(0, count).map(([x, y]) => ({ glyph: "z", x, y, color: COLORS.z }));
      break;
    }
  }
  return p;
}

function eyeCells(style: EyeStyle, mirrored: boolean): [number, number][] {
  if (style === "closed") return [[0, 1], [1, 1]];
  if (style === "squint") return mirrored ? [[1, 0], [0, 1]] : [[0, 0], [1, 1]];
  return [[0, 0], [1, 0], [0, 1], [1, 1]];
}

function bodyRows(character: CharacterTemplate, walking: boolean): readonly string[] {
  const { walk } = character;
  if (!walking || !walk) return character.body;
  return character.body.map((line, y) => (y >= walk.row && y < walk.row + walk.rows.length ? walk.rows[y - walk.row]! : line));
}

/** One frame of a character in a mood. Frames advance four times a second, as in the overlay. */
export function spriteFrame(character: CharacterTemplate, color: Hex, mood: Mood, frame: number): Pixels {
  const p = pose(mood, frame);
  const cells: Record<string, Hex> = { B: color, D: shaded(color, -0.35), L: shaded(color, 0.35), F: COLORS.face, P: COLORS.pink, W: COLORS.white };
  const pixels: Pixels = Array.from({ length: SPRITE_SIZE }, () => Array<Hex | null>(SPRITE_SIZE).fill(null));
  const set = (x: number, y: number, c: Hex) => {
    if (x >= 0 && x < SPRITE_SIZE && y >= 0 && y < SPRITE_SIZE) pixels[y]![x] = c;
  };

  const ox = BODY_X + p.dx;
  const oy = BODY_Y + p.dy;
  bodyRows(character, p.walk).forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const c = cells[cell];
      if (c) set(ox + x, oy + y, c);
    });
  });

  const eye = character.eyeColor ?? COLORS.eye;
  for (const [ex, mirrored] of [[character.eyes.left, false], [character.eyes.right, true]] as const) {
    for (const [dx, dy] of eyeCells(p.eyes, mirrored)) set(ox + ex + dx, oy + character.eyes.y + dy, eye);
  }

  for (const mark of p.marks) {
    GLYPHS[mark.glyph].forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell === "X") set(mark.x + x, mark.y + y, mark.color);
      });
    });
  }
  return pixels;
}

/** Rings the painted pixels in a one-pixel line, black as the overlay draws attention, by default. */
export function outlined(pixels: Pixels, color: Hex = "#000000"): Pixels {
  const filled = (x: number, y: number) => pixels[y]?.[x] != null;
  return pixels.map((row, y) =>
    row.map((c, x) => (c == null && (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) ? color : c)),
  );
}

export function grayscaled(pixels: Pixels): Pixels {
  return pixels.map((row) =>
    row.map((c) => {
      if (c == null) return c;
      const [r, g, b] = rgbOf(c);
      const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      return hexOf([luma, luma, luma]);
    }),
  );
}

/** The sprite row a resting creature stands on, to seat it on something. */
export function feetRow(character: CharacterTemplate): number {
  const pixels = spriteFrame(character, "#000000", "idle", 1);
  return pixels.findLastIndex((row) => row.some((c) => c != null));
}
