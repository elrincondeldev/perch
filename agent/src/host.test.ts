import { expect, test } from "bun:test";
import type { SessionHostId } from "../../shared/protocol.ts";
import { HostSwitch, parseHost, type SessionHost } from "./host.ts";

function fakes() {
  const log: string[] = [];
  const host = (id: SessionHostId, reopensUnderNewId: boolean): SessionHost => ({
    id,
    reopensUnderNewId,
    sessions: async () => [],
    open: async () => ({ focused: true }),
    followFocus: () => {
      log.push(`${id}: watching`);
      return () => log.push(`${id}: stopped`);
    },
    library: async () => [],
    adopt: async () => {},
  });
  const hub = {
    focused: "someone" as string | null,
    sameNames: null as boolean | null,
    setFocused(id: string | null) {
      this.focused = id;
    },
    replaceSameNames(on: boolean) {
      this.sameNames = on;
    },
  };
  const saved: SessionHostId[] = [];
  const hosts = { desktop: host("desktop", false), ghostty: host("ghostty", true) };
  return { log, hub, saved, hosts, save: async (id: SessionHostId) => void saved.push(id) };
}

test("the names people type and the ids in config.json both name a host", () => {
  expect(parseHost("app")).toBe("desktop");
  expect(parseHost("desktop")).toBe("desktop");
  expect(parseHost("ghostty")).toBe("ghostty");
  expect(parseHost("iterm")).toBeNull();
  expect(parseHost(undefined)).toBeNull();
});

test("starts with the configured host: its focus watcher runs and the hub follows its identity rule", () => {
  const { log, hub, hosts, save } = fakes();
  const hostSwitch = new HostSwitch(hosts, "ghostty", hub, save);
  expect(hostSwitch.current.id).toBe("ghostty");
  expect(log).toEqual(["ghostty: watching"]);
  expect(hub.sameNames).toBe(true);
});

test("switching stops the old watcher, starts the new one, clears the focus, saves and announces", async () => {
  const { log, hub, hosts, saved, save } = fakes();
  const hostSwitch = new HostSwitch(hosts, "ghostty", hub, save);
  const heard: SessionHostId[] = [];
  hostSwitch.subscribe((id) => heard.push(id));

  expect(await hostSwitch.use("desktop")).toBe(true);
  expect(hostSwitch.current.id).toBe("desktop");
  expect(log).toEqual(["ghostty: watching", "ghostty: stopped", "desktop: watching"]);
  expect(hub.focused).toBeNull();
  expect(hub.sameNames).toBe(false);
  expect(saved).toEqual(["desktop"]);
  expect(heard).toEqual(["desktop"]);
});

test("choosing the host already in use does nothing", async () => {
  const { log, hub, hosts, saved, save } = fakes();
  const hostSwitch = new HostSwitch(hosts, "desktop", hub, save);
  expect(await hostSwitch.use("desktop")).toBe(false);
  expect(log).toEqual(["desktop: watching"]);
  expect(hub.focused).toBe("someone");
  expect(saved).toEqual([]);
});

test("stop ends the current watcher", async () => {
  const { log, hub, hosts, save } = fakes();
  const hostSwitch = new HostSwitch(hosts, "desktop", hub, save);
  await hostSwitch.use("ghostty");
  hostSwitch.stop();
  expect(log.at(-1)).toBe("ghostty: stopped");
});
