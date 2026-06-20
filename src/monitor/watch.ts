/**
 * Live monitor — watch Galvin work in real time.
 *
 * Two real sources, no dummy data:
 *  1. The flight-recorder JSONL (~/.galvin/logs/run-*.jsonl) — the raw event
 *     stream the agent appends as it runs. We tail it for the live feed.
 *  2. The SQLite DB (inference_costs / transactions / tool_calls / turns) — the
 *     authoritative ledger (same tables --debrief reads). We poll it for totals.
 *
 * This file holds the pure, testable pieces (tail-parse, render, stat rollup).
 * The redraw loop + wallet balance live in the --watch handler in index.ts.
 */
import { isEarned, isSpent } from "../accounting/classify.js";

export interface LogEntry {
  timestamp?: string;
  level?: string;
  module?: string;
  message?: string;
  context?: Record<string, unknown>;
  error?: { message?: string; stack?: string } | string;
}

/** Parse the tail of a JSONL log into the last `maxLines` valid entries. */
export function parseTailLines(text: string, maxLines: number): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as LogEntry);
    } catch {
      /* a partially-written final line — skip it */
    }
  }
  return out.slice(-maxLines);
}

const ANSI = {
  R: "\x1b[0m",
  DIM: "\x1b[2m",
  B: "\x1b[1m",
  RED: "\x1b[31m",
  YEL: "\x1b[33m",
  G: "\x1b[32m",
  CYAN: "\x1b[36m",
  GREY: "\x1b[90m",
};

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** HH:MM:SS from an ISO timestamp (falls back to the raw string). */
export function shortTime(ts?: string): string {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return isNaN(d.getTime()) ? clip(ts, 8) : d.toTimeString().slice(0, 8);
}

/** Compact the most informative context keys into "k=v k=v" (real fields only). */
export function shortContext(ctx?: Record<string, unknown>): string {
  if (!ctx || typeof ctx !== "object") return "";
  const prefer = ["model", "name", "tool", "type", "to", "from", "hash", "amount", "amountCents", "usd", "tokens", "cost", "cents", "state", "address"];
  const keys = [...prefer.filter((k) => k in ctx), ...Object.keys(ctx).filter((k) => !prefer.includes(k))].slice(0, 4);
  const parts: string[] = [];
  for (const k of keys) {
    const v = ctx[k];
    if (v == null || typeof v === "object") continue;
    parts.push(`${k}=${clip(String(v), 28)}`);
  }
  return parts.join(" ");
}

function levelTag(level: string | undefined, color: boolean): string {
  const lv = (level ?? "info").toLowerCase();
  const label = lv.toUpperCase().padEnd(5).slice(0, 5);
  if (!color) return label;
  const c = lv === "error" ? ANSI.RED : lv === "warn" ? ANSI.YEL : lv === "debug" ? ANSI.GREY : ANSI.G;
  return `${c}${label}${ANSI.R}`;
}

/** Render one log entry as a single faithful line. */
export function renderEntry(e: LogEntry, opts: { color?: boolean } = {}): string {
  const color = opts.color !== false;
  const time = shortTime(e.timestamp);
  const lvl = levelTag(e.level, color);
  const mod = clip(e.module ?? "-", 22).padEnd(22);
  const msg = clip(e.message ?? "", 60);
  const errObj = typeof e.error === "string" ? { message: e.error } : e.error;
  const errMsg = errObj?.message ? `  ${color ? ANSI.RED : ""}✗ ${clip(errObj.message, 50)}${color ? ANSI.R : ""}` : "";
  const ctx = shortContext(e.context);
  const ctxStr = ctx ? `  ${color ? ANSI.GREY : ""}${ctx}${color ? ANSI.R : ""}` : "";
  const dimT = color ? `${ANSI.GREY}${time}${ANSI.R}` : time;
  const dimM = color ? `${ANSI.DIM}${mod}${ANSI.R}` : mod;
  return `${dimT} ${lvl} ${dimM} ${msg}${ctxStr}${errMsg}`;
}

// ─── Stats rollup from the live DB (same ledger as --debrief) ─────────────────

