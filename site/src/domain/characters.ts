import templates from "../../../Sources/TomariCore/Resources/characters.json";

/** A 16×16 creature, read from the templates the overlay ships (see CharacterTemplate.swift). */
export interface CharacterTemplate {
  id: string;
  label: string;
  /** 16 rows of 16 cells: B body, D darker, L lighter, F face plate, P pink, W white, "." empty. */
  body: string[];
  /** Rows that replace the body from `row` down on alternate frames while working. */
  walk?: { row: number; rows: string[] };
  /** Top-left corners of the two 2×2 eyes. */
  eyes: { y: number; left: number; right: number };
  eyeColor?: string;
}

export type CharacterId = string;

/** The default comes first. */
export const characters: readonly CharacterTemplate[] = templates as CharacterTemplate[];

const byId = new Map(characters.map((c) => [c.id, c]));

export function characterNamed(id: CharacterId): CharacterTemplate {
  return byId.get(id) ?? characters[0]!;
}

/** The colors a session can wear; mirrors SessionIcon.palette in Sources/TomariCore/Protocol.swift. */
export const palette = [
  { name: "Orange", color: "#ff6b1a" },
  { name: "Clay", color: "#d97757" },
  { name: "Yellow", color: "#ffd23f" },
  { name: "Green", color: "#4cd964" },
  { name: "Cyan", color: "#3ccfe6" },
  { name: "Blue", color: "#4f7cff" },
  { name: "Purple", color: "#a66cff" },
  { name: "Pink", color: "#ff5fa2" },
  { name: "White", color: "#e8e8e8" },
] as const;

export const defaultIcon = { character: "default", color: "#d97757" } as const;
