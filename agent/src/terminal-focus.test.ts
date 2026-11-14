import { expect, test } from "bun:test";
import { parseTerminalOutput, sessionsInTabs, ttyResolver, watchTerminalFocus } from "./terminal-focus.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";
const B = "34446bd8-9f71-4831-9f0b-d6094803dee2";

async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await Bun.sleep(5);
  }
}

/** The tty script's answer is whatever `front.tty` holds; "" means Terminal isn't running or in front. */
function setup(overrides: Partial<Parameters<typeof watchTerminalFocus>[1]> = {}) {
  const front = { line: "/dev/ttys001" };
  const seen: (string | null)[] = [];
  const asked: string[] = [];
  const stop = watchTerminalFocus((id) => seen.push(id), {
    intervalMs: 5,
    backoffMs: 60_000,
    run: async () => front.line,
    sessionForTty: async (tty) => {
      asked.push(tty);
      return ({ "/dev/ttys001": A, "/dev/ttys002": B } as Record<string, string>)[tty] ?? null;
    },
    ...overrides,
  });
  return { front, seen, asked, stop };
}

test("the session in the front Terminal tab is focused, and only changes are reported", async () => {
  const { front, seen, stop } = setup();
  try {
    await waitFor(() => seen.length === 1);
    await Bun.sleep(40); // many more ticks, same tab
    front.line = "/dev/ttys002";
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([A, B]);
  } finally {
    stop();
  }
});

test("the last focused session stays focused while Terminal is not in front or a plain shell is", async () => {
  const { front, seen, stop } = setup();
  try {
    await waitFor(() => seen.length === 1);
    front.line = ""; // switched to another app
    await Bun.sleep(40);
    front.line = "/dev/ttys099"; // a tab with no Claude session
    await Bun.sleep(40);
    expect(seen).toEqual([A]);
    front.line = "/dev/ttys001"; // back to the same session: nothing new to report
    await Bun.sleep(40);
    expect(seen).toEqual([A]);
  } finally {
    stop();
  }
});

test("focus is cleared when the focused session ends", async () => {
  const alive = new Set([A]);
  const { front, seen, stop } = setup({ alive: (id) => alive.has(id) });
  try {
    await waitFor(() => seen.length === 1);
    front.line = "";
    alive.delete(A);
    await waitFor(() => seen.length === 2);
    await Bun.sleep(40);
    expect(seen).toEqual([A, null]);
  } finally {
    stop();
  }
});

test("returning to a tab whose session is no longer the focused one focuses it again", async () => {
  // The hub's focus can change without the watcher: opening a background session sets it directly.
  let focused: string | null = null;
  const front = { line: "/dev/ttys001" };
  const seen: (string | null)[] = [];
  const stop = watchTerminalFocus(
    (id) => {
      seen.push(id);
      focused = id;
    },
    {
      intervalMs: 5,
      run: async () => front.line,
      sessionForTty: async (tty) => ({ "/dev/ttys001": A, "/dev/ttys002": B } as Record<string, string>)[tty] ?? null,
      current: () => focused,
    },
  );
  try {
    await waitFor(() => seen.length === 1);
    focused = B; // the user clicked B in the panel; its new attach tab is not mapped to a session
    front.line = "/dev/ttys099";
    await Bun.sleep(40);
    expect(seen).toEqual([A]);
    front.line = "/dev/ttys001"; // back to tab A
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([A, A]);
  } finally {
    stop();
  }
});

test("it stays quiet while the desktop focus source is active", async () => {
  let runs = 0;
  const { seen, stop } = setup({
    enabled: () => false,
    run: async () => {
      runs++;
      return "/dev/ttys001";
    },
  });
  await Bun.sleep(40);
  stop();
  expect(runs).toBe(0);
  expect(seen).toEqual([]);
});

test("an osascript failure is logged once, then it backs off", async () => {
  let runs = 0;
  const logged: string[] = [];
  const { stop } = setup({
    run: async () => {
      runs++;
      throw new Error("osascript exited with 1");
    },
    log: (m) => logged.push(m),
  });
  await Bun.sleep(60);
  stop();
  expect(runs).toBe(1); // backoff is 60 s: no second try
  expect(logged).toHaveLength(1);
  expect(logged[0]).toContain("osascript exited with 1");
});

test("after failures it backs off 10 s, doubling up to a cap, and resets on success", async () => {
  const waits: number[] = [];
  const outcomes = [false, false, false, false, true, false];
  const { stop } = setup({
    intervalMs: 7,
    backoffMs: 10,
    maxBackoffMs: 30,
    run: async () => {
      if (outcomes.shift() === false) throw new Error("boom");
      return "/dev/ttys001";
    },
    sleep: async (ms) => {
      waits.push(ms);
      await Bun.sleep(1);
    },
    log: () => {},
  });
  await waitFor(() => waits.length >= 6);
  stop();
  expect(waits.slice(0, 6)).toEqual([10, 20, 30, 30, 7, 10]);
});

