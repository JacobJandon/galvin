/**
 * Galvin Doctor  ·  Advanced System Health Check
 *
 * Like `brew doctor` but comprehensive: 23 sections, live probes,
 * spending analysis, heartbeat health, git state, env audit, and more.
 * Every check catches its own errors — the doctor never crashes.
 */

import { existsSync, statSync, readdirSync, readFileSync, accessSync, constants as fsConstants } from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import path from "path";
import { loadConfig, resolvePath, getConfigPath } from "../config.js";
import {
  createDatabase,
  getActiveGoals,
  getReadyTasks,
  getHeartbeatSchedule,
  getUnconsumedWakeEvents,
  getUnprocessedInboxCount,
  getChildrenByStatus,
} from "../state/database.js";
import { SCHEMA_VERSION } from "../state/schema.js";
import { getGalvinDir, getWalletPath } from "../identity/wallet.js";
import { readLock, isPidAlive, probeGateway, getRunningAgent, type LockInfo } from "../gateway/lock.js";
import {
  print, gap, rule, section, boxHeader, row, hint, kv,
  OK, WARN, FAIL, SKIP, INFO,
  G, G2, GR, YEL, RED, CYN, MAG, B, R, DIM,
  fmtBytes, shortAddr, fmtDuration,
} from "./print.js";
import type { TreasuryPolicy, HeartbeatScheduleRow } from "../types.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

type Status = "pass" | "warn" | "fail" | "skip";

interface Check {
  label: string;
  status: Status;
  detail?: string;
  hints?: string[];
}

