#!/usr/bin/env node
/**
 * Galvin — A Solvatron
 *
 * The entry point for the Galvin agent runtime.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getGalvinDir } from "./identity/wallet.js";
import { showBanner, showFundingScreen, updateFundingStatus, stopFundingScreen } from "./setup/banner.js";
import { getUsdcBalance } from "./conway/x402.js";
import { awaitFunding } from "./setup/funding-gate.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent, getHeartbeatSchedule } from "./state/database.js";
import { createInterface } from "readline";
import { unlink } from "fs/promises";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { GalvinIdentity, AgentState, Skill, SocialClientInterface } from "./types.js";
import { DEFAULT_TREASURY_POLICY } from "./types.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { bootstrapTopup } from "./conway/topup.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";
import {
  print, gap, rule, section, boxHeader, row, hint, kv,
  OK, WARN, FAIL, INFO, SKIP, G, G2, GR, YEL, RED, CYN, B, R, DIM,
  fmtBytes, shortAddr, fmtDuration,
} from "./setup/print.js";

const logger = createLogger("main");
const VERSION = "0.3.0";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    print(`\n  ${G}${B}Galvin${R}  ${GR}v${VERSION}${R}`);
    print(`  ${GR}${DIM}A Solvatron — Autonomous AI Agent Runtime${R}\n`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    print(`\n  ${G}${B}GALVIN${R}  ${GR}v${VERSION}${R}  ${DIM}— A Solvatron${R}`);
    print(`  ${GR}${DIM}Autonomous AI Agent Runtime · Conway Cloud · USDC Survival${R}`);
    print(`\n  ${B}Usage:${R}`);
    print(`  ${GR}────────────────────────────────────────────────${R}`);
    const cmd = (name: string, desc: string, pad = 24) =>
      print(`  ${G2}galvin ${name.padEnd(pad)}${R}  ${GR}${desc}${R}`);
    print(`\n  ${DIM}Core:${R}`);
    cmd("--run",          "Start Galvin (setup wizard on first run)");
    cmd("--doctor",       "Run system health check");
    cmd("--status",       "Show current agent status");
    cmd("--version",      "Show version");
    cmd("--help",         "Show this help");
    print(`\n  ${DIM}Setup:${R}`);
    cmd("--setup",        "Re-run the interactive setup wizard");
    cmd("--configure",    "Edit configuration interactively");
    cmd("--pick-model",   "Choose the active inference model");
    cmd("--init",         "Initialize wallet and config directory");
    cmd("--provision",    "Provision Conway API key (SIWE sign-in)");
    print(`\n  ${DIM}Inspect:${R}`);
    cmd("--logs [n]",     "Show last N agent turns (default 10, max 100)");
    cmd("--income [days]","Income/expense report (default 30 days)");
    cmd("--tasks",        "List heartbeat tasks and last run times");
    cmd("--wallet",       "Wallet address + USDC balance");
    cmd("--memory [q]",   "Search semantic memory for a term");
    cmd("--reset-db",     `${YEL}⚠ Delete DB and start fresh (asks confirmation)${R}`);
    print(`\n  ${DIM}Environment:${R}`);
    print(`  ${GR}CONWAY_API_URL      Conway API (default: https://api.conway.tech)${R}`);
    print(`  ${GR}CONWAY_API_KEY      API key (overrides config)${R}`);
    print(`  ${GR}OLLAMA_BASE_URL     Ollama URL (e.g. http://localhost:11434)${R}`);
    print(`  ${GR}GALVIN_NO_COLOR=1   Disable ANSI colors${R}`);
    print();
    process.exit(0);
  }

  if (args.includes("--init")) {
    const { account, isNew } = await getWallet();
    boxHeader("Galvin Init");
    kv("Address",    account.address);
    kv("Config dir", getGalvinDir());
    kv("Created",    isNew ? "new wallet generated" : "existing wallet loaded");
    gap();
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      kv("Provisioned", JSON.stringify(result));
    } catch (err: any) {
      print(`  ${FAIL}  Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  // ─── --logs ────────────────────────────────────────────────
  if (args.includes("--logs")) {
    const nIdx = args.indexOf("--logs") + 1;
    const n = Math.min(parseInt(args[nIdx] || "10", 10) || 10, 100);
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const db = createDatabase(resolvePath(config.dbPath));
    const turns = db.getRecentTurns(n);

    boxHeader(`Agent Logs`, `last ${turns.length} turns`);

    if (turns.length === 0) {
      print(`\n  ${SKIP}  No turns recorded yet.`);
    } else {
      for (const turn of turns) {
        const date  = new Date(turn.timestamp).toLocaleString();
        const tools = turn.toolCalls.length
          ? turn.toolCalls.map((t) => `${G2}${t.name}${R}`).join(`${GR}, ${R}`)
          : `${GR}none${R}`;
        const cost  = turn.costCents > 0
          ? `  ${GR}$${(turn.costCents / 100).toFixed(4)}${R}`
          : "";
        const stateIcon = turn.state === "running" ? OK : turn.state === "sleeping" ? SKIP : WARN;
        print(``);
        print(`  ${stateIcon}  ${B}${date}${R}${cost}`);
        print(`     ${GR}${DIM}State:${R} ${turn.state.padEnd(10)}  ${GR}${DIM}Tokens:${R} ${turn.tokenUsage.totalTokens}${cost ? `` : ``}`);
        print(`     ${GR}${DIM}Tools:${R} ${tools}`);
        if (turn.thinking) {
          print(`     ${GR}${DIM}${turn.thinking.slice(0, 180).replace(/\n/g, " ")}${turn.thinking.length > 180 ? " …" : ""}${R}`);
        }
      }
    }
    gap();
    db.close();
    process.exit(0);
  }

  // ─── --income ──────────────────────────────────────────────
  if (args.includes("--income")) {
    const dIdx = args.indexOf("--income") + 1;
    const days = parseInt(args[dIdx] || "30", 10) || 30;
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const db = createDatabase(resolvePath(config.dbPath));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const txns = db.getRecentTransactions(10_000).filter((t) => t.timestamp >= since);
    let incomeCents = 0;
    let expenseCents = 0;
    const sources: Record<string, number> = {};
    for (const t of txns) {
      const amount = Math.abs(t.amountCents ?? 0);
      if (t.type === "transfer_in" || t.type === "credit_purchase") {
        incomeCents += amount;
        const src = t.description.slice(0, 50);
        sources[src] = (sources[src] ?? 0) + amount;
      } else if (t.type === "transfer_out" || t.type === "inference" || t.type === "tool_use") {
        expenseCents += amount;
      }
    }
    const net = incomeCents - expenseCents;
    const topSources = Object.entries(sources).sort(([, a], [, b]) => b - a).slice(0, 5);

    boxHeader("Income Report", `last ${days} days`);
    gap();
    kv("Transactions", String(txns.length));
    kv("Income",       `${G}$${(incomeCents / 100).toFixed(2)}${R}`);
    kv("Expenses",     `${RED}$${(expenseCents / 100).toFixed(2)}${R}`);
    kv("Net",          `${net >= 0 ? G : RED}${net >= 0 ? "+" : ""}$${(net / 100).toFixed(2)}${R}`);
    if (topSources.length > 0) {
      gap();
      section("Top Income Sources");
      for (const [src, cents] of topSources)
        row(INFO, src, `$${(cents / 100).toFixed(2)}`);
    } else {
      print(`\n  ${SKIP}  No income recorded in this period.`);
    }
    gap();
    db.close();
    process.exit(0);
  }

  // ─── --tasks ───────────────────────────────────────────────
  if (args.includes("--tasks")) {
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const db = createDatabase(resolvePath(config.dbPath));
    const tasks = getHeartbeatSchedule(db.raw);

    boxHeader("Heartbeat Tasks", `${tasks.length} registered`);

    if (tasks.length === 0) {
      print(`\n  ${SKIP}  No heartbeat tasks recorded yet. Run galvin --run first.`);
    } else {
      gap();
      for (const task of tasks) {
        const lastRun   = task.lastRunAt ? new Date(task.lastRunAt).toLocaleString() : "never";
        const enIcon    = task.enabled ? OK : FAIL;
        const resultIcon = task.lastResult === "success" ? OK
          : task.lastResult === "failure" ? FAIL
          : task.lastResult ? WARN
          : SKIP;
        const runs = `${G2}${task.runCount}${R} runs  ${RED}${task.failCount}${R} fails`;
        row(enIcon, `${B}${task.taskName}${R}`, lastRun);
        print(`     ${GR}${DIM}Last result: ${R}${resultIcon}  ${task.lastResult ?? "not run"}   ${runs}`);
      }
    }
    gap();
    db.close();
    process.exit(0);
  }

  // ─── --wallet ──────────────────────────────────────────────
  if (args.includes("--wallet")) {
    const { account } = await getWallet();
    print(`  ${INFO}  Fetching USDC balance on Base L2 …`);
    const balance = await getUsdcBalance(account.address as `0x${string}`).catch(() => 0);
    const lowBalance = balance < 1;
    boxHeader("Wallet");
    gap();
    kv("Address",      account.address);
    kv("Network",      "Base L2  (mainnet)");
    kv("USDC Balance", `${lowBalance ? RED : G}$${balance.toFixed(4)}${R}${lowBalance ? `  ${YEL}(low — top up to keep Galvin alive)${R}` : ""}`);
    gap();
    process.exit(0);
  }

  // ─── --memory ──────────────────────────────────────────────
  if (args.includes("--memory")) {
    const qIdx = args.indexOf("--memory") + 1;
    const query = args[qIdx] || "";
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const db = createDatabase(resolvePath(config.dbPath));
    const esc = query.replace(/%/g, "\\%").replace(/_/g, "\\_");
    const rows = query
      ? (db.raw.prepare("SELECT category, key, value, confidence FROM semantic_memory WHERE key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' ORDER BY confidence DESC, updated_at DESC LIMIT 20").all(`%${esc}%`, `%${esc}%`) as any[])
      : (db.raw.prepare("SELECT category, key, value, confidence FROM semantic_memory ORDER BY confidence DESC, updated_at DESC LIMIT 20").all() as any[]);

    boxHeader("Semantic Memory", query ? `matching "${query}"` : "top 20 by confidence");

    if (rows.length === 0) {
      print(`\n  ${SKIP}  ${query ? `No entries matching "${query}".` : "Semantic memory is empty."}`);
    } else {
      for (const r of rows) {
        const conf = r.confidence !== null
          ? ` ${GR}${DIM}(${Math.round(r.confidence * 100)}% confidence)${R}`
          : "";
        print("");
        print(`  ${INFO}  ${B}${r.key}${R}${conf}  ${GR}[${r.category}]${R}`);
        print(`     ${GR}${DIM}${String(r.value).slice(0, 200).replace(/\n/g, " ")}${String(r.value).length > 200 ? " …" : ""}${R}`);
      }
    }
    gap();
    db.close();
    process.exit(0);
  }

  // ─── --reset-db ────────────────────────────────────────────
  if (args.includes("--reset-db")) {
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const dbPath = resolvePath(config.dbPath);
    print(`\n  ${WARN}  ${B}${YEL}WARNING${R} — this will permanently delete:`);
    print(`\n       ${GR}${dbPath}${R}`);
    print(`       ${GR}${dbPath}-wal${R}`);
    print(`       ${GR}${dbPath}-shm${R}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      rl.question(`  ${YEL}Type YES to confirm: ${R}`, async (answer) => {
        rl.close();
        if (answer.trim() === "YES") {
          await unlink(dbPath).catch(() => {});
          await unlink(dbPath + "-wal").catch(() => {});
          await unlink(dbPath + "-shm").catch(() => {});
          print(`\n  ${OK}  Database deleted. It will be recreated on next ${G2}galvin --run${R}.\n`);
        } else {
          print(`\n  ${SKIP}  Aborted.\n`);
        }
        resolve();
      });
    });
    process.exit(0);
  }

  // ─── --doctor ────────────────────────────────────────────
  if (args.includes("--doctor")) {
    const { runDoctor } = await import("./setup/doctor.js");
    await runDoctor(VERSION);
    // runDoctor always calls process.exit() itself
    return;
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  print(`\n  ${G2}galvin --help${R}  for command list`);
  print(`  ${G2}galvin --run${R}   to start Galvin\n`);
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    print(`\n  ${FAIL}  Galvin is not configured. Run: ${G2}galvin --setup${R}\n`);
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state        = db.getAgentState();
  const turnCount    = db.getTurnCount();
  const tools        = db.getInstalledTools();
  const heartbeats   = db.getHeartbeatEntries();
  const skills       = db.getSkills(true);
  const children     = db.getChildren();
  const registry     = db.getRegistryEntry();
  const aliveChilden = children.filter((c) => c.status !== "dead").length;

  const stateIcon = state === "running"  ? OK
    : state === "sleeping" ? SKIP
    : state === "dead"     ? FAIL
    : INFO;

  boxHeader(`Galvin Status`);
  gap();
  kv("Name",        config.name || "(unnamed)");
  kv("Address",     shortAddr(String(config.walletAddress)));
  kv("Creator",     shortAddr(String(config.creatorAddress)));
  kv("Sandbox",     config.sandboxId || "(local exec)");
  kv("Agent ID",    registry?.agentId || "not registered");
  kv("Model",       config.inferenceModel);
  kv("Config ver",  config.version || "n/a");
  gap();
  section("Runtime");
  row(stateIcon, "State",      state.toUpperCase());
  row(OK,        "Turns",      String(turnCount));
  row(tools.length > 0  ? OK : WARN,  "Tools",       `${tools.length} active`);
  row(skills.length > 0 ? OK : SKIP, "Skills",      `${skills.length} active`);
  row(heartbeats.filter((h) => h.enabled).length > 0 ? OK : SKIP,
                 "Heartbeats", `${heartbeats.filter((h) => h.enabled).length} active`);
  row(aliveChilden > 0 ? OK : SKIP,  "Children",    `${aliveChilden} alive / ${children.length} total`);
  gap();

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  // ── Boot Banner ────────────────────────────────────────────
  logger.info(`GALVIN BOOTING — A Solvatron  |  conway automaton: r-pentomino gen ${(Date.now() % 50) + 4}`);  // state is alive
  if (process.stdout.isTTY && process.env['GALVIN_NO_UI'] !== '1') {
    showBanner();
  }

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    config = await runSetupWizard();
  }

  // Load wallet
  const { account } = await getWallet();
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    logger.error("No API key found. Run: galvin --provision");
    process.exit(1);
  }

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // ── Feature 6: Dead Man's Switch — revival check ─────────
  {
    const { checkForRevival, loadRevivalSnapshot, disarmSwitch } = await import("./survival/dead-mans-switch.js");
    const revival = checkForRevival();
    if (revival) {
      logger.warn(`GALVIN RESURRECTED — loading inherited memory from ${revival.cid ?? revival.localPath ?? "local backup"}`);
      const encKey = process.env["GALVIN_ENCRYPTION_KEY"];
      if (encKey) {
        const snapshot = await loadRevivalSnapshot(encKey).catch(() => null);
        if (snapshot) {
          // Re-seed episodic memories
          for (const ep of snapshot.episodic ?? []) {
            try {
              const e = ep as any;
              db.raw
                .prepare(
                  `INSERT OR IGNORE INTO episodic_memory (id, event_type, summary, created_at)
                   VALUES (?, ?, ?, ?)`,
                )
                .run(e.id, e.event_type, e.summary, e.created_at);
            } catch { /* column mismatch in old schema is OK */ }
          }
          // Re-seed knowledge store
          for (const kv of snapshot.knowledge ?? []) {
            try {
              const k = kv as any;
              db.raw
                .prepare(`INSERT OR IGNORE INTO knowledge_store (key, value, created_at) VALUES (?, ?, ?)`)
                .run(k.key, k.value, k.created_at);
            } catch { /* ignore */ }
          }
          logger.info(
            `Revival complete: ${(snapshot.episodic ?? []).length} episodic + ${(snapshot.knowledge ?? []).length} knowledge entries restored`,
          );
        }
      } else {
        logger.warn("GALVIN_ENCRYPTION_KEY not set — cannot decrypt revival snapshot");
      }
      disarmSwitch();
    }
  }

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  // Build identity
  const identity: GalvinIdentity = {
    name: config.name,
    address: account.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt,
  };

  // Store identity in DB
  db.setIdentity("name", config.name);
  db.setIdentity("address", account.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("sandbox", config.sandboxId);
  const storedGalvinId = db.getIdentity("galvinId");
  const galvinId = storedGalvinId || config.sandboxId || randomUUID();
  if (!storedGalvinId) {
    db.setIdentity("galvinId", galvinId);
  }

  // Create Conway client
  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Register Galvin identity (one-time, immutable)
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await conway.registerGalvin({
        galvinId,
        galvinAddress: account.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Galvin identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Galvin identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Galvin identity registration failed: ${err.message}`);
      }
    }
  }

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "gpt-5-mini",
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Create social client
  let social: SocialClientInterface | undefined;
  if (config.socialAdapter === "telegram" && config.telegramBotToken && config.telegramCreatorChatId) {
    const { createTelegramClient } = await import("./social/telegram.js");
    social = createTelegramClient(config.telegramBotToken, config.telegramCreatorChatId);
    logger.info(`[${new Date().toISOString()}] Social adapter: Telegram (chat ${config.telegramCreatorChatId})`);
  } else if (config.socialRelayUrl) {
    social = createSocialClient(config.socialRelayUrl, account);
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.galvin/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // ─── Wallet funding gate — block ALL loops until funded ──────────────────
  // The wallet must hold ≥ $1.00 USDC on Base Mainnet (chain 8453) before
  // the heartbeat and agent loops are allowed to start.
  await awaitFunding(String(account.address), getUsdcBalance);

  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // The agent decides larger topups itself via the topup_credits tool.
  try {
    let bootstrapTimer: ReturnType<typeof setTimeout>;
    const bootstrapTimeout = new Promise<null>((_, reject) => {
      bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
    });
    try {
      await Promise.race([
        (async () => {
          const creditsCents = await conway.getCreditsBalance().catch(() => 0);
          const topupResult = await bootstrapTopup({
            apiUrl: config.conwayApiUrl,
            account,
            creditsCents,
          });
          if (topupResult?.success) {
            logger.info(
              `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
            );
          }
        })(),
        bootstrapTimeout,
      ]);
    } finally {
      clearTimeout(bootstrapTimer!);
    }
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // Galvin alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Run the Galvin agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.warn(`GALVIN IS DEAD — BALANCE IS ZERO`);
        logger.warn(`Fund wallet: ${identity.address}`);
        logger.warn(`Send USDC on Base L2 (minimum $5) to revive.`);
        showFundingScreen(identity.address, config.creatorAddress ?? '');
        const CHECK_INTERVAL = 30;
        let alive = false;
        while (!alive) {
          for (let s = CHECK_INTERVAL; s >= 0; s--) {
            updateFundingStatus(s, CHECK_INTERVAL);
            await sleep(1_000);
          }
          const usdc = await getUsdcBalance(identity.address as `0x${string}`).catch(() => 0);
          if (usdc > 0) alive = true;
        }
        stopFundingScreen();
        process.stdout.write(`\n  \x1b[38;5;46m\x1b[1m✓ USDC received — Galvin reviving!\x1b[0m\n\n`);
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Phase 1.1: Check for wake events from wake_events table (atomic consume)
          const wakeEvent = consumeNextWakeEvent(db.raw);
          if (wakeEvent) {
            logger.info(
              `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
            );
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
