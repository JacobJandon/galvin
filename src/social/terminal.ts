/**
 * Terminal Social Adapter
 *
 * Implements SocialClientInterface using stdin/stdout so the creator can
 * chat with Galvin directly in the terminal while it runs.
 *
 * Usage:
 *   galvin --run --chat
 *
 * Or set in ~/.galvin/config.json:
 *   "socialAdapter": "terminal"
 *
 * Messages you type are queued and picked up by the heartbeat
 * `check_social_inbox` task, just like Telegram messages.
 * Galvin's replies (via send_social_message) are printed to stdout.
 */

import { createInterface, type Interface as ReadlineInterface } from "readline";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("social.terminal");

// ANSI helpers (match Galvin's index.ts palette)
const nc = process.env.GALVIN_NO_COLOR === "1";
const B   = nc ? "" : "\x1b[1m";
const R   = nc ? "" : "\x1b[0m";
const CYN = nc ? "" : "\x1b[36m";
const GRN = nc ? "" : "\x1b[32m";
const DIM = nc ? "" : "\x1b[2m";
const MAG = nc ? "" : "\x1b[35m";

const PROMPT = `${CYN}${B}you ▸${R} `;
const GALVIN_PREFIX = `${GRN}${B}galvin ▸${R} `;

export function createTerminalClient(): SocialClientInterface {
  /** Messages from the user, buffered until poll() reads them. */
  const messageQueue: InboxMessage[] = [];
  let readCursor = 0;
  let msgCounter = 0;

  let rl: ReadlineInterface | null = null;

  function ensureReadline(): void {
    if (rl) return;

    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
      terminal: true,
    });

    // Print a welcome banner
    console.log();
    console.log(`  ${MAG}${B}╭──────────────────────────────────────╮${R}`);
    console.log(`  ${MAG}${B}│${R}  ${B}Terminal Chat${R} ${DIM}— type a message below${R}  ${MAG}${B}│${R}`);
    console.log(`  ${MAG}${B}│${R}  ${DIM}Galvin reads your messages each tick${R}  ${MAG}${B}│${R}`);
    console.log(`  ${MAG}${B}│${R}  ${DIM}Press Ctrl+C to stop the agent${R}       ${MAG}${B}│${R}`);
    console.log(`  ${MAG}${B}╰──────────────────────────────────────╯${R}`);
    console.log();

    rl.on("line", (line: string) => {
      const text = line.trim();
      if (!text) {
        rl?.prompt();
        return;
      }

      msgCounter++;
      const now = new Date().toISOString();
      const inboxMsg: InboxMessage = {
        id: `terminal-${msgCounter}-${Date.now()}`,
        from: "creator",
        to: "galvin",
        content: text,
        signedAt: now,
        createdAt: now,
      };

      messageQueue.push(inboxMsg);
      logger.debug(`terminal: queued message id=${inboxMsg.id} len=${text.length}`);

      // Re-show prompt
      rl?.prompt();
    });

    rl.on("close", () => {
      logger.info("terminal: readline closed");
      rl = null;
    });

    // Show initial prompt
    rl.prompt();
  }

  // Start listening immediately
  ensureReadline();
  logger.info("terminal: chat adapter started — type messages below");

  return {
    /**
     * Called when Galvin wants to send a message (e.g. send_social_message tool).
     * Prints the reply to stdout.
     */
    async send(
      _to: string,
      content: string,
      _replyTo?: string,
    ): Promise<{ id: string }> {
      const id = `terminal-reply-${Date.now()}`;

      // Clear the current prompt line, print Galvin's message, then re-prompt
      if (rl) {
        process.stdout.write("\r\x1b[K"); // clear line
      }

      // Print each line with the Galvin prefix
      const lines = content.split("\n");
      for (const line of lines) {
        console.log(`${GALVIN_PREFIX}${line}`);
      }
      console.log(); // blank line after reply

      // Re-show prompt
      if (rl) {
        rl.prompt();
      }

      return { id };
    },

    /**
     * Return messages received since the last cursor position.
     */
    async poll(
      cursorStr?: string,
      limit = 20,
    ): Promise<{ messages: InboxMessage[]; nextCursor?: string }> {
      const from = cursorStr !== undefined ? parseInt(cursorStr, 10) : readCursor;
      const slice = messageQueue.slice(from, from + limit);
      const nextOffset = from + slice.length;
      readCursor = nextOffset;

      return {
        messages: slice,
        nextCursor: slice.length > 0 ? String(nextOffset) : undefined,
      };
    },

    /**
     * Return number of messages not yet consumed by poll().
     */
    async unreadCount(): Promise<number> {
      return Math.max(0, messageQueue.length - readCursor);
    },
  };
}