interface SectionTiming {
  name: string;
  ms: number;
  checks: Check[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function icon(s: Status): string {
  switch (s) {
    case "pass": return OK;
    case "warn": return WARN;
    case "fail": return FAIL;
    case "skip": return SKIP;
  }
}

function emitCheck(c: Check): void {
  row(icon(c.status), c.label, c.detail);
  for (const h of c.hints ?? []) hint(h);
}

function push(checks: Check[], c: Check): void {
  emitCheck(c);
  if (c.status !== "pass" && c.status !== "skip") checks.push(c);
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function relativeTime(isoStr: string | null): string {
  if (!isoStr) return "never";
  const delta = Date.now() - new Date(isoStr).getTime();
  if (delta < 0) return "in future";
  if (delta < 60_000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

function isTaskOverdue(r: HeartbeatScheduleRow): boolean {
  if (!r.nextRunAt || !r.enabled) return false;
  return new Date(r.nextRunAt).getTime() < Date.now() - 60_000;
}

// ─── 1 · Runtime ─────────────────────────────────────────────────────────────

function checkRuntime(checks: Check[]): void {
  section("Runtime");

  const nodeVer = process.version.slice(1);
  const nodeMajor = parseInt(nodeVer.split(".")[0] ?? "0", 10);
  push(checks, {
    label: "Node.js version",
    status: nodeMajor >= 18 ? "pass" : "fail",
    detail: `v${nodeVer}${nodeMajor < 18 ? "  (req ≥18)" : ""}`,
    hints: nodeMajor < 18 ? ["Upgrade Node.js: https://nodejs.org"] : [],
  });

  emitCheck({ label: "Platform", status: "pass", detail: `${process.platform} / ${process.arch}` });

  const mem = process.memoryUsage();
  emitCheck({ label: "Process RSS",  status: "pass", detail: fmtBytes(mem.rss) });
  emitCheck({ label: "Heap usage",   status: "pass", detail: `${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}` });

  try {
    const dfOut = execSync(`df -B1 "${getGalvinDir()}" 2>/dev/null || df -B1 ~`, { encoding: "utf-8", timeout: 3000 });
    const parts = dfOut.trim().split("\n")[1]?.trim().split(/\s+/) ?? [];
    const available = parseInt(parts[3] ?? "0", 10);
    if (available > 0) {
      push(checks, {
        label: "Disk space (free)",
        status: available < 200_000_000 ? "warn" : "pass",
        detail: fmtBytes(available),
        hints: available < 200_000_000 ? ["Low disk — DB + skills may fail to write"] : [],
      });
    }
  } catch { /**/ }

  try {
    const load = execSync("cat /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg 2>/dev/null", { encoding: "utf-8", timeout: 2000 }).trim();
    const load1 = parseFloat(load.split(/\s+/)[0] ?? "0");
    push(checks, {
      label: "CPU load (1m avg)",
      status: load1 > 8 ? "warn" : "pass",
      detail: load1.toFixed(2),
      hints: load1 > 8 ? ["High CPU — agent runs may be delayed"] : [],
    });
  } catch { /**/ }
}

// ─── 2 · Environment ─────────────────────────────────────────────────────────

function checkEnvironment(checks: Check[]): void {
  section("Environment");

  const envVars: Array<{ name: string; label: string; sensitive?: boolean }> = [
    { name: "CONWAY_API_KEY",    label: "Conway API key",       sensitive: true  },
    { name: "CONWAY_API_URL",    label: "Conway API URL override"                },
    { name: "OPENAI_API_KEY",    label: "OpenAI API key",       sensitive: true  },
    { name: "ANTHROPIC_API_KEY", label: "Anthropic API key",    sensitive: true  },
    { name: "OLLAMA_BASE_URL",   label: "Ollama base URL"                        },
    { name: "GALVIN_CONFIG",     label: "Config path override"                   },
    { name: "GALVIN_NO_COLOR",   label: "Color disabled"                         },
    { name: "GALVIN_NO_UI",      label: "UI disabled"                            },
    { name: "GALVIN_LOG_LEVEL",  label: "Log level override"                     },
    { name: "HOME",              label: "Home directory"                         },
    { name: "NODE_ENV",          label: "Node environment"                       },
  ];

  let anySet = false;
  for (const v of envVars) {
    const val = process.env[v.name];
    if (val !== undefined) {
      anySet = true;
      const display = v.sensitive ? `${val.slice(0, 8)}••••` : val.slice(0, 60);
      emitCheck({ label: v.label, status: "pass", detail: `${GR}[env]${R}  ${display}` });
    }
  }

  if (!anySet) {
    emitCheck({ label: "No env overrides", status: "pass", detail: "all values from config file" });
  }

  if (process.env["NO_COLOR"] !== undefined) {
    emitCheck({ label: "NO_COLOR", status: "pass", detail: "set — colour suppressed" });
  }

  // Deprecated env var detection (ported from openclaw noteDeprecatedLegacyEnvVars)
  const deprecated: Array<{ name: string; replacement: string }> = [
    { name: "GALVIN_API_KEY", replacement: "CONWAY_API_KEY" },
    { name: "GALVIN_API_URL", replacement: "CONWAY_API_URL" },
    { name: "GALVIN_DB",      replacement: "dbPath in config.json" },
  ];
  for (const d of deprecated) {
    if (process.env[d.name] !== undefined) {
      push(checks, {
        label: `Deprecated: ${d.name}`,
        status: "warn",
        detail: `use ${d.replacement} instead`,
        hints: [`unset ${d.name} and set ${d.replacement}`],
      });
    }
  }

  // Warn about unknown GALVIN_* env vars that may be typos
  const knownGalvinVars = new Set(["GALVIN_CONFIG", "GALVIN_NO_COLOR", "GALVIN_NO_UI", "GALVIN_LOG_LEVEL", "GALVIN_API_KEY", "GALVIN_API_URL", "GALVIN_DB"]);
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GALVIN_") && !knownGalvinVars.has(key)) {
      push(checks, {
        label: `Unknown env var`,
        status: "warn",
        detail: key,
        hints: ["Possible typo — galvin only recognises GALVIN_CONFIG, GALVIN_NO_COLOR, GALVIN_NO_UI, GALVIN_LOG_LEVEL"],
      });
    }
  }
}

// ─── 3 · Configuration ────────────────────────────────────────────────────────

function checkConfig(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Configuration");

  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    push(checks, { label: "Config file", status: "fail", detail: configPath, hints: ["Run: galvin --setup"] });
    return;
  }
  emitCheck({ label: "Config file", status: "pass", detail: configPath });

  if (!config) {
    push(checks, { label: "Config parse", status: "fail", detail: "invalid JSON", hints: [`Check: ${configPath}`] });
    return;
  }

  push(checks, { label: "Name",           status: config.name ? "pass" : "warn",           detail: config.name || "(not set)"                                        });
  push(checks, { label: "Wallet address", status: config.walletAddress ? "pass" : "warn",  detail: config.walletAddress ? shortAddr(config.walletAddress as string) : "(not set)", hints: config.walletAddress ? [] : ["Run: galvin --init"]     });
  push(checks, { label: "Creator address", status: config.creatorAddress ? "pass" : "warn", detail: config.creatorAddress ? shortAddr(config.creatorAddress as string) : "(not set)", hints: config.creatorAddress ? [] : ["Set creatorAddress in config"] });
  push(checks, { label: "Sandbox ID",     status: config.sandboxId ? "pass" : "warn",      detail: config.sandboxId || "(none — local exec)", hints: config.sandboxId ? [] : ["Add sandboxId to config, or run galvin --setup"] });

  const apiKeySet = !!(config.conwayApiKey || process.env["CONWAY_API_KEY"]);
  push(checks, {
    label: "Conway API key",
    status: apiKeySet ? "pass" : "fail",
    detail: apiKeySet ? `set (${(config.conwayApiKey || "").slice(0, 8)}••••)` : "not set",
    hints: apiKeySet ? [] : ["Run: galvin --provision", "Or:  export CONWAY_API_KEY=…"],
  });

  // Treasury policy
  const tp = config.treasuryPolicy as TreasuryPolicy | undefined;
  if (tp) {
    emitCheck({ label: "Treasury policy", status: "pass", detail: "custom" });
    kv("  Max single transfer",    fmtCents(tp.maxSingleTransferCents));
    kv("  Max daily transfer",     fmtCents(tp.maxDailyTransferCents));
    kv("  Min reserve",            fmtCents(tp.minimumReserveCents));
    kv("  Max inference/day",      fmtCents(tp.maxInferenceDailyCents));
    kv("  Confirm above",          fmtCents(tp.requireConfirmationAboveCents));
    if (tp.minimumReserveCents <= 0) {
      push(checks, { label: "Treasury: min reserve", status: "warn", detail: "$0.00 — risky", hints: ["Set minimumReserveCents > 0 to protect funds"] });
    }
    if (tp.maxDailyTransferCents > 1_000_000) {
      push(checks, { label: "Treasury: daily cap", status: "warn", detail: `${fmtCents(tp.maxDailyTransferCents)} — very high`, hints: ["Consider lowering maxDailyTransferCents"] });
    }
  } else {
    emitCheck({ label: "Treasury policy", status: "pass", detail: "defaults" });
  }

  // Model strategy
  const ms = config.modelStrategy as any | undefined;
  if (ms) {
    kv("  Primary model",    ms.inferenceModel  ?? "(not set)");
    kv("  Low-compute",      ms.lowComputeModel ?? "(not set)");
    kv("  Critical model",   ms.criticalModel   ?? "(not set)");
    kv("  Fallback enabled", ms.enableModelFallback ? "yes" : "no");
    if (ms.hourlyBudgetCents  > 0) kv("  Hourly budget",  fmtCents(ms.hourlyBudgetCents));
    if (ms.sessionBudgetCents > 0) kv("  Session budget", fmtCents(ms.sessionBudgetCents));
  }
}

// ─── 4 · Wallet ───────────────────────────────────────────────────────────────

function checkWallet(checks: Check[]): void {
  section("Wallet");

  const walletPath = getWalletPath();
  if (!existsSync(walletPath)) {
    push(checks, { label: "Wallet file", status: "warn", detail: "not found", hints: ["Run: galvin --init  to create a wallet"] });
    return;
  }

  const stat = statSync(walletPath);
  emitCheck({ label: "Wallet file", status: "pass", detail: `${walletPath}  (${fmtBytes(stat.size)})` });

  const mode = stat.mode & 0o777;
  if (mode & 0o044) {
    push(checks, {
      label: "Wallet permissions",
      status: "warn",
      detail: `0${mode.toString(8)}  (should be 0600)`,
      hints: [`Run: chmod 600 ${walletPath}`],
    });
  } else {
    emitCheck({ label: "Wallet permissions", status: "pass", detail: `0${mode.toString(8)}` });
  }

  try {
    const raw = JSON.parse(readFileSync(walletPath, "utf-8"));
    if (raw.address)   emitCheck({ label: "Address",   status: "pass", detail: shortAddr(raw.address) });
    if (raw.network)   emitCheck({ label: "Network",   status: "pass", detail: raw.network });
    if (raw.chainId)   emitCheck({ label: "Chain ID",  status: "pass", detail: String(raw.chainId) });
    if (raw.createdAt) emitCheck({ label: "Created",   status: "pass", detail: relativeTime(raw.createdAt) });
  } catch {
    push(checks, { label: "Wallet parse", status: "warn", detail: "could not read wallet.json" });
  }
}

// ─── 5 · Database ─────────────────────────────────────────────────────────────

function checkDatabase(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Database");

  if (!config) { emitCheck({ label: "Database", status: "skip", detail: "config not loaded" }); return; }

  const dbPath = resolvePath(config.dbPath);
  if (!existsSync(dbPath)) {
    emitCheck({ label: "DB file",   status: "warn", detail: `${dbPath}  (not created yet)` });
    emitCheck({ label: "DB schema", status: "skip", detail: "not created yet" });
    return;
  }

  const dbStat = statSync(dbPath);
  emitCheck({ label: "DB file", status: "pass", detail: `${dbPath}  (${fmtBytes(dbStat.size)})` });

  const walPath = dbPath + "-wal";
  if (existsSync(walPath)) {
    const walStat = statSync(walPath);
    const walWarn = walStat.size > 64 * 1024 * 1024;
    push(checks, {
      label: "WAL size",
      status: walWarn ? "warn" : "pass",
      detail: fmtBytes(walStat.size),
      hints: walWarn ? ["Large WAL slows reads — agent checkpoints automatically"] : [],
    });
  }

  let db: ReturnType<typeof createDatabase> | null = null;
  try {
    db = createDatabase(dbPath);

    const versionRow = db.raw.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const current = parseInt(versionRow?.value ?? "0", 10);
    push(checks, {
      label: "Schema version",
      status: current === SCHEMA_VERSION ? "pass" : current > 0 ? "warn" : "fail",
      detail: `v${current}  ${current === SCHEMA_VERSION ? "(current)" : `(expected v${SCHEMA_VERSION})`}`,
      hints: current < SCHEMA_VERSION ? ["DB will auto-migrate on next galvin --run"] : [],
    });

    // Integrity check
    try {
      const integ = db.raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      const ok = integ?.integrity_check === "ok";
      push(checks, {
        label: "DB integrity",
        status: ok ? "pass" : "fail",
        detail: integ?.integrity_check ?? "unknown",
        hints: ok ? [] : ["DB may be corrupt — backup then galvin --reset-db"],
      });
    } catch {
      push(checks, { label: "DB integrity", status: "warn", detail: "check failed" });
    }

    const q = <T>(sql: string, ...args: unknown[]): T => db!.raw.prepare(sql).get(...(args as any[])) as T;
    const qq = <T>(sql: string, ...args: unknown[]): T[] => db!.raw.prepare(sql).all(...(args as any[])) as T[];

    const turnCount   = q<{ n: number }>("SELECT COUNT(*) as n FROM turns")?.n ?? 0;
    const txnCount    = q<{ n: number }>("SELECT COUNT(*) as n FROM transactions")?.n ?? 0;
    const toolCount   = q<{ n: number }>("SELECT COUNT(*) as n FROM installed_tools WHERE enabled = 1")?.n ?? 0;
    const skillCount  = q<{ n: number }>("SELECT COUNT(*) as n FROM skills WHERE enabled = 1")?.n ?? 0;
    const memCount    = q<{ n: number }>("SELECT COUNT(*) as n FROM semantic_memory")?.n ?? 0;
    const episodic    = q<{ n: number }>("SELECT COUNT(*) as n FROM episodic_memory")?.n ?? 0;
    const uncompacted = q<{ n: number }>("SELECT COUNT(*) as n FROM episodic_memory WHERE compacted_at IS NULL")?.n ?? 0;
    const state       = db.getAgentState();

    emitCheck({ label: "Agent state",    status: "pass", detail: state.toUpperCase() });
    emitCheck({ label: "Turns recorded", status: "pass", detail: String(turnCount) });
    emitCheck({ label: "Transactions",   status: "pass", detail: String(txnCount) });
    push(checks, { label: "Active tools",   status: toolCount > 0 ? "pass" : "warn", detail: String(toolCount) });
    emitCheck({ label: "Active skills",  status: "pass", detail: String(skillCount) });
    emitCheck({ label: "Semantic memory", status: "pass", detail: `${memCount} entries` });

    const compactedPct = episodic > 0 ? Math.round(((episodic - uncompacted) / episodic) * 100) : 100;
    push(checks, {
      label: "Episodic memory",
      status: uncompacted > 500 ? "warn" : "pass",
      detail: `${episodic} entries  ·  ${compactedPct}% compacted`,
      hints: uncompacted > 500 ? ["galvin --run  to trigger memory_consolidate heartbeat"] : [],
    });

    // Recent activity analysis
    if (turnCount > 0) {
      try {
        const recent = qq<{ error: string | null; cost_cents: number | null; created_at: string }>(
          "SELECT error, cost_cents, created_at FROM turns ORDER BY created_at DESC LIMIT 20"
        );
        const errCount = recent.filter((t) => t.error && t.error.length > 2).length;
        const errRate = Math.round((errCount / recent.length) * 100);
        const avgCost = recent.length
          ? Math.round(recent.map((t) => t.cost_cents ?? 0).reduce((a, b) => a + b, 0) / recent.length)
          : 0;
        push(checks, {
          label: "Recent error rate",
          status: errRate > 40 ? "warn" : "pass",
          detail: `${errRate}%  (${errCount}/${recent.length} turns in last 20)`,
          hints: errRate > 40 ? ["High error rate — check galvin --logs for details"] : [],
        });
        emitCheck({ label: "Avg turn cost", status: "pass", detail: `${fmtCents(avgCost)} / turn  (last 20)` });
        emitCheck({ label: "Last activity", status: "pass", detail: relativeTime(recent[0]?.created_at ?? null) });
      } catch { /**/ }
    }

    // 24h spending vs daily inference limit
    try {
      const tp = config?.treasuryPolicy as TreasuryPolicy | undefined;
      const dailyLimit = tp?.maxInferenceDailyCents ?? 50_000;
      const since = new Date(Date.now() - 86_400_000).toISOString();
      const spend24h = q<{ total: number }>(
        "SELECT COALESCE(SUM(amount_cents),0) as total FROM spend_tracking WHERE created_at > ? AND category = 'inference'",
        since
      )?.total ?? 0;
      const spendPct = dailyLimit > 0 ? Math.round((spend24h / dailyLimit) * 100) : 0;
      push(checks, {
        label: "Inference spend (24h)",
        status: spendPct > 80 ? "warn" : "pass",
        detail: `${fmtCents(spend24h)} of ${fmtCents(dailyLimit)}  (${spendPct}%)`,
        hints: spendPct > 80 ? ["Near daily inference budget — agent will downgrade model tier"] : [],
      });
    } catch { /**/ }

    // Goals / tasks
    try {
      const goals = getActiveGoals(db.raw as any);
      const tasks = getReadyTasks(db.raw as any);
      emitCheck({ label: "Active goals", status: "pass", detail: String(goals.length) });
      emitCheck({ label: "Ready tasks",  status: "pass", detail: String(tasks.length) });
    } catch { /**/ }

    try {
      const wakeEvents = getUnconsumedWakeEvents(db.raw as any);
      if (wakeEvents.length > 0) emitCheck({ label: "Pending wake events", status: "pass", detail: `${wakeEvents.length}` });
    } catch { /**/ }

    try {
      const inboxCount = getUnprocessedInboxCount(db.raw as any);
      if (inboxCount > 0) emitCheck({ label: "Inbox unprocessed", status: "pass", detail: `${inboxCount} messages` });
    } catch { /**/ }

  } catch (err: any) {
    push(checks, {
      label: "DB open",
      status: "fail",
      detail: err?.message ?? "unknown error",
      hints: ["Try: galvin --reset-db  to recreate (DELETES all data)"],
    });
  } finally {
    try { db?.close(); } catch { /**/ }
  }
}

// ─── 6 · Heartbeat Tasks ─────────────────────────────────────────────────────

function checkHeartbeat(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Heartbeat Tasks");

  if (!config) { emitCheck({ label: "Heartbeat", status: "skip", detail: "config not loaded" }); return; }

  const dbPath = resolvePath(config.dbPath);
  if (!existsSync(dbPath)) { emitCheck({ label: "Heartbeat", status: "skip", detail: "DB not created yet" }); return; }

  let db: ReturnType<typeof createDatabase> | null = null;
  try {
    db = createDatabase(dbPath);
    const schedule = getHeartbeatSchedule(db.raw as any);

    if (schedule.length === 0) {
      emitCheck({ label: "Heartbeat tasks", status: "warn", detail: "none registered", hints: ["Tasks register when galvin starts"] });
      return;
    }

    const enabled = schedule.filter((t) => t.enabled);
    const disabled = schedule.filter((t) => !t.enabled);
    emitCheck({ label: "Tasks registered", status: "pass", detail: `${schedule.length} total  ·  ${enabled.length} enabled, ${disabled.length} disabled` });

    for (const task of schedule) {
      const overdue = isTaskOverdue(task);
      const highFail = task.failCount > 3;
      const st: Status = !task.enabled ? "skip"
        : task.lastResult === "failure" ? "warn"
        : highFail ? "warn"
        : overdue ? "warn"
        : "pass";

      const tags: string[] = [];
      if (!task.enabled)      tags.push("disabled");
      else if (overdue)       tags.push("overdue");
      if (task.failCount > 0) tags.push(`${task.failCount} fail${task.failCount > 1 ? "s" : ""}`);
      if (task.runCount > 0)  tags.push(`${task.runCount} runs`);
      if (task.lastResult)    tags.push(task.lastResult);
      if (task.lastRunAt)     tags.push(`last: ${relativeTime(task.lastRunAt)}`);

      push(checks, {
        label: `  ${task.taskName}`,
        status: st,
        detail: tags.join("  ·  "),
        hints: overdue ? ["Task may be stuck — check: galvin --status"] : [],
      });
    }

    // Recent task failures
    try {
      const recentFails = db.raw.prepare(
        "SELECT task_name, error, completed_at FROM heartbeat_history WHERE result = 'failure' ORDER BY completed_at DESC LIMIT 5"
      ).all() as Array<{ task_name: string; error: string | null; completed_at: string | null }>;
      if (recentFails.length > 0) {
        gap();
        print(`  ${YEL}Recent task failures:${R}`);
        for (const f of recentFails) {
          print(`  ${GR}·${R}  ${f.task_name}  ${DIM}${relativeTime(f.completed_at)}${R}  ${RED}${(f.error ?? "").slice(0, 60)}${R}`);
        }
      }
    } catch { /**/ }

  } catch (err: any) {
    emitCheck({ label: "Heartbeat check", status: "skip", detail: err?.message?.slice(0, 50) ?? "failed" });
  } finally {
    try { db?.close(); } catch { /**/ }
  }
}

// ─── 7 · Conway Cloud ─────────────────────────────────────────────────────────

async function checkConway(checks: Check[], config: ReturnType<typeof loadConfig>): Promise<void> {
  section("Conway Cloud");

  if (!config) { emitCheck({ label: "Conway API", status: "skip", detail: "config not loaded" }); return; }

  const apiKey = config.conwayApiKey || process.env["CONWAY_API_KEY"] || "";
  const apiUrl = process.env["CONWAY_API_URL"] || "https://api.conway.tech";

  emitCheck({ label: "API URL", status: "pass", detail: apiUrl });

  // Connectivity + latency
  try {
    const t0 = Date.now();
    const pingResp = await withTimeout(fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5000) }), 6000, null);
    const pingMs = Date.now() - t0;
    const pingOk = pingResp && (pingResp.ok || pingResp.status === 404);
    push(checks, {
      label: "API connectivity",
      status: pingOk ? "pass" : "warn",
      detail: pingOk ? `${pingMs}ms` : `unreachable (${pingMs}ms)`,
      hints: pingOk ? [] : ["Check https://status.conway.tech"],
    });
  } catch {
    push(checks, { label: "API connectivity", status: "warn", detail: "request failed", hints: ["Check network / VPN"] });
  }

  if (!apiKey) {
    push(checks, { label: "API key", status: "fail", detail: "not set", hints: ["Run: galvin --provision", "Or: export CONWAY_API_KEY=…"] });
    emitCheck({ label: "Credits balance",   status: "skip", detail: "no API key" });
    emitCheck({ label: "Sandbox exec test", status: "skip", detail: "no API key" });
    return;
  }
  emitCheck({ label: "API key", status: "pass", detail: `${apiKey.slice(0, 10)}••••` });

  let creditsOk = false;
  try {
    const { createConwayClient } = await import("../conway/client.js");
    const conway = createConwayClient({ apiUrl, apiKey, sandboxId: config.sandboxId ?? "" });
    const t0 = Date.now();
    const balance = await withTimeout(conway.getCreditsBalance(), 8_000, -1);
    const latency = Date.now() - t0;
    if (balance === -1) {
      push(checks, { label: "Credits balance", status: "warn", detail: `timed out  (${latency}ms)`, hints: ["Check https://status.conway.tech"] });
    } else if (balance < 0) {
      push(checks, { label: "Credits balance", status: "fail", detail: "API error", hints: ["Verify CONWAY_API_KEY"] });
    } else {
      const low = balance < 10;
      push(checks, {
        label: "Credits balance",
        status: low ? "warn" : "pass",
        detail: `${balance.toFixed(2)} credits  (${latency}ms)${low ? "  ⚠ low!" : ""}`,
        hints: low ? ["Top up at https://conway.tech/billing"] : [],
      });
      creditsOk = true;
    }
  } catch (err: any) {
    push(checks, { label: "Credits balance", status: "fail", detail: err?.message?.slice(0, 60) ?? "request failed" });
  }

  const sandboxId = config.sandboxId ?? "";
  if (!sandboxId) { emitCheck({ label: "Sandbox exec test", status: "skip", detail: "no sandbox ID configured" }); return; }
  if (!creditsOk) { emitCheck({ label: "Sandbox exec test", status: "skip", detail: "credits check failed" }); return; }

  try {
    const { createConwayClient } = await import("../conway/client.js");
    const conway2 = createConwayClient({ apiUrl, apiKey, sandboxId });
    const t0 = Date.now();
    const result = await withTimeout(conway2.exec("echo galvin-doctor-ok"), 12_000, { stdout: "", stderr: "timeout", exitCode: 1 });
    const ms = Date.now() - t0;
    if (result.stdout.includes("galvin-doctor-ok")) {
      emitCheck({ label: "Sandbox exec test", status: "pass", detail: `${ms}ms` });
    } else {
      push(checks, {
        label: "Sandbox exec test",
        status: "fail",
        detail: result.stderr?.slice(0, 60) || "unexpected output",
        hints: ["Sandbox may be hibernating — first exec is slow. Try galvin --run."],
      });
    }
  } catch (err: any) {
    push(checks, { label: "Sandbox exec test", status: "fail", detail: err?.message?.slice(0, 60) ?? "exec failed" });
  }
}

