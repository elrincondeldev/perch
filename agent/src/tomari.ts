import { runAgent } from "./agent.ts";
import { parseCommand, USAGE } from "./cli.ts";
import { setup, uninstall } from "./install.ts";
import { status } from "./status.ts";

declare const TOMARI_VERSION: string | undefined;
const VERSION = typeof TOMARI_VERSION === "string" ? TOMARI_VERSION : "dev";

const command = parseCommand(process.argv.slice(2));
try {
  switch (command.name) {
    case "agent":
      await runAgent();
      break;
    case "setup":
      await setup();
      break;
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
