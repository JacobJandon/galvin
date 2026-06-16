import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ConsoleChannel,
  FileChannel,
  WebhookChannel,
  ChannelRegistry,
  buildChannelRegistry,
} from "../../channels/channel.js";

const files: string[] = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `chan-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  files.push(f);
  return f;
};
afterEach(() => {
  for (const f of files) try { fs.rmSync(f); } catch { /* ignore */ }
});

describe("FileChannel", () => {
  it("appends a JSON line per message", async () => {
    const f = tmp();
    const ch = new FileChannel(f);
    expect(ch.isConfigured()).toBe(true);
    await ch.send({ title: "T", body: "hello", level: "alert" });
    await ch.send({ body: "second" });
    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).body).toBe("hello");
    expect(JSON.parse(lines[0]).level).toBe("alert");
    expect(JSON.parse(lines[1]).body).toBe("second");
  });

  it("is unconfigured with an empty path", () => {
    expect(new FileChannel("").isConfigured()).toBe(false);
  });
});

describe("WebhookChannel", () => {
  it("formats payloads per platform", () => {
    const msg = { title: "Earned", body: "$50" };
    expect(new WebhookChannel("https://x", "discord").buildPayload(msg)).toEqual({ content: "**Earned**\n$50" });
    expect(new WebhookChannel("https://x", "slack").buildPayload(msg)).toEqual({ text: "**Earned**\n$50" });
    expect(new WebhookChannel("https://x", "generic").buildPayload(msg)).toMatchObject({ title: "Earned", body: "$50" });
  });

  it("isConfigured only for http(s) urls", () => {
    expect(new WebhookChannel("https://hooks.example/x").isConfigured()).toBe(true);
    expect(new WebhookChannel("").isConfigured()).toBe(false);
    expect(new WebhookChannel("not-a-url").isConfigured()).toBe(false);
  });
});

describe("ChannelRegistry", () => {
  it("broadcasts to configured channels and skips unconfigured ones", async () => {
    const f = tmp();
    const reg = new ChannelRegistry()
      .register(new ConsoleChannel())
      .register(new FileChannel(f))
      .register(new WebhookChannel("")); // unconfigured → skipped
    expect(reg.configured().map((c) => c.kind).sort()).toEqual(["console", "file"]);
    const results = await reg.broadcast({ body: "hi" });
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results).toHaveLength(2);
    expect(fs.readFileSync(f, "utf8")).toContain("hi");
  });

  it("broadcast never throws; reports per-channel errors", async () => {
    const reg = new ChannelRegistry().register(
      // a channel that claims configured but throws on send
      { id: "boom", kind: "x", isConfigured: () => true, send: async () => { throw new Error("nope"); } },
    );
    const results = await reg.broadcast({ body: "x" });
    expect(results[0]).toMatchObject({ id: "boom", ok: false, error: "nope" });
  });

  it("buildChannelRegistry: console always on + file/webhook from config", () => {
    const f = tmp();
    const reg = buildChannelRegistry([
      { type: "file", path: f },
      { type: "webhook", url: "https://hooks.example/x", format: "slack" },
    ]);
    expect(reg.list().map((c) => c.kind).sort()).toEqual(["console", "file", "webhook"]);
  });
});