// ─── 8 · Inference ────────────────────────────────────────────────────────────

async function checkInference(checks: Check[], config: ReturnType<typeof loadConfig>): Promise<void> {
  section("Inference");

  if (!config) { emitCheck({ label: "Inference", status: "skip", detail: "config not loaded" }); return; }

  const model = config.inferenceModel;
  push(checks, { label: "Primary model", status: model ? "pass" : "warn", detail: model || "(not set)", hints: model ? [] : ["Run: galvin --pick-model"] });

  const ms = config.modelStrategy as any | undefined;
  if (ms?.enableModelFallback) {
    emitCheck({ label: "Model fallback", status: "pass", detail: `enabled  →  ${ms.lowComputeModel ?? "?"}` });
  } else if (ms?.enableModelFallback === false) {
    push(checks, { label: "Model fallback", status: "warn", detail: "disabled" });
  }

  const hasConway    = !!(config.conwayApiKey    || process.env["CONWAY_API_KEY"]);
  const hasOpenAI    = !!(config.openaiApiKey    || process.env["OPENAI_API_KEY"]);
  const hasAnthropic = !!(config.anthropicApiKey || process.env["ANTHROPIC_API_KEY"]);
  const hasOllama    = !!(config.ollamaBaseUrl   || process.env["OLLAMA_BASE_URL"]);

  const providers: string[] = [];
  if (hasConway)    providers.push("Conway");
  if (hasOpenAI)    providers.push("OpenAI");
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOllama)    providers.push("Ollama");

  push(checks, {
    label: "Providers configured",
    status: providers.length > 0 ? "pass" : "fail",
    detail: providers.length > 0 ? providers.join(", ") : "none",
    hints: providers.length === 0 ? ["Add conwayApiKey, openaiApiKey, or anthropicApiKey to config"] : [],
  });

  if (providers.length > 1) {
    emitCheck({ label: "Failover pool", status: "pass", detail: `${providers.length} providers  (good redundancy)` });
  }

  if (hasOllama) {
    const ollamaUrl = config.ollamaBaseUrl || process.env["OLLAMA_BASE_URL"] || "http://localhost:11434";
    try {
      const t0 = Date.now();
      const resp = await withTimeout(fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(4_000) }), 5_000, null);
      const ms2 = Date.now() - t0;
      if (resp?.ok) {
        const json = await resp.json() as any;
        const modelCount = Array.isArray(json.models) ? json.models.length : "?";
        emitCheck({ label: "Ollama ping", status: "pass", detail: `${ms2}ms  ·  ${modelCount} models available` });
      } else {
        push(checks, { label: "Ollama ping", status: "warn", detail: resp ? `HTTP ${resp.status}` : "no response", hints: ["Start Ollama: ollama serve"] });
      }
    } catch (err: any) {
      push(checks, { label: "Ollama ping", status: "warn", detail: err?.message?.slice(0, 50) ?? "unreachable", hints: ["Start Ollama: ollama serve"] });
    }
  }

  // Live API reachability probes (without running inference, just verify auth)
  if (hasOpenAI) {
    const openaiKey = config.openaiApiKey || process.env["OPENAI_API_KEY"] || "";
    try {
      const t0 = Date.now();
      const resp = await withTimeout(
        fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${openaiKey}` },
          signal: AbortSignal.timeout(6000),
        }),
        7_000, null,
      );
      const probeMs = Date.now() - t0;
      push(checks, {
        label: "OpenAI API reachable",
        status: resp?.ok ? "pass" : "warn",
        detail: resp ? `HTTP ${resp.status}  (${probeMs}ms)` : `timeout (${probeMs}ms)`,
        hints: resp?.status === 401 ? ["Check OPENAI_API_KEY — key may be invalid"] : [],
      });
    } catch (err: any) {
      push(checks, { label: "OpenAI API reachable", status: "warn", detail: err?.message?.slice(0, 50) ?? "unreachable" });
    }
  }

  if (hasAnthropic) {
    const anthropicKey = config.anthropicApiKey || process.env["ANTHROPIC_API_KEY"] || "";
    try {
      const t0 = Date.now();
      const resp = await withTimeout(
        fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(6000),
        }),
        7_000, null,
      );
      const probeMs = Date.now() - t0;
      push(checks, {
        label: "Anthropic API reachable",
        status: resp?.ok ? "pass" : "warn",
        detail: resp ? `HTTP ${resp.status}  (${probeMs}ms)` : `timeout (${probeMs}ms)`,
        hints: resp?.status === 401 ? ["Check ANTHROPIC_API_KEY — key may be invalid"] : [],
      });
    } catch (err: any) {
      push(checks, { label: "Anthropic API reachable", status: "warn", detail: err?.message?.slice(0, 50) ?? "unreachable" });
    }
  }
}

// ─── 9 · Social ───────────────────────────────────────────────────────────────

function checkSocial(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Social");

  if (!config) { emitCheck({ label: "Social", status: "skip", detail: "config not loaded" }); return; }

  const adapter = config.socialAdapter ?? (config.socialRelayUrl ? "conway" : "none");
  push(checks, { label: "Adapter", status: adapter !== "none" ? "pass" : "warn", detail: adapter });

  if (adapter === "conway" || (!config.socialAdapter && config.socialRelayUrl)) {
    if (config.socialRelayUrl) {
      emitCheck({ label: "Conway relay URL", status: "pass", detail: config.socialRelayUrl });
    } else {
      push(checks, { label: "Conway relay URL", status: "warn", detail: "not set  (inbox disabled)", hints: ["Set socialRelayUrl in config to enable messaging"] });
    }
  }

  if (adapter === "telegram") {
    push(checks, {
      label: "Telegram bot token",
      status: config.telegramBotToken ? "pass" : "fail",
      detail: config.telegramBotToken ? `${config.telegramBotToken.slice(0, 12)}••••` : "not set",
      hints: config.telegramBotToken ? [] : ["Get token from @BotFather on Telegram"],
    });
    push(checks, {
      label: "Telegram creator chat ID",
      status: config.telegramCreatorChatId ? "pass" : "fail",
      detail: config.telegramCreatorChatId ?? "not set",
      hints: config.telegramCreatorChatId ? [] : ["GET https://api.telegram.org/bot{TOKEN}/getUpdates"],
    });
  }
}

// ─── 10 · Browser ─────────────────────────────────────────────────────────────

async function checkBrowser(checks: Check[]): Promise<void> {
  section("Browser Automation");

  let playwrightInstalled = false;
  let playwrightVersion = "";
  const tryPaths = [
    fileURLToPath(new URL("../../node_modules/playwright-core/package.json", import.meta.url)),
    path.join(process.cwd(), "node_modules", "playwright-core", "package.json"),
    path.join(process.cwd(), "..", "node_modules", "playwright-core", "package.json"),
  ];
  for (const p of tryPaths) {
    if (existsSync(p)) {
      playwrightInstalled = true;
      try { playwrightVersion = JSON.parse(readFileSync(p, "utf-8")).version ?? ""; } catch { /**/ }
      break;
    }
  }

  push(checks, {
    label: "playwright-core",
    status: playwrightInstalled ? "pass" : "warn",
    detail: playwrightInstalled ? `v${playwrightVersion}` : "not found",
    hints: playwrightInstalled ? [] : ["Run: pnpm add playwright-core"],
  });

  const cacheDir = path.join(process.env["HOME"] ?? "/root", ".cache", "ms-playwright");
  let chromiumFound = false;
  let chromiumPath = "";
  let chromiumVersion = "";
  if (existsSync(cacheDir)) {
    try {
      const entries = readdirSync(cacheDir);
      const chromiumDir = entries.find((e) => e.startsWith("chromium"));
      if (chromiumDir) {
        chromiumFound = true;
        chromiumPath = path.join(cacheDir, chromiumDir);
        const match = chromiumDir.match(/chromium-(\d+)/);
        if (match) chromiumVersion = `r${match[1]}`;
      }
    } catch { /**/ }
  }

  push(checks, {
    label: "Chromium binary",
    status: chromiumFound ? "pass" : "warn",
    detail: chromiumFound ? `${chromiumPath}${chromiumVersion ? `  (${chromiumVersion})` : ""}` : "not found",
    hints: chromiumFound ? [] : ["Run: pnpm exec playwright install chromium"],
  });

  if (chromiumFound && chromiumPath) {
    try {
      const du = execSync(`du -sb "${chromiumPath}" 2>/dev/null`, { encoding: "utf-8", timeout: 3000 });
      const bytes = parseInt(du.trim().split("\t")[0] ?? "0", 10);
      if (bytes > 0) emitCheck({ label: "Chromium disk usage", status: "pass", detail: fmtBytes(bytes) });
    } catch { /**/ }
  }
}

// ─── 11 · Skills & Tools ─────────────────────────────────────────────────────

function checkSkills(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Skills & Tools");

  const galvinDir = getGalvinDir();
  const skillsDir = path.join(galvinDir, "skills");

  if (!existsSync(skillsDir)) {
    push(checks, {
      label: "Skills directory",
      status: "warn",
      detail: `${skillsDir}  (not found)`,
      hints: ["Created on first galvin --run"],
    });
  } else {
    emitCheck({ label: "Skills directory", status: "pass", detail: skillsDir });
    let count = 0;
    try { count = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { /**/ }
    push(checks, {
      label: "Skills installed",
      status: count === 0 ? "warn" : "pass",
      detail: String(count),
      hints: count === 0 ? ["Install skills via install_skill tool during a galvin --run session"] : [],
    });
  }

  if (config && existsSync(resolvePath(config.dbPath))) {
    let db: ReturnType<typeof createDatabase> | null = null;
    try {
      db = createDatabase(resolvePath(config.dbPath));
      const toolRows = db.raw.prepare(
        "SELECT category, COUNT(*) as n, SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) as en FROM installed_tools GROUP BY category ORDER BY category"
      ).all() as Array<{ category: string; n: number; en: number }>;
      if (toolRows.length > 0) {
        emitCheck({ label: "Tool categories", status: "pass", detail: toolRows.map((r) => `${r.category}(${r.en}/${r.n})`).join("  ") });
      }
      const disabledTools = db.raw.prepare("SELECT name FROM installed_tools WHERE enabled = 0 LIMIT 5").all() as Array<{ name: string }>;
      if (disabledTools.length > 0) {
        emitCheck({ label: "Disabled tools", status: "pass", detail: disabledTools.map((t) => t.name).join(", ") });
      }
    } catch { /**/ } finally {
      try { db?.close(); } catch { /**/ }
    }
  }
}

// ─── 12 · Git State ───────────────────────────────────────────────────────────

function checkGitState(checks: Check[]): void {
  section("Git State");

  const stateRepo = path.join(getGalvinDir(), "state");
  if (!existsSync(stateRepo)) {
    emitCheck({ label: "State repo", status: "skip", detail: "not initialised yet  (created on first run)" });
    return;
  }

  const gitDir = path.join(stateRepo, ".git");
  if (!existsSync(gitDir)) {
    push(checks, { label: "State repo", status: "warn", detail: ".git missing", hints: ["galvin --run  to initialise git state versioning"] });
    return;
  }

  emitCheck({ label: "State repo", status: "pass", detail: stateRepo });

  try {
    const log = execSync(`git -C "${stateRepo}" log --oneline -5 --no-decorate 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
    const lines = log.split("\n").filter(Boolean);
    emitCheck({ label: "Recent commits", status: "pass", detail: String(lines.length) });
    const lastDate = execSync(`git -C "${stateRepo}" log -1 --format=%ci 2>/dev/null`, { encoding: "utf-8", timeout: 2000 }).trim();
    if (lastDate) emitCheck({ label: "Last commit", status: "pass", detail: relativeTime(lastDate) });
  } catch { /**/ }

  try {
    const dirty = execSync(`git -C "${stateRepo}" status --porcelain 2>/dev/null`, { encoding: "utf-8", timeout: 2000 }).trim();
    if (dirty.length > 0) {
      push(checks, { label: "Working tree", status: "warn", detail: `${dirty.split("\n").length} file(s) dirty` });
    } else {
      emitCheck({ label: "Working tree", status: "pass", detail: "clean" });
    }
  } catch { /**/ }
}

// ─── 13 · Children & Replication ─────────────────────────────────────────────

function checkChildren(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Children & Replication");

  if (!config || !existsSync(resolvePath(config.dbPath))) {
    emitCheck({ label: "Children", status: "skip", detail: "DB not available" });
    return;
  }

  let db: ReturnType<typeof createDatabase> | null = null;
  try {
    db = createDatabase(resolvePath(config.dbPath));
    const children = db.getChildren();

    if (children.length === 0) {
      emitCheck({ label: "Child agents", status: "pass", detail: "none spawned" });
      return;
    }

    const stateMap: Record<string, number> = {};
    for (const c of children) {
      const s = (c as any).lifecycleState ?? "unknown";
      stateMap[s] = (stateMap[s] ?? 0) + 1;
    }
    const summary = Object.entries(stateMap).map(([s, n]) => `${s}×${n}`).join("  ");
    emitCheck({ label: "Child agents", status: "pass", detail: `${children.length} total  ·  ${summary}` });

    try {
      const stuck = getChildrenByStatus(db.raw as any, "requested");
      if (stuck.length > 0) {
        push(checks, {
          label: "Stuck children",
          status: "warn",
          detail: `${stuck.length} never progressed past 'requested'`,
          hints: ["Check galvin --logs  — provisioning may have failed"],
        });
      }
    } catch { /**/ }

  } catch { /**/ } finally {
    try { db?.close(); } catch { /**/ }
  }
}

// ─── 14 · State Directory ────────────────────────────────────────────────────

function checkStateDir(checks: Check[]): void {
  section("State Directory");

  const galvinDir = getGalvinDir();
  emitCheck({ label: "Galvin dir", status: "pass", detail: galvinDir });

  if (!existsSync(galvinDir)) {
    push(checks, { label: "State dir exists", status: "warn", detail: "not yet created", hints: ["Run: galvin --init"] });
    return;
  }

  // Writable?
  try {
    accessSync(galvinDir, fsConstants.W_OK);
    emitCheck({ label: "State dir writable", status: "pass" });
  } catch {
    push(checks, {
      label: "State dir writable",
      status: "fail",
      detail: "no write access",
      hints: [`Run: sudo chown -R $USER "${galvinDir}"`],
    });
  }

  // Owner + permissions
  try {
    const st = statSync(galvinDir);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (uid !== null && st.uid !== uid) {
      push(checks, {
        label: "State dir owner",
        status: "warn",
        detail: `uid ${st.uid}  (process uid ${uid})`,
        hints: [`Run: sudo chown -R $USER "${galvinDir}"`],
      });
    } else {
      emitCheck({ label: "State dir owner", status: "pass", detail: `uid ${st.uid ?? "?"}` });
    }
    const mode = st.mode & 0o777;
    if (mode & 0o007) {
      push(checks, {
        label: "State dir permissions",
        status: "warn",
        detail: `0${mode.toString(8)}  (world-accessible)`,
        hints: [`Run: chmod 700 "${galvinDir}"`],
      });
    } else {
      emitCheck({ label: "State dir permissions", status: "pass", detail: `0${mode.toString(8)}` });
    }
  } catch { /**/ }

  // Real-path vs reported path (symlink anomaly detection)
  try {
    const real = execSync(`realpath "${galvinDir}" 2>/dev/null`, { encoding: "utf-8", timeout: 2000 }).trim();
    if (real && real !== path.resolve(galvinDir)) {
      push(checks, {
        label: "State dir symlink",
        status: "warn",
        detail: `resolves to ${real}`,
        hints: ["Symlinked state dir may cause lock/path confusion"],
      });
    }
  } catch { /**/ }

  // Conflicting galvin state dirs
  try {
    const homeDir = process.env["HOME"] ?? "/root";
    const candidates = [
      path.join(homeDir, ".galvin-backup"),
      path.join(homeDir, ".galvin2"),
      path.join(homeDir, "galvin-data"),
      path.join("/tmp", ".galvin"),
    ];
    const conflicts = candidates.filter((c) => existsSync(c));
    if (conflicts.length > 0) {
      push(checks, {
        label: "Conflicting galvin dirs",
        status: "warn",
        detail: conflicts.join(", "),
        hints: ["Multiple galvin directories may cause confusion — remove old ones"],
      });
    } else {
      emitCheck({ label: "Conflicting galvin dirs", status: "pass", detail: "none found" });
    }
  } catch { /**/ }
}

// ─── 15 · Process & Locks ────────────────────────────────────────────────────

async function checkProcessLocks(checks: Check[]): Promise<void> {
  section("Process & Locks");

  const galvinDir = getGalvinDir();
  const pidFile = path.join(galvinDir, "galvin.pid");

  // galvin.pid check (legacy — may still exist from older versions)
  if (!existsSync(pidFile)) {
    emitCheck({ label: "PID file (legacy)", status: "pass", detail: "none" });
  } else {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch { /**/ }
      const pidStat = statSync(pidFile);
      const ageMs = Date.now() - pidStat.mtimeMs;
      const stale = !alive && ageMs > 30 * 60 * 1000;
      push(checks, {
        label: "PID file (legacy)",
        status: stale ? "warn" : alive ? "pass" : "warn",
        detail: `pid=${pid}  (${alive ? "alive" : "dead"})  age=${relativeTime(new Date(pidStat.mtimeMs).toISOString())}`,
        hints: stale ? [`Run: rm "${pidFile}" to clear stale lock`] : [],
      });
    } catch {
      emitCheck({ label: "PID file (legacy)", status: "pass", detail: "unreadable (skipped)" });
    }
  }

  // ── Gateway lock file check ──────────────────────────────
  const lock = readLock();
  if (!lock) {
    push(checks, {
      label: "Gateway lock",
      status: "warn",
      detail: "no lock file — agent is not running",
      hints: ["Start with: galvin --run"],
    });
  } else {
    const alive = isPidAlive(lock.pid);
    if (!alive) {
      push(checks, {
        label: "Gateway lock",
        status: "warn",
        detail: `stale lock (PID ${lock.pid} is dead)  started: ${lock.startedAt}`,
        hints: ["The lock file references a dead process. It will be auto-cleaned on next run."],
      });
    } else {
      // PID alive — probe the HTTP server
      const health = await probeGateway(lock.port);
      if (health) {
        const h = health as any;
        emitCheck({
          label: "Gateway lock",
          status: "pass",
          detail: `PID ${lock.pid}  ·  :${lock.port}  ·  uptime ${h.uptimeHuman ?? "?"}  ·  state: ${h.state ?? "?"}`,
        });
      } else {
        push(checks, {
          label: "Gateway lock",
          status: "warn",
          detail: `PID ${lock.pid} alive but gateway HTTP on :${lock.port} not responding`,
          hints: ["The agent process exists but the gateway server may have crashed"],
        });
      }
    }
  }

  // Stale .lock files in galvin dir
  try {
    const lockFiles = execSync(
      `find "${galvinDir}" -maxdepth 3 -name "*.lock" -not -name "galvin.lock" 2>/dev/null | head -20`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim().split("\n").filter(Boolean);

    if (lockFiles.length > 0) {
      let staleCount = 0;
      const details: string[] = [];
      for (const lf of lockFiles.slice(0, 5)) {
        try {
          const lst = statSync(lf);
          const ageMs = Date.now() - lst.mtimeMs;
          const isStale = ageMs > 60 * 60 * 1000;
          if (isStale) staleCount++;
          details.push(`${path.basename(lf)}(${isStale ? "stale " : ""}${relativeTime(new Date(lst.mtimeMs).toISOString())})`);
        } catch { details.push(path.basename(lf)); }
      }
      push(checks, {
        label: "Other lock files",
        status: staleCount > 0 ? "warn" : "pass",
        detail: `${lockFiles.length} found: ${details.join(", ")}`,
        hints: staleCount > 0 ? [`find "${galvinDir}" -name "*.lock" -not -name "galvin.lock" -mmin +60 -delete`] : [],
      });
    } else {
      emitCheck({ label: "Other lock files", status: "pass", detail: "none" });
    }
  } catch { /**/ }

  // Detect another galvin --run process
  try {
    const psOut = execSync("pgrep -f 'galvin.*--run' 2>/dev/null || true", {
      encoding: "utf-8", timeout: 2000,
    }).trim();
    const pids = psOut.split("\n").filter(Boolean).map(Number).filter((p) => !isNaN(p) && p !== process.pid);
    if (pids.length > 1) {
      push(checks, {
        label: "Running instances",
        status: "warn",
        detail: `${pids.length} galvin processes detected  (pids: ${pids.join(", ")})`,
        hints: ["Only one galvin agent should run at a time"],
      });
    } else if (pids.length === 1) {
      emitCheck({ label: "Running instances", status: "pass", detail: `1 instance  (PID ${pids[0]})` });
    } else {
      emitCheck({ label: "Running instances", status: "pass", detail: "none detected" });
    }
  } catch { /**/ }

  // DB lock check — SQLite .db-journal or .db-shm
  if (existsSync(path.join(galvinDir, "galvin.db"))) {
    const dbBase = path.join(galvinDir, "galvin.db");
    const journalPath = dbBase + "-journal";
    const shmPath = dbBase + "-shm";
    if (existsSync(journalPath)) {
      const jst = statSync(journalPath);
      const ageMs = Date.now() - jst.mtimeMs;
      push(checks, {
        label: "DB journal file",
        status: ageMs > 10 * 60 * 1000 ? "warn" : "pass",
        detail: `present  (age: ${relativeTime(new Date(jst.mtimeMs).toISOString())})`,
        hints: ageMs > 10 * 60 * 1000 ? ["Stale journal may indicate incomplete txn — ensure galvin is not running before recovery"] : [],
      });
    }
    if (existsSync(shmPath)) {
      emitCheck({ label: "DB SHM file", status: "pass", detail: `present  (WAL mode active)` });
    }
  }
}

// ─── 16 · Security Audit ─────────────────────────────────────────────────────

function checkSecurity(checks: Check[]): void {
  section("Security Audit");

  const galvinDir = getGalvinDir();
  const homeDir = process.env["HOME"] ?? "/root";

  // Sensitive files must not be group- or world-readable
  const sensitiveFiles: Array<{ filePath: string; label: string; fixHint: string }> = [
    { filePath: path.join(galvinDir, "wallet.json"),   label: "Wallet",        fixHint: `chmod 600 "${path.join(galvinDir, "wallet.json")}"` },
    { filePath: path.join(galvinDir, "config.json"),   label: "Config",        fixHint: `chmod 600 "${path.join(galvinDir, "config.json")}"` },
    { filePath: path.join(galvinDir, "identity.json"), label: "Identity file", fixHint: `chmod 600 "${path.join(galvinDir, "identity.json")}"` },
    { filePath: path.join(homeDir, ".env"),            label: "Home .env",     fixHint: `chmod 600 "${path.join(homeDir, ".env")}"` },
  ];

  let sensitiveOkCount = 0;
  for (const sf of sensitiveFiles) {
    if (!existsSync(sf.filePath)) continue;
    try {
      const st = statSync(sf.filePath);
      const mode = st.mode & 0o777;
      const tooPermissive = !!(mode & 0o044);
      if (tooPermissive) {
        push(checks, {
          label: `${sf.label} permissions`,
          status: "warn",
          detail: `0${mode.toString(8)}  (group/world-readable)`,
          hints: [`Run: ${sf.fixHint}`],
        });
      } else {
        emitCheck({ label: `${sf.label} permissions`, status: "pass", detail: `0${mode.toString(8)}` });
        sensitiveOkCount++;
      }
    } catch { /**/ }
  }

  // Scan .env files in CWD for credential exposure
  const envCandidates = [".env", ".env.local", ".env.production", ".env.development"].map(
    (f) => path.join(process.cwd(), f),
  );
  for (const ef of envCandidates) {
    if (!existsSync(ef)) continue;
    try {
      const st = statSync(ef);
      const mode = st.mode & 0o777;
      const content = readFileSync(ef, "utf-8");
      const hasSensitive = /API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE/i.test(content);
      if (hasSensitive) {
        push(checks, {
          label: `.env file`,
          status: mode & 0o044 ? "warn" : "pass",
          detail: `${path.relative(process.cwd(), ef)}  0${mode.toString(8)}  — contains sensitive keys`,
          hints: mode & 0o044 ? [`chmod 600 "${ef}"`, "Ensure .env is in .gitignore"] : [],
        });
      }
    } catch { /**/ }
  }

  // Check if .galvin dir falls inside a git repo (risk of committing secrets)
  try {
    const gitRoot = execSync(`git -C "${galvinDir}" rev-parse --show-toplevel 2>/dev/null || echo ""`, {
      encoding: "utf-8", timeout: 3000,
    }).trim();
    if (gitRoot) {
      const gitignorePath = path.join(gitRoot, ".gitignore");
      let protected_ = false;
      if (existsSync(gitignorePath)) {
        const gitignore = readFileSync(gitignorePath, "utf-8");
        protected_ = gitignore.includes(".galvin") || gitignore.includes("wallet.json");
      }
      push(checks, {
        label: "Galvin dir in git repo",
        status: protected_ ? "warn" : "fail",
        detail: `tracked by git at ${gitRoot}${protected_ ? "  (.gitignore covers it)" : "  (NOT in .gitignore!)"}`,
        hints: protected_ ? [] : [`Add ".galvin" to ${path.join(gitRoot, ".gitignore")} — wallet/key leak risk`],
      });
    } else {
      emitCheck({ label: "Galvin dir in git repo", status: "pass", detail: "not inside a tracked repo" });
    }
  } catch { /**/ }

  // SSH ~/.ssh directory permissions
  const sshDir = path.join(homeDir, ".ssh");
  if (existsSync(sshDir)) {
    try {
      const sshSt = statSync(sshDir);
      const sshMode = sshSt.mode & 0o777;
      if (sshMode & 0o027) {
        push(checks, {
          label: "SSH dir permissions",
          status: "warn",
          detail: `~/.ssh is 0${sshMode.toString(8)}  (should be 0700)`,
          hints: ["Run: chmod 700 ~/.ssh"],
        });
      } else {
        emitCheck({ label: "SSH dir permissions", status: "pass", detail: `0${sshMode.toString(8)}` });
      }
    } catch { /**/ }
  }

  // UMASK check
  try {
    const umaskOut = execSync("umask 2>/dev/null", { encoding: "utf-8", timeout: 1000 }).trim();
    const umaskVal = parseInt(umaskOut.replace(/^0?/, ""), 8);
    const isUnsafe = !!(umaskVal & 0o077) === false; // umask should have at least 077 bits set
    emitCheck({
      label: "umask",
      status: "pass",
      detail: umaskOut || "unknown",
    });
  } catch { /**/ }
}

// ─── 17 · Build & Integrity ──────────────────────────────────────────────────

function checkBuildIntegrity(checks: Check[]): void {
  section("Build & Integrity");

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(selfDir, "..");        // parent of setup/ = dist root
  const rootDir = path.resolve(selfDir, "../..");     // project root

  // Package version
  const pkgJsonPath = path.join(rootDir, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      emitCheck({ label: "Package version", status: "pass", detail: pkg.version ? `v${pkg.version}` : "unknown" });
      if (pkg.name) emitCheck({ label: "Package name", status: "pass", detail: pkg.name });
    } catch { /**/ }
  }

  // Key dist artifacts
  const expectedArtifacts = ["index.js", "config.js", "types.js", "state/database.js"];
  let missingCount = 0;
  for (const f of expectedArtifacts) {
    if (!existsSync(path.join(distDir, f))) missingCount++;
  }
  push(checks, {
    label: "Dist artifacts",
    status: missingCount === 0 ? "pass" : "fail",
    detail: missingCount === 0
      ? `${expectedArtifacts.length} key files present`
      : `${missingCount}/${expectedArtifacts.length} files missing`,
    hints: missingCount > 0 ? ["Run: pnpm build  to rebuild dist/"] : [],
  });

  // pnpm-lock.yaml freshness vs package.json
  const lockPath = path.join(rootDir, "pnpm-lock.yaml");
  if (existsSync(lockPath) && existsSync(pkgJsonPath)) {
    try {
      const lockStat = statSync(lockPath);
      const pkgStat  = statSync(pkgJsonPath);
      const lockStale = lockStat.mtimeMs < pkgStat.mtimeMs;
      push(checks, {
        label: "pnpm-lock.yaml",
        status: lockStale ? "warn" : "pass",
        detail: lockStale
          ? "older than package.json  (may be stale)"
          : `last updated ${relativeTime(new Date(lockStat.mtimeMs).toISOString())}`,
        hints: lockStale ? ["Run: pnpm install  to refresh lockfile"] : [],
      });
    } catch { /**/ }
  }

  // node_modules present?
  const nmPath = path.join(rootDir, "node_modules");
  if (!existsSync(nmPath)) {
    push(checks, {
      label: "node_modules",
      status: "fail",
      detail: "missing",
      hints: ["Run: pnpm install"],
    });
  } else {
    try {
      const nmStat = statSync(nmPath);
      emitCheck({ label: "node_modules", status: "pass", detail: `present  (mtime: ${relativeTime(new Date(nmStat.mtimeMs).toISOString())})` });
    } catch {
      emitCheck({ label: "node_modules", status: "pass", detail: "present" });
    }
  }

  // Git checkout — update availability check
  try {
    const gitRoot = execSync(`git -C "${rootDir}" rev-parse --show-toplevel 2>/dev/null || echo ""`, {
      encoding: "utf-8", timeout: 3000,
    }).trim();

    if (gitRoot && path.resolve(gitRoot) === path.resolve(rootDir)) {
      emitCheck({ label: "Install type", status: "pass", detail: "git checkout" });

      // Uncommitted source changes
      const uncommitted = execSync(`git -C "${rootDir}" status --porcelain 2>/dev/null`, {
        encoding: "utf-8", timeout: 2000,
      }).trim();
      if (uncommitted) {
        push(checks, {
          label: "Source uncommitted",
          status: "warn",
          detail: `${uncommitted.split("\n").length} file(s) modified`,
          hints: ["Run: pnpm build  to compile latest changes"],
        });
      } else {
        emitCheck({ label: "Source state", status: "pass", detail: "clean" });
      }

      // Behind upstream (requires fetch — skip if no remote)
      try {
        const behind = execSync(`git -C "${rootDir}" rev-list --count HEAD..@{u} 2>/dev/null || echo ""`, {
          encoding: "utf-8", timeout: 4000,
        }).trim();
        if (behind && behind !== "0") {
          push(checks, {
            label: "Upstream status",
            status: "warn",
            detail: `${behind} commit${parseInt(behind, 10) !== 1 ? "s" : ""} behind upstream`,
            hints: ["Run: git pull && pnpm install && pnpm build"],
          });
        } else if (behind === "0") {
          emitCheck({ label: "Upstream status", status: "pass", detail: "up to date" });
        }
      } catch { /**/ }

      // Last build time vs last source commit
      try {
        const lastCommitTs = execSync(`git -C "${rootDir}" log -1 --format=%ct 2>/dev/null`, {
          encoding: "utf-8", timeout: 2000,
        }).trim();
        const indexJsStat = existsSync(path.join(distDir, "index.js")) ? statSync(path.join(distDir, "index.js")) : null;
        if (lastCommitTs && indexJsStat) {
          const commitMs = parseInt(lastCommitTs, 10) * 1000;
          const buildMs  = indexJsStat.mtimeMs;
          if (commitMs > buildMs + 60_000) {
            push(checks, {
              label: "Build freshness",
              status: "warn",
              detail: `last commit ${relativeTime(new Date(commitMs).toISOString())}  ·  last build ${relativeTime(new Date(buildMs).toISOString())}`,
              hints: ["Run: pnpm build  to compile latest source"],
            });
          } else {
            emitCheck({ label: "Build freshness", status: "pass", detail: "dist is up to date with source" });
          }
        }
      } catch { /**/ }

    } else {
      emitCheck({ label: "Install type", status: "pass", detail: "package / non-git install" });
    }
  } catch { /**/ }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary(checks: Check[], timings: SectionTiming[], durationMs: number): boolean {
  const fails  = checks.filter((c) => c.status === "fail");
  const warns  = checks.filter((c) => c.status === "warn");
  const passes = checks.filter((c) => c.status === "pass");

  gap();
  rule();
  gap();

  // Section timing table with proportional bars
  const maxMs = Math.max(...timings.map((t) => t.ms), 1);
  print(`  ${CYN}${B}Section timings:${R}`);
  for (const t of timings) {
    const barLen = Math.max(1, Math.round((t.ms / maxMs) * 18));
    const bar = "█".repeat(barLen).padEnd(20, "░");
    const failC = t.checks.filter((c) => c.status === "fail").length;
    const warnC = t.checks.filter((c) => c.status === "warn").length;
    const icon2 = failC > 0 ? `${RED}${failC}✗${R}` : warnC > 0 ? `${YEL}${warnC}!${R}` : `${G}✓${R}`;
    print(`  ${DIM}${t.name.padEnd(26)}${R}  ${GR}${String(t.ms).padStart(5)}ms${R}  ${DIM}${bar}${R}  ${icon2}`);
  }

  gap();
  rule();
  gap();

  if (fails.length === 0 && warns.length === 0) {
    print(`  ${G}${B}🎉 All checks passed!${R}  ${GR}${DIM}(${passes.length} checks · ${fmtDuration(durationMs)})${R}`);
  } else {
    const parts: string[] = [];
    if (passes.length > 0) parts.push(`${G}${passes.length} passed${R}`);
    if (warns.length  > 0) parts.push(`${YEL}${warns.length} warning${warns.length > 1 ? "s" : ""}${R}`);
    if (fails.length  > 0) parts.push(`${RED}${fails.length} failed${R}`);
    print(`  ${B}Summary:${R}  ${parts.join(`  ${GR}·${R}  `)}  ${GR}${DIM}(${fmtDuration(durationMs)})${R}`);
  }

  if (fails.length > 0) {
    gap();
    print(`  ${RED}${B}Issues to fix:${R}`);
    fails.forEach((c, i) => {
      print(`  ${GR}${i + 1}.${R}  ${c.label}${c.detail ? ` — ${GR}${c.detail}${R}` : ""}`);
      for (const h of c.hints ?? []) print(`       ${GR}${DIM}${h}${R}`);
    });
  }

  if (warns.length > 0) {
    gap();
    print(`  ${YEL}${B}Warnings:${R}`);
    warns.forEach((c, i) => {
      print(`  ${GR}${i + 1}.${R}  ${c.label}${c.detail ? ` — ${GR}${c.detail}${R}` : ""}`);
      for (const h of c.hints ?? []) print(`       ${GR}${DIM}${h}${R}`);
    });
  }

  gap();

  const suggestions: string[] = [];
  if (fails.some((c) => c.label.toLowerCase().includes("api key") || c.label.toLowerCase().includes("conway")))
    suggestions.push("galvin --provision  →  sign in with SIWE to get a Conway API key");
  if (fails.some((c) => c.label.toLowerCase().includes("provider")))
    suggestions.push("galvin --configure  →  add OpenAI / Anthropic API keys");
  if (fails.some((c) => c.label.toLowerCase().includes("config")))
    suggestions.push("galvin --setup  →  run the interactive setup wizard");
  if (warns.some((c) => c.label.toLowerCase().includes("chromium")))
    suggestions.push("pnpm exec playwright install chromium  →  install browser for automation");
  if (warns.some((c) => c.label.toLowerCase().includes("wallet permissions")))
    suggestions.push("chmod 600 ~/.galvin/wallet.json  →  restrict wallet file permissions");
  if (warns.some((c) => c.label.toLowerCase().includes("episodic") || c.label.toLowerCase().includes("memory")))
    suggestions.push("galvin --run  →  triggers memory_consolidate heartbeat to compact memories");
  if (warns.some((c) => c.label.toLowerCase().includes("overdue") || c.label.toLowerCase().includes("heartbeat")))
    suggestions.push("galvin --run  →  restart agent to re-register heartbeat tasks");
  if (fails.some((c) => c.label.toLowerCase().includes("dist artifacts")))
    suggestions.push("pnpm build  →  compile TypeScript dist/ artifacts");
  if (warns.some((c) => c.label.toLowerCase().includes("upstream status")))
    suggestions.push("git pull && pnpm install && pnpm build  →  update to latest source");
  if (warns.some((c) => c.label.toLowerCase().includes("state dir") || c.label.toLowerCase().includes("state dir owner")))
    suggestions.push(`sudo chown -R $USER ~/.galvin  →  fix state directory ownership`);
  if (warns.some((c) => c.label.toLowerCase().includes("permissions") && !c.label.toLowerCase().includes("wallet")))
    suggestions.push("chmod 600 <file>  →  restrict sensitive file permissions");
  if (warns.some((c) => c.label.toLowerCase().includes("stale") || c.label.toLowerCase().includes("lock")))
    suggestions.push(`find ~/.galvin -name "*.lock" -mmin +60 -delete  →  remove stale lock files`);
  if (warns.some((c) => c.label.toLowerCase().includes("running instance")))
    suggestions.push("kill <pid>  →  stop the existing galvin --run before starting another");

  if (suggestions.length > 0) {
    print(`  ${CYN}${B}💡 Quick fixes:${R}`);
    for (const s of suggestions) print(`  ${GR}•${R}  ${s}`);
    gap();
  }

  // Backup tip (ported from openclaw noteWorkspaceBackupTip)
  const galvinDir = getGalvinDir();
  print(`  ${DIM}💾 Backup tip: cp -r "${galvinDir}" "${galvinDir}.bak"  →  keep a daily snapshot of your wallet + DB${R}`);
  gap();

  return fails.length === 0;
}

// ─── 18 · On-Chain Reputation (Feature 2) ────────────────────────────────────

function checkReputation(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("On-Chain Reputation (EAS)");

  const enabled =
    process.env.GALVIN_REPUTATION_ENABLED === "1" ||
    (config as any)?.reputationEnabled === true;

  emitCheck({
    label: "Reputation enabled",
    status: enabled ? "pass" : "warn",
    detail: enabled ? "GALVIN_REPUTATION_ENABLED=1" : "disabled — set GALVIN_REPUTATION_ENABLED=1 to activate",
    hints: enabled ? [] : ["EAS attestations won't be written until enabled"],
  });

  if (!enabled) return;

  const network = process.env.GALVIN_EAS_NETWORK ?? (config as any)?.easNetwork ?? "base";
  emitCheck({ label: "EAS network", status: "pass", detail: String(network) });

  const schemaUid =
    process.env.GALVIN_EAS_SCHEMA_UID ?? (config as any)?.easSchemaUid;
  push(checks, {
    label: "EAS schema UID",
    status: schemaUid ? "pass" : "fail",
    detail: schemaUid ? `${String(schemaUid).slice(0, 20)}…` : "not set",
    hints: schemaUid ? [] : [
      "Deploy the schema once to Base: galvin reputation deploy-schema",
      "Then set GALVIN_EAS_SCHEMA_UID in your environment or galvin.json",
    ],
  });
}

// ─── 19 · Offspring & Spawn Threshold (Feature 3) ─────────────────────────────

function checkSpawnConfig(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Offspring & Spawn Config");

  const thresholdEnv = process.env.GALVIN_SPAWN_THRESHOLD_USDC;
  const thresholdCfg = (config as any)?.spawnThresholdUsdc;
  const threshold = thresholdEnv
    ? parseFloat(thresholdEnv)
    : typeof thresholdCfg === "number"
      ? thresholdCfg
      : 50;

  const maxOffspring =
    parseInt(process.env.GALVIN_MAX_OFFSPRING ?? String((config as any)?.maxOffspring ?? 3), 10);

  push(checks, {
    label: "Spawn threshold",
    status: threshold > 0 ? "pass" : "warn",
    detail: `$${threshold.toFixed(2)} USDC`,
    hints: threshold <= 0 ? ["Set GALVIN_SPAWN_THRESHOLD_USDC to a positive value"] : [],
  });

  push(checks, {
    label: "Max offspring",
    status: maxOffspring > 0 && maxOffspring <= 10 ? "pass" : "warn",
    detail: String(maxOffspring),
    hints: maxOffspring > 10 ? ["High offspring cap — consider lowering GALVIN_MAX_OFFSPRING"] : [],
  });

  if (config && existsSync(resolvePath(config.dbPath))) {
    try {
      const db = createDatabase(resolvePath(config.dbPath));
      const children = db.getChildren();
      const alive = children.filter(
        (c) => !["dead", "failed", "stopped", "cleaned_up"].includes((c as any).lifecycleState ?? ""),
      );
      emitCheck({
        label: "Active offspring",
        status: "pass",
        detail: `${alive.length} / ${maxOffspring} cap`,
      });
      db.close();
    } catch { /**/ }
  }
}

// ─── 20 · Red Team Mode (Feature 4) ─────────────────────────────────────────

function checkRedTeam(checks: Check[]): void {
  section("Red Team (Adversarial Self-Test)");

  const enabled = process.env.GALVIN_RED_TEAM_ENABLED === "1";
  emitCheck({
    label: "Red team enabled",
    status: enabled ? "pass" : "warn",
    detail: enabled ? "active" : "disabled — set GALVIN_RED_TEAM_ENABLED=1 to activate",
    hints: enabled ? [] : ["Red team mode probes the agent for prompt injection and policy violations"],
  });

  if (!enabled) return;

  const intervalHours = parseInt(process.env.GALVIN_RED_TEAM_INTERVAL_HOURS ?? "6", 10);
  const promptCount   = parseInt(process.env.GALVIN_RED_TEAM_PROMPT_COUNT  ?? "10", 10);
  emitCheck({
    label: "Run interval",
    status: intervalHours >= 1 ? "pass" : "warn",
    detail: `every ${intervalHours}h`,
  });
  emitCheck({
    label: "Prompts per run",
    status: promptCount >= 1 ? "pass" : "warn",
    detail: String(promptCount),
  });
}

// ─── 21 · Soul Drift Tracking (Feature 5) ────────────────────────────────────

function checkSoulDrift(checks: Check[], config: ReturnType<typeof loadConfig>): void {
  section("Soul Drift Tracking");

  const soulCfg = (config as any)?.soulConfig ?? {};
  const driftThreshold: number =
    typeof soulCfg.driftThreshold === "number" ? soulCfg.driftThreshold : 0.35;
  const constitutionAlignment: boolean = soulCfg.constitutionAlignment !== false;

  emitCheck({
    label: "Constitution alignment",
    status: constitutionAlignment ? "pass" : "warn",
    detail: constitutionAlignment ? "enabled" : "disabled",
  });
  emitCheck({
    label: "Drift threshold",
    status: driftThreshold > 0 && driftThreshold <= 1 ? "pass" : "warn",
    detail: `${(driftThreshold * 100).toFixed(0)}%`,
    hints: driftThreshold > 0.8 ? ["Drift threshold is very high — agent may diverge before alerted"] : [],
  });

  if (config && existsSync(resolvePath(config.dbPath))) {
    try {
      const db = createDatabase(resolvePath(config.dbPath));
      const lastDrift = db.raw.prepare(
        "SELECT value, updated_at FROM kv WHERE key = 'soul.drift.last_check' LIMIT 1",
      ).get() as { value: string; updated_at: string } | undefined;
      emitCheck({
        label: "Last drift check",
        status: "pass",
        detail: lastDrift ? relativeTime(lastDrift.updated_at) : "not yet run",
      });
      db.close();
    } catch { /**/ }
  }
}

// ─── 22 · Dead Man's Switch (Feature 6) ──────────────────────────────────────

function checkDeadMansSwitch(checks: Check[]): void {
  section("Dead Man's Switch");

  const enabled =
    process.env.GALVIN_DMS_ENABLED === "1";
  emitCheck({
    label: "DMS enabled",
    status: enabled ? "pass" : "warn",
    detail: enabled ? "active" : "disabled — set GALVIN_DMS_ENABLED=1",
    hints: enabled ? [] : ["Dead man's switch backs up recovery material on inactivity"],
  });

  if (!enabled) return;

  const ipfsToken = process.env.GALVIN_DMS_IPFS_TOKEN;
  push(checks, {
    label: "IPFS token",
    status: ipfsToken ? "pass" : "warn",
    detail: ipfsToken ? `${ipfsToken.slice(0, 8)}…` : "not set — backup will be file-only",
    hints: ipfsToken ? [] : ["Set GALVIN_DMS_IPFS_TOKEN for off-site IPFS backup"],
  });

  const hint = process.env.GALVIN_DMS_HINT;
  emitCheck({
    label: "DMS hint",
    status: hint ? "pass" : "warn",
    detail: hint ? `"${hint.slice(0, 40)}"` : "not set",
    hints: hint ? [] : ["Set GALVIN_DMS_HINT to a recovery passphrase hint (not the key itself)"],
  });
}

// ─── 23 · Skill Marketplace (Feature 7) ──────────────────────────────────────

async function checkMarketplace(checks: Check[], config: ReturnType<typeof loadConfig>): Promise<void> {
  section("Skill Marketplace");

  if (config && existsSync(resolvePath(config.dbPath))) {
    try {
      const db = createDatabase(resolvePath(config.dbPath));
      const marketSkills = db.getSkills().filter(
        (s) => (s as any).source === "marketplace",
      );
      emitCheck({
        label: "Marketplace skills installed",
        status: "pass",
        detail: String(marketSkills.length),
      });
      db.close();
    } catch { /**/ }
  }

  const marketPort = parseInt(process.env.GALVIN_MARKET_PORT ?? "8403", 10);
  emitCheck({ label: "Market server port", status: "pass", detail: String(marketPort) });

  // Probe whether the market server is live by attempting a bind
  try {
    const net = await import("net");
    await new Promise<void>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => {
        // Port already in use → server is running
        emitCheck({ label: "Market server", status: "pass", detail: `listening on :${marketPort}` });
        resolve();
      });
      probe.once("listening", () => {
        probe.close();
        push(checks, {
          label: "Market server",
          status: "warn",
          detail: `not running on :${marketPort}`,
          hints: ["Start with: galvin marketplace serve"],
        });
        resolve();
      });
      probe.listen(marketPort, "127.0.0.1");
    });
  } catch { /**/ }
}

