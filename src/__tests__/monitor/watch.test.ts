import { describe, it, expect } from "vitest";
import { parseTailLines, renderEntry, shortContext, shortTime, collectStats, isActive, type RawDb } from "../../monitor/watch.js";

describe("parseTailLines — tolerant JSONL tail", () => {
  it("parses valid lines, skips a partially-written final line, keeps the last N", () => {
    const text = [
      '{"timestamp":"2026-06-18T16:00:00.000Z","level":"info","module":"loop","message":"turn 1"}',
      "",
      '{"timestamp":"2026-06-18T16:00:01.000Z","level":"info","module":"loop","message":"turn 2"}',
      '{"timestamp":"2026-06-18T16:00:02.000Z","level":"error","module":"tool","message":"boom"}',
      '{"timestamp":"2026-06-18T16:00:03.000Z","level":"info","module":"loop","mess', // truncated tail
    ].join("\n");
    const out = parseTailLines(text, 2);
    expect(out).toHaveLength(2);
    expect(out[0]!.message).toBe("turn 2");
    expect(out[1]!.message).toBe("boom");
  });

  it("returns empty for blank input", () => {
    expect(parseTailLines("", 10)).toEqual([]);
    expect(parseTailLines("\n\n", 10)).toEqual([]);
  });
});

describe("renderEntry — faithful one-line render of real fields", () => {
  it("includes time, module, and message", () => {
    const ts = "2026-06-18T16:00:00.000Z";
    const localTime = new Date(ts).toTimeString().slice(0, 8); // viewer's local clock
    const line = renderEntry({ timestamp: ts, level: "info", module: "agent.loop", message: "thinking about earning" }, { color: false });
    expect(line).toContain(localTime);
    expect(line).toContain("agent.loop");
    expect(line).toContain("thinking about earning");
  });

  it("surfaces an error message", () => {
    const line = renderEntry({ level: "error", module: "tool", message: "failed", error: { message: "RPC timeout" } }, { color: false });
    expect(line).toContain("RPC timeout");
  });

  it("renders context as k=v from real keys", () => {
    expect(shortContext({ model: "claude-opus-4-8", tokens: 1234, junk: { nested: true } })).toContain("model=claude-opus-4-8");
    expect(shortContext({ model: "claude-opus-4-8", tokens: 1234 })).toContain("tokens=1234");
    expect(shortContext(undefined)).toBe("");
  });

  it("shortTime falls back gracefully on a bad timestamp", () => {
    expect(shortTime(undefined)).toBe("--:--:--");
    const ts = "2026-06-18T16:00:00.000Z";
    expect(shortTime(ts)).toBe(new Date(ts).toTimeString().slice(0, 8));
    expect(shortTime(ts)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe("collectStats — rollup from the live ledger", () => {
  // Fake the DB: route each query to canned rows by a substring match.
  const fakeDb = (rows: Record<string, unknown[]>, gets: Record<string, unknown>): RawDb => ({
    prepare(q: string) {
      return {
        all: () => {
          for (const k of Object.keys(rows)) if (q.includes(k)) return rows[k]!;
          return [];
        },
        get: () => {
          for (const k of Object.keys(gets)) if (q.includes(k)) return gets[k];
          return undefined;
        },
      };
    },
  });

  it("sums inference spend, earned (transfer_in only), tools, and turns", () => {
    const db = fakeDb(
      {
        inference_costs: [
          { model: "claude-opus-4-8", calls: 3, tokens: 9000, cents: 12 },
          { model: "local", calls: 5, tokens: 20000, cents: 0 },
        ],
        transactions: [
          { type: "transfer_in", n: 2, cents: 500 },
          { type: "inference", n: 8, cents: 12 },
        ],
        tool_calls: [
          { name: "web_search", n: 4, errs: 1 },
          { name: "send_message", n: 2, errs: 0 },
        ],
      },
      { "COUNT(*) c FROM turns": { c: 7 } },
    );
    const s = collectStats(db);
    expect(s.turns).toBe(7);
    expect(s.infCalls).toBe(8);
    expect(s.infCents).toBe(12);
    expect(s.earnedCents).toBe(500); // only transfer_in
    expect(s.spentCents).toBe(12); // everything else
    expect(s.toolCalls).toBe(6);
    expect(s.toolErrs).toBe(1);
  });

  it("handles an empty ledger (fresh wallet, no run yet)", () => {
    const s = collectStats(fakeDb({}, {}));
    expect(s.turns).toBe(0);
    expect(s.earnedCents).toBe(0);
    expect(s.inference).toEqual([]);
  });
});

describe("isActive — run liveness from log mtime", () => {
  it("is live when the log was touched within the window", () => {
    const now = 1_000_000;
    expect(isActive(now - 2_000, now)).toBe(true);
    expect(isActive(now - 60_000, now)).toBe(false);
  });
});
