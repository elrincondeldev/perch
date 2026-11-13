import { runAgent } from "./agent.ts";
import { parseCommand, USAGE } from "./cli.ts";
import { PANEL_PORT } from "../../shared/protocol.ts";
import { loadConfig, saveHost, savedHost } from "./config.ts";
import { askAgentToUse } from "./host.ts";
import { setup, uninstall } from "./install.ts";
import { status } from "./status.ts";

declare const TOMARI_VERSION: string | undefined;
const VERSION = typeof TOMARI_VERSION === "string" ? TOMARI_VERSION : "dev";

const command = parseCommand(process.argv.slice(2));
try {
  switch (command.name) {
    case "agent":
      await runAgent({ lan: command.lan });
      break;
    case "setup":
      await setup({ pi: command.pi, host: command.host });
      break;
    case "host": {
      if (!command.host) {
        console.log(await savedHost());
        break;
      }
      const { token } = await loadConfig();
      const live = await askAgentToUse(command.host, `ws://127.0.0.1:${PANEL_PORT}/ws?token=${token}`);
      if (!live) await saveHost(command.host);
      console.log(`host: ${command.host}${live ? " (the running agent switched)" : " (saved; the agent uses it when it starts)"}`);
      console.log("sessions already running stay where they are: the host decides where the ones you open from now on go");
      break;
    }
    case "status":
      await status(VERSION);
      break;
    case "uninstall":
      await uninstall({ purge: command.purge });
      break;
    case "version":
      console.log(VERSION);
      break;
    case "help":
      if (command.error) console.error(`tomari: ${command.error}\n`);
      console.log(USAGE);
      process.exit(command.error ? 1 : 0);
  }
} catch (error) {
  console.error(`tomari: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