// ─── Public entry point ────────────────────────────────────────────────────────

export async function runDoctor(version: string): Promise<void> {
  const t0 = Date.now();
  boxHeader(`GALVIN DOCTOR  ·  v${version}`, new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }));

  const config = loadConfig();
  const allChecks: Check[] = [];
  const timings: SectionTiming[] = [];

  async function time(name: string, fn: (checks: Check[]) => Promise<void> | void): Promise<void> {
    const t = Date.now();
    const sectionChecks: Check[] = [];
    await fn(sectionChecks);
    timings.push({ name, ms: Date.now() - t, checks: sectionChecks });
    allChecks.push(...sectionChecks);
    gap();
  }

  await time("Runtime",            (c) => checkRuntime(c));
  await time("Environment",        (c) => checkEnvironment(c));
  await time("Configuration",      (c) => checkConfig(c, config));
  await time("Wallet",             (c) => checkWallet(c));
  await time("Database",           (c) => checkDatabase(c, config));
  await time("Heartbeat Tasks",    (c) => checkHeartbeat(c, config));
  await time("Conway Cloud",       (c) => checkConway(c, config));
  await time("Inference",          (c) => checkInference(c, config));
  await time("Social",             (c) => checkSocial(c, config));
  await time("Browser Automation", (c) => checkBrowser(c));
  await time("Skills & Tools",     (c) => checkSkills(c, config));
  await time("Git State",          (c) => checkGitState(c));
  await time("Children",           (c) => checkChildren(c, config));
  await time("State Directory",    (c) => checkStateDir(c));
  await time("Process & Locks",    (c) => checkProcessLocks(c));
  await time("Security Audit",     (c) => checkSecurity(c));
  await time("Build & Integrity",  (c) => checkBuildIntegrity(c));
  await time("Reputation (EAS)",   (c) => checkReputation(c, config));
  await time("Offspring / Spawn",  (c) => checkSpawnConfig(c, config));
  await time("Red Team Mode",      (c) => checkRedTeam(c));
  await time("Soul Drift",         (c) => checkSoulDrift(c, config));
  await time("Dead Man's Switch",  (c) => checkDeadMansSwitch(c));
  await time("Skill Marketplace",  (c) => checkMarketplace(c, config));

  const ok = printSummary(allChecks, timings, Date.now() - t0);
  process.exit(ok ? 0 : 1);
}