test("a tty maps to the live session on it, asking ps once per pid", async () => {
  const asked: number[] = [];
  const resolve = ttyResolver({
    pids: async () =>
      new Map([
        [A, 100],
        [B, 200], // dead: skipped
      ]),
    alive: (pid) => pid === 100,
    ttyOf: async (pid) => {
      asked.push(pid);
      return "ttys003";
    },
  });
  expect(await resolve("/dev/ttys003")).toBe(A);
  expect(await resolve("/dev/ttys003")).toBe(A);
  expect(await resolve("/dev/ttys004")).toBeNull();
  expect(asked).toEqual([100]);
});

test("a failed ps lookup is retried on the next tick", async () => {
  let fail = true;
  const resolve = ttyResolver({
    pids: async () => new Map([[A, 100]]),
    alive: () => true,
    ttyOf: async () => (fail ? undefined : "ttys003"),
  });
  expect(await resolve("/dev/ttys003")).toBeNull();
  fail = false;
  expect(await resolve("/dev/ttys003")).toBe(A);
});

test("a wake-up runs a tick at once instead of waiting out the interval", async () => {
  let wake = () => {};
  let runs = 0;
  const { stop } = setup({
    intervalMs: 60_000,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    run: async () => {
      runs++;
      return "";
    },
    wakeOn: (listener) => {
      wake = listener;
      return () => {};
    },
  });
  try {
    await waitFor(() => runs === 1);
    await Bun.sleep(20);
    expect(runs).toBe(1); // asleep until the interval
    wake();
    await waitFor(() => runs === 2);
  } finally {
    stop();
  }
});

test("a tab whose tty maps to no session falls back to its title", async () => {
  const titles: string[] = [];
  const { front, seen, stop } = setup({
    sessionForTitle: (title) => {
      titles.push(title);
      return title === "perch memory lookup" ? B : null;
    },
  });
  try {
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([A]);
    front.line = "/dev/ttys099\t◑ perch memory lookup"; // a background session's client tab
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([A, B]);
    expect(titles).toContain("perch memory lookup");
  } finally {
    stop();
  }
});

test("the tty wins over the title, and an exact or unknown title is handled", async () => {
  const asked: string[] = [];
  const { front, seen, stop } = setup({
    sessionForTitle: (title) => {
      asked.push(title);
      return title === "plain name" ? B : null;
    },
  });
  try {
    await waitFor(() => seen.length === 1);
    front.line = "/dev/ttys001\t◑ plain name"; // tty maps to A: the title is not consulted
    await Bun.sleep(40);
    expect(seen).toEqual([A]);
    expect(asked).toEqual([]);
    front.line = "/dev/ttys099\tplain name"; // no glyph: the whole title is the name
    await waitFor(() => seen.length === 2);
    front.line = "/dev/ttys099\t◑ nobody"; // matches nothing: focus stays
    await Bun.sleep(40);
    expect(seen).toEqual([A, B]);
  } finally {
    stop();
  }
});

test("the script output is the front tab, then the custom title of every tab", () => {
  expect(parseTerminalOutput("")).toEqual({ front: null, titles: [] });
  expect(parseTerminalOutput("/dev/ttys001\t◑ one\n◑ one\n\n✳ two")).toEqual({
    front: { tty: "/dev/ttys001", title: "◑ one" },
    titles: ["◑ one", "✳ two"],
  });
  expect(parseTerminalOutput("/dev/ttys001\t")).toEqual({ front: { tty: "/dev/ttys001", title: "" }, titles: [] });
  // the front tab could not be read: its line is empty, the titles still count
  expect(parseTerminalOutput("\n◑ one")).toEqual({ front: null, titles: ["◑ one"] });
});

test("tab titles are matched to background sessions with or without the status glyph", () => {
  const sessions = [
    { id: A, title: "perch work", background: true },
    { id: B, title: "other", background: true },
    { id: "c", title: null, background: true }, // untitled: never matches
    { id: "d", title: "perch work", background: false }, // not a background session: never marked
  ];
  expect([...sessionsInTabs(["◑ perch work", "plain"], sessions)]).toEqual([A]);
  expect([...sessionsInTabs(["other", ""], sessions)]).toEqual([B]);
  expect(sessionsInTabs(["", "◑ "], sessions).size).toBe(0);
});

test("every tab list is handed to onTabs, and nothing when Terminal is not in front", async () => {
  const lists: string[][] = [];
  const { front, stop } = setup({ onTabs: (titles) => lists.push(titles) });
  try {
    front.line = "/dev/ttys001\t◑ a\n◑ a\n◑ b";
    await waitFor(() => lists.some((l) => l.length === 2));
    front.line = "";
    const count = lists.length;
    await Bun.sleep(40);
    expect(lists.length).toBe(count);
    expect(lists.at(-1)).toEqual(["◑ a", "◑ b"]);
  } finally {
    stop();
  }
});
