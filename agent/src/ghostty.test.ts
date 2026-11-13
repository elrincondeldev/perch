import { describe, expect, test } from "bun:test";
import { followGhosttyFocus } from "./ghostty-focus.ts";
import { parseProcessTable, parseWatcherLine, sessionOnTty, ttyChain, WATCHER_MARKER, watcherScript } from "./ghostty.ts";

const A = "0603472f-b7c5-4dae-b7a1-142468264b30";
const B = "34446bd8-9f71-4831-9f0b-d6094803dee2";

// launchd → Ghostty → login → zsh → claude (A) on ttys000;
// Ghostty → login → zsh → nvim on ttys005 → zsh → claude (B) on nvim's ttys009.
const PS = `
    1     0 ??
  500     1 ??
  600   500 ttys000
  601   600 ttys000
  602   601 ttys000
  700   500 ttys005
  701   700 ttys005
  702   701 ttys005
  703   702 ttys009
  704   703 ttys009
`;
const table = parseProcessTable(PS);

describe("process table and ttys", () => {
  test("parses ps output, with no tty for ??", () => {
    expect(table.get(602)).toEqual({ ppid: 601, tty: "/dev/ttys000" });
    expect(table.get(500)).toEqual({ ppid: 1, tty: null });
    expect(table.size).toBe(10);
  });

  test("the chain lists the process's tty, then its ancestors', nearest first", () => {
    expect(ttyChain(602, table)).toEqual(["/dev/ttys000"]);
    expect(ttyChain(704, table)).toEqual(["/dev/ttys009", "/dev/ttys005"]);
    expect(ttyChain(9999, table)).toEqual([]);
  });

  test("a cycle in the table doesn't loop forever", () => {
    expect(ttyChain(10, parseProcessTable("10 11 ttys001\n11 10 ttys002"))).toEqual(["/dev/ttys001", "/dev/ttys002"]);
  });

  test("a panel's tty finds the session on it, even inside another program", () => {
    const sessions = [
      { id: A, pid: 602 },
      { id: B, pid: 704 },
    ];
    expect(sessionOnTty("/dev/ttys000", sessions, table)).toBe(A);
    expect(sessionOnTty("/dev/ttys005", sessions, table)).toBe(B);
    expect(sessionOnTty("/dev/ttys042", sessions, table)).toBeNull();
  });
});

describe("focus watcher script", () => {
  test("reports a tty, no panel, or nothing for other lines", () => {
    expect(parseWatcherLine("tty:/dev/ttys004")).toBe("/dev/ttys004");
    expect(parseWatcherLine("tty:")).toBeNull();
    expect(parseWatcherLine("execution error: Ghostty got an error (-1743)")).toBeUndefined();
  });

  test("checks that Ghostty runs before asking it, stops with its agent, and carries a marker to find it by", () => {
    const script = watcherScript(2);
    expect(script).toContain(WATCHER_MARKER);
    expect(script).toContain("if (ghostty.running())");
    expect(script).toContain("while ($.getppid() === agent)");
    expect(script).toContain("delay(2)");
  });
});

describe("followGhosttyFocus", () => {
  function setup(processes: { id: string; pid: number }[]) {
    const focused: (string | null)[] = [];
    let report: (tty: string | null) => void = () => {};
    let stopped = false;
    const stop = followGhosttyFocus(
      { setFocused: (id) => void focused.push(id), processes: () => processes },
      {
        watch: (onTty) => {
          report = onTty;
          return () => (stopped = true);
        },
        table: async () => table,
        recheckMs: 20,
      },
    );
    return { focused, report: (tty: string | null) => report(tty), stop, stopped: () => stopped };
  }

  test("the panel in front becomes the focused session; no panel means none", async () => {
    const { focused, report, stop, stopped } = setup([{ id: A, pid: 602 }]);
    report("/dev/ttys000");
    await Bun.sleep(5);
    report(null);
    await Bun.sleep(5);
    report("/dev/ttys042");
    await Bun.sleep(5);
    expect(focused.slice(0, 3)).toEqual([A, null, null]);
    stop();
    expect(stopped()).toBe(true);
  });

  test("a session that starts in the panel already in front is picked up", async () => {
    const processes: { id: string; pid: number }[] = [];
    const { focused, report, stop } = setup(processes);
    report("/dev/ttys005");
    await Bun.sleep(5);
    expect(focused.at(-1)).toBeNull();
    processes.push({ id: B, pid: 704 });
    await Bun.sleep(40);
    expect(focused.at(-1)).toBe(B);
    stop();
  });
});