export interface RawDb {
  prepare(q: string): { all(): unknown[]; get(): unknown };
}

export interface LiveStats {
  turns: number;
  inference: { model: string; calls: number; tokens: number; cents: number }[];
  infCents: number;
  infCalls: number;
  transactions: { type: string; n: number; cents: number }[];
  earnedCents: number;
  spentCents: number;
  tools: { name: string; n: number; errs: number }[];
  toolCalls: number;
  toolErrs: number;
}

/** Roll the live ledger into headline numbers. Pure given a RawDb. */
export function collectStats(db: RawDb): LiveStats {
  const inference = db
    .prepare(
      "SELECT model, COUNT(*) calls, COALESCE(SUM(input_tokens),0)+COALESCE(SUM(output_tokens),0) tokens, COALESCE(SUM(cost_cents),0) cents FROM inference_costs GROUP BY model ORDER BY cents DESC",
    )
    .all() as { model: string; calls: number; tokens: number; cents: number }[];
  const transactions = db
    .prepare("SELECT type, COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM transactions GROUP BY type")
    .all() as { type: string; n: number; cents: number }[];
  const tools = db
    .prepare(
      "SELECT name, COUNT(*) n, SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) errs FROM tool_calls GROUP BY name ORDER BY n DESC",
    )
    .all() as { name: string; n: number; errs: number }[];
  const turns = ((db.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number } | undefined)?.c) ?? 0;

  const infCents = inference.reduce((s, r) => s + (r.cents || 0), 0);
  const infCalls = inference.reduce((s, r) => s + (r.calls || 0), 0);
  const earnedCents = transactions.filter((t) => isEarned(t.type)).reduce((s, t) => s + (t.cents || 0), 0);
  const spentCents = transactions.filter((t) => isSpent(t.type)).reduce((s, t) => s + (t.cents || 0), 0);
  const toolCalls = tools.reduce((s, r) => s + (r.n || 0), 0);
  const toolErrs = tools.reduce((s, r) => s + (r.errs || 0), 0);

  return { turns, inference, infCents, infCalls, transactions, earnedCents, spentCents, tools, toolCalls, toolErrs };
}

/** Is the run still active? (log file touched within `staleMs`). */
export function isActive(mtimeMs: number, now: number, staleMs = 15_000): boolean {
  return now - mtimeMs < staleMs;
}

// ─── Services Solvatron built (the earning side) ─────────────────────────────

export interface ServiceInfo {
  skillId: string;
  description?: string;
  port: number;
  priceCents: number;
  served: number;
  earnedCents: number;
  running: boolean;
  earnedUsdcTotal: number; // lifetime, from skill_income_log
}

/** Roll up the x402 services Solvatron has stood up (from the kv registry) and
 *  their lifetime earnings (from skill_income_log). Pure given a RawDb. */
export function collectServices(db: RawDb): ServiceInfo[] {
  const income: Record<string, number> = {};
  try {
    const inc = db.prepare("SELECT skill_id, COALESCE(SUM(usdc),0) total FROM skill_income_log GROUP BY skill_id").all() as { skill_id: string; total: number }[];
    for (const r of inc) income[r.skill_id] = r.total;
  } catch { /* table may be absent */ }

  const out: ServiceInfo[] = [];
  let rows: { key: string; value: string }[] = [];
  try {
    rows = db.prepare("SELECT key, value FROM kv WHERE key LIKE 'x402svc:%'").all() as { key: string; value: string }[];
  } catch { /* */ }
  for (const r of rows) {
    try {
      const s = JSON.parse(r.value) as Partial<ServiceInfo> & { skillId: string };
      out.push({
        skillId: s.skillId,
        description: s.description,
        port: Number(s.port ?? 0),
        priceCents: Number(s.priceCents ?? 0),
        served: Number(s.served ?? 0),
        earnedCents: Number(s.earnedCents ?? 0),
        running: !!s.running,
        earnedUsdcTotal: income[s.skillId] ?? 0,
      });
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => Number(b.running) - Number(a.running) || b.earnedCents - a.earnedCents);
}
