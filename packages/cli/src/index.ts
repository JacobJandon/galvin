#!/usr/bin/env node
/**
 * Galvin CLI
 *
 * Creator-facing CLI for interacting with Galvin.
 * Usage: galvin-cli <command> [args]
 */

const args = process.argv.slice(2);
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case "status":
      await import("./commands/status.js");
      break;
    case "logs":
      await import("./commands/logs.js");
      break;
    case "fund":
      await import("./commands/fund.js");
      break;
    case "send":
      await import("./commands/send.js");
      break;
    default:
      console.log(`
Galvin CLI - Creator Tools

Usage:
  galvin-cli status              Show Galvin status
  galvin-cli logs [--tail N]     View Galvin logs
  galvin-cli fund <amount> [--to 0x...]  Transfer Conway credits
  galvin-cli send <to-address> <message> Send a social message
`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
