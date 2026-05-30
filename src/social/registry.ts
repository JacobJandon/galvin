/**
 * Social Channel Registry
 *
 * Typed registry of available social adapters (channel platforms).
 * Adapted from the ocbot desktop channels/registry.ts pattern.
 *
 * Add new adapters here; index.ts selects from this map by config.socialAdapter.
 */

import type { SocialClientInterface } from "../types.js";

export type SocialAdapterName = "conway" | "telegram" | "terminal";

export interface SocialAdapterFactory {
  name: SocialAdapterName;
  description: string;
  /**
   * Create the adapter. Returns null if required config is missing (non-fatal;
   * the runtime continues without a social adapter).
   */
  create(config: SocialAdapterConfig): Promise<SocialClientInterface | null>;
}

export interface SocialAdapterConfig {
  // Conway relay
  socialRelayUrl?: string;
  walletAccount?: import("viem").PrivateKeyAccount;
  rawDb?: import("better-sqlite3").Database;
  // Telegram
  telegramBotToken?: string;
  telegramCreatorChatId?: string;
}

/**
 * All registered social adapter factories.
 * Order matters: the first matching factory for a given name is used.
 */
export const SOCIAL_ADAPTER_REGISTRY: SocialAdapterFactory[] = [
  {
    name: "conway",
    description: "Conway social relay (signed messages via HTTPS relay)",
    async create(cfg) {
      if (!cfg.socialRelayUrl || !cfg.walletAccount) return null;
      const { createSocialClient } = await import("./client.js");
      return createSocialClient(cfg.socialRelayUrl, cfg.walletAccount, cfg.rawDb);
    },
  },
  {
    name: "telegram",
    description: "Telegram bot adapter (grammY)",
    async create(cfg) {
      if (!cfg.telegramBotToken || !cfg.telegramCreatorChatId) return null;
      const { createTelegramClient } = await import("./telegram.js");
      return createTelegramClient(cfg.telegramBotToken, cfg.telegramCreatorChatId);
    },
  },
  {
    name: "terminal",
    description: "Terminal stdin/stdout adapter (local interactive chat)",
    async create(_cfg) {
      const { createTerminalClient } = await import("./terminal.js");
      return createTerminalClient();
    },
  },
];

/**
 * Resolve and instantiate a social adapter by name.
 * Returns null silently if the adapter is not registered or config is missing.
 */
export async function createSocialAdapter(
  name: SocialAdapterName | string | undefined,
  config: SocialAdapterConfig,
): Promise<SocialClientInterface | null> {
  if (!name) return null;
  const factory = SOCIAL_ADAPTER_REGISTRY.find((f) => f.name === name);
  if (!factory) return null;
  return factory.create(config);
}
