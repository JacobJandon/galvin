/**
 * Telegram Social Adapter
 *
 * Implements SocialClientInterface using a Telegram bot via grammY.
 * Connects Galvin to a Telegram chat so the creator can send messages
 * and receive replies in real time.
 *
 * Setup:
 *   1. Create a bot via @BotFather: /newbot → receive token
 *   2. Start the bot, send it any message
 *   3. Get your chat ID: https://api.telegram.org/bot{TOKEN}/getUpdates
 *   4. Add to ~/.galvin/config.json:
 *        "socialAdapter": "telegram",
 *        "telegramBotToken": "1234567890:AAF...",
 *        "telegramCreatorChatId": "987654321"
 *
 * The bot long-polls Telegram's servers (no incoming port needed).
 * All send() calls deliver to the creator chat.
 * poll() returns messages received since the last cursor position.
 *
 * Note: accept messages only from the creator chat. Any other user
 * is silently ignored so random Telegram users cannot control Galvin.
 */

import { Bot } from "grammy";
import type { Context } from "grammy";
import type { SocialClientInterface, InboxMessage } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("social.telegram");

// ─── Chunk helper ─────────────────────────────────────────────────────────────

/**
 * Splits a long string into chunks no larger than `maxLen` characters.
 * Telegram's message limit is 4096 chars.
 */
function chunkText(text: string, maxLen = 4000): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks.length > 0 ? chunks : [""];
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a Telegram bot that implements SocialClientInterface.
 *
 * @param botToken     Telegram bot token from @BotFather
 * @param creatorChatId  The numeric chat ID of the authorised creator
 */
export function createTelegramClient(
  botToken: string,
  creatorChatId: string,
): SocialClientInterface {
  const bot = new Bot(botToken);

  /** Received messages buffered in memory until poll() reads them. */
  const messageQueue: InboxMessage[] = [];

  /** Index into messageQueue — tracks how many messages have been consumed. */
  let readCursor = 0;

  // ─── Receive messages ────────────────────────────────────────────────────

  bot.on("message:text", (ctx: Context) => {
    const msg = ctx.message;
    if (!msg) return;

    // Only accept messages from the authorised creator chat
    if (String(msg.chat.id) !== creatorChatId) {
      logger.warn(`telegram: ignored message from unauthorised chat ${msg.chat.id}`);
      return;
    }

    const inboxMsg: InboxMessage = {
      id: String(msg.message_id),
      from: String(msg.from?.id ?? msg.chat.id),
      to: "galvin",
      content: msg.text ?? "",
      signedAt: new Date(msg.date * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    messageQueue.push(inboxMsg);
    logger.debug(`telegram: queued message id=${inboxMsg.id} len=${inboxMsg.content.length}`);
  });

  // Gracefully log errors without crashing
  bot.catch((err) => {
    logger.warn(`telegram bot error: ${err.message ?? String(err)}`);
  });

  // Start the bot in background (long-polling, no webhook needed)
  bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`telegram bot crashed: ${message}`);
  });

  logger.info(`telegram: bot started, accepting messages from chat ${creatorChatId}`);

  // ─── SocialClientInterface implementation ────────────────────────────────

  return {
    /**
     * Send a message to the creator chat (or any numeric chatId).
     * Long messages are automatically chunked to respect Telegram's 4096-char limit.
     */
    async send(
      to: string,
      content: string,
      _replyTo?: string,
    ): Promise<{ id: string }> {
      // `to` is usually "galvin" (self-notification) or a telegram numeric chat id
      const chatId = to === "galvin" || to === "" ? creatorChatId : to;
      const chunks = chunkText(content, 4000);
      let lastId = "0";

      for (const chunk of chunks) {
        try {
          const sent = await bot.api.sendMessage(chatId, chunk, {
            parse_mode: "Markdown",
          });
          lastId = String(sent.message_id);
        } catch (err: any) {
          // Markdown may be invalid (e.g. unmatched backticks) — retry as plain text
          if (err?.description?.includes("parse")) {
            const sent = await bot.api.sendMessage(chatId, chunk);
            lastId = String(sent.message_id);
          } else {
            throw err;
          }
        }
      }

      return { id: lastId };
    },

    /**
     * Return messages received since the last cursor position.
     * The cursor is a stringified integer offset into messageQueue.
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
