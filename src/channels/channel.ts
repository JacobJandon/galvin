/**
 * Channels — pluggable outbound comms (openclaw plugin/channels pattern).
 *
 * A Channel is an adapter Galvin can send messages out on: the console, a local
 * file, or a webhook (which covers Discord, Slack, and generic endpoints — all
 * just incoming-webhook URLs). New channels are added by implementing the
 * `Channel` interface and registering it — open for extension, no arbitrary
 * code loading. The registry broadcasts to every configured channel.
 */
import fs from "fs";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("channels");

export type ChannelLevel = "info" | "warn" | "alert";

export interface ChannelMessage {
  title?: string;
  body: string;
  level?: ChannelLevel;
  meta?: Record<string, unknown>;
}

export interface Channel {
  readonly id: string;
  readonly kind: string;
  /** Whether this channel has what it needs to actually send. */
  isConfigured(): boolean;
  send(msg: ChannelMessage): Promise<void>;
}

/** Logs the message via the structured logger. Always available. */
export class ConsoleChannel implements Channel {
  readonly id = "console";
  readonly kind = "console";
  isConfigured(): boolean {
    return true;
  }
  async send(msg: ChannelMessage): Promise<void> {
    logger.info("channel_message", { title: msg.title, body: msg.body, level: msg.level ?? "info" });
  }
}

/** Appends each message as a JSON line to a file. */
export class FileChannel implements Channel {
  readonly id: string;
  readonly kind = "file";
  constructor(private readonly path: string) {
    this.id = `file:${path}`;
  }
  isConfigured(): boolean {
    return this.path.trim().length > 0;
  }
  async send(msg: ChannelMessage): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...msg }) + "\n";
    fs.appendFileSync(this.path, line, { mode: 0o600 });
  }
}

export type WebhookFormat = "generic" | "discord" | "slack";

/** POSTs the message to an incoming webhook (Discord / Slack / generic JSON). */
export class WebhookChannel implements Channel {
  readonly id: string;
  readonly kind = "webhook";
  constructor(
    private readonly url: string,
    private readonly format: WebhookFormat = "generic",
  ) {
    this.id = `webhook:${format}`;
  }
  isConfigured(): boolean {
    return /^https?:\/\//.test(this.url);
  }
  /** Build the platform-specific payload — exposed for testing without network. */
  buildPayload(msg: ChannelMessage): unknown {
    const text = (msg.title ? `**${msg.title}**\n` : "") + msg.body;
    if (this.format === "discord") return { content: text };
    if (this.format === "slack") return { text };
    return { title: msg.title, body: msg.body, level: msg.level ?? "info", meta: msg.meta };
  }
  async send(msg: ChannelMessage): Promise<void> {
    if (!this.isConfigured()) throw new Error("webhook channel has no valid url");
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.buildPayload(msg)),
    });
    if (!res.ok) throw new Error(`webhook ${this.format} returned HTTP ${res.status}`);
  }
}

export interface ChannelConfig {
  type: "console" | "file" | "webhook";
  path?: string;
  url?: string;
  format?: WebhookFormat;
}

export interface BroadcastResult {
  id: string;
  ok: boolean;
  error?: string;
}

export class ChannelRegistry {
  private readonly channels: Channel[] = [];

  register(channel: Channel): this {
    this.channels.push(channel);
    return this;
  }

  list(): Channel[] {
    return [...this.channels];
  }

  configured(): Channel[] {
    return this.channels.filter((c) => c.isConfigured());
  }

  /** Send to every configured channel. Never throws — returns per-channel results. */
  async broadcast(msg: ChannelMessage): Promise<BroadcastResult[]> {
    return Promise.all(
      this.configured().map(async (c) => {
        try {
          await c.send(msg);
          return { id: c.id, ok: true };
        } catch (e) {
          return { id: c.id, ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }
}

/** Build a registry from config. Console is always on; file/webhook added per config. */
export function buildChannelRegistry(configs: ChannelConfig[] = []): ChannelRegistry {
  const reg = new ChannelRegistry().register(new ConsoleChannel());
  for (const c of configs) {
    if (c.type === "file" && c.path) reg.register(new FileChannel(c.path));
    else if (c.type === "webhook" && c.url) reg.register(new WebhookChannel(c.url, c.format ?? "generic"));
  }
  return reg;
}
