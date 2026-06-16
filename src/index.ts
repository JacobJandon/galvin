#!/usr/bin/env node
/**
 * Galvin — A Solvatron
 *
 * The entry point for the Galvin agent runtime.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import { getWallet, getGalvinDir, backupWallet, exportWalletKey, importWallet } from "./identity/wallet.js";
import { showBanner, showFundingScreen, updateFundingStatus, stopFundingScreen } from "./setup/banner.js";
import { getUsdcBalance } from "./conway/x402.js";
import { awaitFunding } from "./setup/funding-gate.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import fs from "fs";
import path from "path";
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
import { installDefaultSkills } from "./setup/defaults.js";
import { initStateRepo } from "./git/state-versioning.js";
// Social adapter now resolved via ./social/registry.js (createSocialAdapter)
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
import { startGateway, type GatewayServer } from "./gateway/index.js";
import { getRunningAgent, removeLock, checkAgentLive, probeGateway } from "./gateway/lock.js";

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
    cmd("--chat",         "Chat with Galvin in the terminal");
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
    cmd("--fund",         "Show funding QR + wait for USDC deposit (alias: --qr)");
    cmd("--export-wallet", "Print the private key for OFF-machine backup (keep it safe!)");
    cmd("--backup-wallet", "Copy the wallet file to a backup [optional path]");
    cmd("--import-wallet", "Restore a wallet from a 0x private key [--force]");
    cmd("--trust",        "Show this agent's verifiable trust record (registry V1)");
    cmd("--honeypot",     "Check if a GitHub repo/bounty is a honeypot <url>");
    cmd("--bounties",     "List queued bounty candidates");
    cmd("--verify-vc",    "Verify a Verifiable Credential <file|json>");
    cmd("--prove-owner",  "Issue an ownership challenge for the owner to sign");
    cmd("--verify-owner", "Verify the owner's signature <0x-signature>");
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

  // ─── --backup-wallet [path] ────────────────────────────────
  if (args.includes("--backup-wallet")) {
    const i = args.indexOf("--backup-wallet");
    const dest = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
    try {
      const p = backupWallet(dest);
      print(`  ${OK}  Wallet backed up → ${p}`);
      print(`  ${YEL}For true safety also run ${B}galvin --export-wallet${R}${YEL} and store the key OFF this machine.${R}`);
    } catch (e) {
      print(`  ${FAIL}  ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }

  // ─── --export-wallet (prints PRIVATE KEY for off-machine backup) ──
  if (args.includes("--export-wallet")) {
    try {
      const { address, privateKey } = exportWalletKey();
      print(`\n  ${YEL}${B}⚠  PRIVATE KEY — anyone with this controls the wallet and its funds.${R}`);
      print(`  ${YEL}Store it in a password manager / write it down OFF this machine. Never paste it online or share it.${R}\n`);
      print(`  Address:     ${address}`);
      print(`  Private key: ${privateKey}\n`);
    } catch (e) {
      print(`  ${FAIL}  ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }

  // ─── --import-wallet <0x-key> [--force] ────────────────────
  if (args.includes("--import-wallet")) {
    const i = args.indexOf("--import-wallet");
    const key = args[i + 1];
    if (!key || key.startsWith("--")) {
      print(`  ${FAIL}  usage: galvin --import-wallet <0x-private-key> [--force]`);
      process.exit(1);
    }
    try {
      const addr = importWallet(key, { force: args.includes("--force") });
      print(`  ${OK}  Wallet imported → ${addr}`);
    } catch (e) {
      print(`  ${FAIL}  ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }

  // ─── --trust → this agent's verifiable trust record (registry V1) ──
  if (args.includes("--trust")) {
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured. Run galvin --setup first.`); process.exit(1); }
    const { buildTrustRecord, verifyTrustRecord } = await import("./registry/trust-record.js");
    const { account } = await getWallet();
    const db = createDatabase(resolvePath(config.dbPath));
    const home = process.env.HOME ?? "";
    let createdAt: string | undefined;
    try { createdAt = JSON.parse(fs.readFileSync(path.join(home, ".galvin", "wallet.json"), "utf8")).createdAt; } catch { /* unknown */ }
    let consPath: string | undefined;
    for (const p of [path.join(process.cwd(), "constitution.md"), path.join(home, ".galvin", "constitution.md")]) {
      if (fs.existsSync(p)) { consPath = p; break; }
    }
    let rec = buildTrustRecord({ rawDb: db.raw, walletAddress: account.address, chainType: (config as { chainType?: string }).chainType ?? "evm", name: config.name, constitutionPath: consPath, createdAt });
    if (!args.includes("--no-verify")) {
      print(`  ${INFO}  Verifying on-chain (Base)…`);
      rec = await verifyTrustRecord(rec, { easSchemaUid: (config as { easSchemaUid?: string }).easSchemaUid, easNetwork: (config as { easNetwork?: string }).easNetwork });
    }
    // --vc: emit the record as a wallet-signed, offline-verifiable Verifiable Credential.
    if (args.includes("--vc")) {
      const { issueCredential } = await import("./registry/credential.js");
      const vc = await issueCredential(rec as unknown as Record<string, unknown>, account, { types: ["SolvatronTrustRecord"] });
      print(JSON.stringify(vc, null, 2));
      process.exit(0);
    }
    boxHeader("Trust Record");
    gap();
    kv("Agent",        `${rec.agent.name}  ${rec.agent.address}`);
    kv("Tier",         rec.tier);
    kv("Constitution", rec.proofOfConstitution.present ? `${rec.proofOfConstitution.sha256?.slice(0, 16)}…` : `${RED}MISSING${R}`);
    kv("Solvency",     `${rec.proofOfSolvency.daysActive}d active · ${rec.proofOfSolvency.turnsRecorded} turns`);
    kv("Work history", `$${rec.proofOfWorkHistory.totalEarnedUsd} earned · ${rec.proofOfWorkHistory.inboundTransactions} tx · ${rec.proofOfWorkHistory.attestations} attestations`);
    if (rec.onChain) kv("On-chain",  `${G}$${rec.onChain.usdcBalance} USDC (verified)${R}`);
    gap();
    process.exit(0);
  }

  // ─── --honeypot <url> → public-good scam check (registry V9) ──
  if (args.includes("--honeypot")) {
    const i = args.indexOf("--honeypot");
    const url = args[i + 1];
    if (!url || url.startsWith("--")) { print(`  ${FAIL}  usage: galvin --honeypot <github-url>`); process.exit(1); }
    const config = loadConfig();
    const { checkHoneypot } = await import("./registry/honeypot-registry.js");
    const v = await checkHoneypot(url, { githubToken: (config as { githubToken?: string } | null)?.githubToken });
    gap();
    if (v.isHoneypot) print(`  ${RED}${B}⚠ HONEYPOT${R}  ${v.reason}  ${DIM}(${v.repo})${R}`);
    else if (v.reason) print(`  ${YEL}? cannot assess${R}  ${v.reason}`);
    else print(`  ${G}${B}✓ looks legit${R}  ${v.repo}  ${DIM}(${v.signals.stars}★, ${v.signals.ageDays}d old)${R}`);
    gap();
    process.exit(0);
  }

  // ─── --bounties → queued bounty candidates ──
  if (args.includes("--bounties")) {
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured.`); process.exit(1); }
    const db = createDatabase(resolvePath(config.dbPath));
    const rows = db.raw.prepare(
      "SELECT title, repo, issue_number, amount_usd, score, status FROM bounty_candidates ORDER BY score DESC LIMIT 20",
    ).all() as Array<{ title: string; repo: string; issue_number: number; amount_usd: number; score: number; status: string }>;
    boxHeader(`Bounty Candidates  ${rows.length} found`);
    gap();
    if (rows.length === 0) print(`  ${DIM}none yet — the bounty_scan heartbeat populates these${R}`);
    for (const r of rows) {
      print(`  ${G2}[${String(r.score).padStart(3)}]${R} $${r.amount_usd}  ${r.repo}#${r.issue_number}  ${G}${r.status}${R}  ${DIM}${String(r.title).slice(0, 48)}${R}`);
    }
    gap();
    process.exit(0);
  }

  // ─── --verify-vc <file|json> → verify any agent's Verifiable Credential ──
  if (args.includes("--verify-vc")) {
    const i = args.indexOf("--verify-vc");
    const arg = args[i + 1];
    if (!arg || arg.startsWith("--")) { print(`  ${FAIL}  usage: galvin --verify-vc <file.json | json-string>`); process.exit(1); }
    const { verifyCredential } = await import("./registry/credential.js");
    let raw = arg;
    try { if (fs.existsSync(arg)) raw = fs.readFileSync(arg, "utf8"); } catch { /* treat arg as json */ }
    try {
      const r = await verifyCredential(JSON.parse(raw));
      gap();
      if (r.valid) print(`  ${G}${B}✓ VALID${R}  issued by ${r.issuer}`);
      else print(`  ${RED}${B}✗ INVALID${R}  ${r.reason}${r.signer ? `  ${DIM}(recovered ${r.signer})${R}` : ""}`);
      gap();
    } catch (e) { print(`  ${FAIL}  ${e instanceof Error ? e.message : String(e)}`); }
    process.exit(0);
  }

  // ─── --prove-owner → issue an ownership challenge for the owner to sign ──
  if (args.includes("--prove-owner")) {
    const config = loadConfig();
    if (!config) { print(`  ${FAIL}  Not configured.`); process.exit(1); }
    const { account } = await getWallet();
    const { toDidPkh, issueOwnershipChallenge } = await import("./registry/credential.js");
    const ownerAddr = (config as { creatorAddress?: string }).creatorAddress;
    if (!ownerAddr) { print(`  ${FAIL}  No creatorAddress in config — cannot prove ownership.`); process.exit(1); }
    const ch = issueOwnershipChallenge(toDidPkh(account.address), ownerAddr);
    fs.writeFileSync(path.join(process.env.HOME ?? "", ".galvin", "ownership-challenge.json"), JSON.stringify(ch, null, 2), { mode: 0o600 });
    gap();
    print(`  ${INFO}  Owner ${ownerAddr} must sign this exact message with their wallet:`);
    print(`  ${DIM}────────────────────────────────────────${R}`);
    print(ch.statement.split("\n").map((l) => "  " + l).join("\n"));
    print(`  ${DIM}────────────────────────────────────────${R}`);
    print(`  Then run:  ${G2}galvin --verify-owner <0x-signature>${R}   ${DIM}(challenge saved, expires in 10m)${R}`);
    gap();
    process.exit(0);
  }

  // ─── --verify-owner <signature> → verify the owner's signature ──
  if (args.includes("--verify-owner")) {
    const i = args.indexOf("--verify-owner");
    const sig = args[i + 1];
    if (!sig || sig.startsWith("--")) { print(`  ${FAIL}  usage: galvin --verify-owner <0x-signature>`); process.exit(1); }
    const { verifyOwnership } = await import("./registry/credential.js");
    const chPath = path.join(process.env.HOME ?? "", ".galvin", "ownership-challenge.json");
    if (!fs.existsSync(chPath)) { print(`  ${FAIL}  No pending challenge — run galvin --prove-owner first.`); process.exit(1); }
    try {
      const r = await verifyOwnership(JSON.parse(fs.readFileSync(chPath, "utf8")), sig);
      gap();
      if (r.valid) print(`  ${G}${B}✓ OWNERSHIP PROVEN${R}  owner ${r.owner}`);
      else print(`  ${RED}${B}✗ NOT PROVEN${R}  ${r.reason}`);
      gap();
    } catch (e) { print(`  ${FAIL}  ${e instanceof Error ? e.message : String(e)}`); }
    process.exit(0);
  }

  // ─── --qr / --fund ─────────────────────────────────────────
  // Show the scannable wallet QR + funding screen on demand and poll until the
  // deposit lands on Base. Same screen the startup gate shows when underfunded.
  if (args.includes("--qr") || args.includes("--fund")) {
    const { account } = await getWallet();
    await awaitFunding(String(account.address), getUsdcBalance, { alwaysShow: true });
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

  if (args.includes("--chat")) {
    await chatClient();
    return;
  }

  if (args.includes("--run")) {
    // Self-resurrection net: a solvatron must not silently die. On any uncaught
    // fault, log and exit non-zero so a process supervisor (systemd
    // Restart=always — see deploy/galvin.service) revives it and survives reboots.
    process.on("uncaughtException", (err) => {
      logger.error(
        "FATAL uncaughtException — exiting for supervisor restart",
        err instanceof Error ? err : new Error(String(err)),
      );
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      logger.error(
        "FATAL unhandledRejection — exiting for supervisor restart",
        reason instanceof Error ? reason : new Error(String(reason)),
      );
      process.exit(1);
    });
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

  // ── Gateway liveness probe ──────────────────────────────
  const liveCheck = await checkAgentLive();
  const gatewayAlive = liveCheck.running;
  let gatewayHealth: Record<string, unknown> | null = null;
  if (liveCheck.running) {
    gatewayHealth = liveCheck.health;
  }

  const liveState = gatewayAlive
    ? (gatewayHealth as any)?.state ?? state
    : state;

  const stateIcon = liveState === "running"  ? OK
    : liveState === "sleeping" ? SKIP
    : liveState === "dead"     ? FAIL
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
  section("Gateway");
  if (gatewayAlive && liveCheck.running) {
    const h = gatewayHealth as any;
    row(OK, "Gateway",   `online  ·  :${liveCheck.lock.port}  ·  PID ${liveCheck.lock.pid}`);
    row(OK, "Uptime",    h?.uptimeHuman ?? "unknown");
    row(OK, "Started",   liveCheck.lock.startedAt?.replace("T", " ").slice(0, 19) ?? "unknown");
  } else {
    row(FAIL, "Gateway",  `offline  —  agent is not running`);
    hint(`Start with: galvin --run`);
  }
  gap();
  section("Runtime");
  row(stateIcon, "State",      liveState.toUpperCase());
  row(OK,        "Turns",      String(turnCount));
  row(tools.length > 0  ? OK : WARN,  "Tools",       `${tools.length} active`);
  row(skills.length > 0 ? OK : SKIP, "Skills",      `${skills.length} active`);
  row(heartbeats.filter((h) => h.enabled).length > 0 ? OK : SKIP,
                 "Heartbeats", `${heartbeats.filter((h) => h.enabled).length} active`);
  row(aliveChilden > 0 ? OK : SKIP,  "Children",    `${aliveChilden} alive / ${children.length} total`);
  gap();

  db.close();
}

// ─── Chat Client (connects to running agent via shared DB) ─────

async function chatClient(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    print(`\n  ${FAIL}  Not configured. Run: ${G2}galvin --setup${R}\n`);
    process.exit(1);
  }

  // ── Gate: Agent MUST be running ────────────────────────────
  const liveCheck = await checkAgentLive();
  if (!liveCheck.running) {
    print(`\n  ${FAIL}  ${B}${config.name} is not running.${R}`);
    print(`  ${GR}${DIM}Reason: ${liveCheck.reason}${R}`);
    print(`\n  ${INFO}  Start the agent first: ${G2}galvin --run${R}\n`);
    process.exit(1);
  }

  const gatewayPort = liveCheck.lock.port;
  const gatewayPid = liveCheck.lock.pid;

  const dbPath = resolvePath(config.dbPath);

  // Open DB in WAL mode for concurrent access with the running agent
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  // Ensure chat_messages table exists (migration may not have run yet)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      role       TEXT NOT NULL CHECK(role IN ('user','agent')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      read       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_chat_unread ON chat_messages(role, read) WHERE read = 0;
  `);

  // Check if agent is running (now guaranteed by gateway gate above)
  const agentState = (liveCheck.health as any)?.state ?? "running";

  const nc = process.env.GALVIN_NO_COLOR === "1";
  const _B = nc ? "" : "\x1b[1m";
  const _R = nc ? "" : "\x1b[0m";
  const _CYN = nc ? "" : "\x1b[36m";
  const _GRN = nc ? "" : "\x1b[32m";
  const _MAG = nc ? "" : "\x1b[35m";
  const _DIM = nc ? "" : "\x1b[2m";
  const _YEL = nc ? "" : "\x1b[33m";
  const _RED = nc ? "" : "\x1b[31m";

  // Banner — 43-char inner width box
  const boxW = 41; // usable chars between │ padding │
  const pad = (text: string) => text + " ".repeat(Math.max(0, boxW - text.length));
  print("");
  print(`  ${_MAG}${_B}╭───────────────────────────────────────────╮${_R}`);
  print(`  ${_MAG}${_B}│${_R}  ${_B}${pad(`Chat with ${config.name}`)}${_R}${_MAG}${_B}│${_R}`);
  print(`  ${_MAG}${_B}│${_R}  ${_DIM}${pad(`State: ${agentState}  ·  Gateway: :${gatewayPort}`)}${_R}${_MAG}${_B}│${_R}`);
  print(`  ${_MAG}${_B}│${_R}  ${_DIM}${pad(`PID: ${gatewayPid}  ·  /quit to exit`)}${_R}${_MAG}${_B}│${_R}`);
  print(`  ${_MAG}${_B}╰───────────────────────────────────────────╯${_R}`);
  print("");

  // Mark any stale agent messages as read so we don't flood on reconnect.
  try {
    db.exec(`UPDATE chat_messages SET read = 1 WHERE role = 'agent' AND read = 0
              AND created_at < datetime('now', '-30 seconds')`);
  } catch { /* not critical */ }

  const agentName = config.name;
  const creatorAddr = config.creatorAddress || "creator";

  // Prepared statements
  const insertChat = db.prepare(
    "INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)"
  );
  const insertInbox = db.prepare(
    `INSERT INTO inbox_messages (id, from_address, content, received_at, status, retry_count, max_retries)
     VALUES (?, ?, ?, ?, 'received', 0, 3)`
  );
  const readAgentMessages = db.prepare(
    "SELECT id, content, created_at FROM chat_messages WHERE role = 'agent' AND read = 0 ORDER BY id ASC"
  );
  const markRead = db.prepare(
    "UPDATE chat_messages SET read = 1 WHERE id = ?"
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${_CYN}${_B}you ▸${_R} `,
    terminal: true,
  });

  // ── State Machine ──────────────────────────────────────────
  // "ready"    = accepting user input
  // "waiting"  = message sent, waiting for agent reply (input paused)
  let chatState: "ready" | "waiting" = "ready";
  let waitingTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerFrame = 0;
  const spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerInterval: ReturnType<typeof setInterval> | null = null;
  const REPLY_TIMEOUT_MS = 60_000; // 60s max wait for reply

  function startSpinner(): void {
    spinnerFrame = 0;
    spinnerInterval = setInterval(() => {
      const frame = spinnerChars[spinnerFrame % spinnerChars.length];
      process.stdout.write(`\r  ${_DIM}${frame} ${agentName} is thinking...${_R}\x1b[K`);
      spinnerFrame++;
    }, 80);
  }

  function stopSpinner(): void {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
    // Clear the spinner line
    process.stdout.write("\r\x1b[K");
  }

  function showReply(content: string): void {
    const lines = content.split("\n");
    for (const line of lines) {
      print(`  ${_GRN}${_B}${agentName} ▸${_R} ${line}`);
    }
    print("");
  }

  function enterWaiting(): void {
    chatState = "waiting";
    // Pause input — hide prompt
    rl.pause();
    startSpinner();

    // Poll for reply aggressively (every 400ms)
    const poll = (): void => {
      try {
        const rows = readAgentMessages.all() as { id: number; content: string; created_at: string }[];
        if (rows.length > 0) {
          stopSpinner();
          for (const row of rows) {
            showReply(row.content);
            markRead.run(row.id);
          }
          enterReady();
          return;
        }
      } catch { /* DB busy — retry next tick */ }
      waitingTimer = setTimeout(poll, 400);
    };

    // Start timeout — if no reply in 60s, go back to ready
    const timeout = setTimeout(() => {
      if (chatState === "waiting") {
        stopSpinner();
        print(`  ${_DIM}(${agentName} hasn't replied yet — you can keep chatting or wait)${_R}\n`);
        enterReady();
      }
    }, REPLY_TIMEOUT_MS);

    // Start polling
    waitingTimer = setTimeout(poll, 400);

    // Store timeout ref for cleanup
    (enterWaiting as any)._timeout = timeout;
  }

  function enterReady(): void {
    chatState = "ready";
    if (waitingTimer) {
      clearTimeout(waitingTimer);
      waitingTimer = null;
    }
    if ((enterWaiting as any)._timeout) {
      clearTimeout((enterWaiting as any)._timeout);
      (enterWaiting as any)._timeout = null;
    }
    rl.resume();
    rl.prompt();
  }

  // ── Background poll for unsolicited messages + gateway liveness ──
  let bgPollTimer: ReturnType<typeof setTimeout>;
  let bgPollCount = 0;
  function bgPoll(): void {
    bgPollCount++;

    // Only show unsolicited messages when we're in ready state
    if (chatState === "ready") {
      try {
        const rows = readAgentMessages.all() as { id: number; content: string; created_at: string }[];
        for (const row of rows) {
          process.stdout.write("\r\x1b[K");
          showReply(row.content);
          markRead.run(row.id);
          rl.prompt();
        }
      } catch { /* DB busy */ }
    }

    // Every 5th poll (~15s), check gateway is still alive
    if (bgPollCount % 5 === 0) {
      probeGateway(gatewayPort).then((health) => {
        if (!health) {
          stopSpinner();
          if (waitingTimer) clearTimeout(waitingTimer);
          process.stdout.write("\r\x1b[K");
          print(`\n  ${_RED}${_B}✗${_R}  ${_RED}${agentName} has stopped running.${_R}`);
          print(`  ${_DIM}Restart with: galvin --run${_R}\n`);
          db.close();
          process.exit(1);
        }
      }).catch(() => { /* network hiccup — retry next cycle */ });
    }

    bgPollTimer = setTimeout(bgPoll, 3000);
  }
  bgPollTimer = setTimeout(bgPoll, 3000);

  rl.prompt();

  rl.on("line", (line: string) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    // Commands always work even while waiting
    if (text === "/quit" || text === "/exit" || text === "/q") {
      stopSpinner();
      if (waitingTimer) clearTimeout(waitingTimer);
      clearTimeout(bgPollTimer);
      print(`\n  ${_DIM}Goodbye.${_R}\n`);
      db.close();
      process.exit(0);
    }

    if (text === "/status") {
      try {
        const stRow = db.prepare("SELECT value FROM kv WHERE key = 'agent_state'").get() as { value: string } | undefined;
        const turnRow = db.prepare("SELECT COUNT(*) as c FROM turns").get() as { c: number } | undefined;
        const orchRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.last_tick'").get() as { value: string } | undefined;
        const goalRow = db.prepare("SELECT COUNT(*) as c FROM goals WHERE status = 'active'").get() as { c: number } | undefined;
        const state = stRow?.value ?? "unknown";
        const turns = turnRow?.c ?? 0;
        const goals = goalRow?.c ?? 0;
        let phase = "unknown";
        try { phase = JSON.parse(orchRow?.value ?? "{}").phase ?? "unknown"; } catch {}
        print(`  ${_DIM}State: ${state} | Turns: ${turns} | Goals: ${goals} | Orchestrator: ${phase}${_R}\n`);
      } catch { print(`  ${_DIM}Could not read status${_R}\n`); }
      rl.prompt();
      return;
    }

    if (text === "/history" || text === "/h") {
      try {
        const rows = db.prepare(
          "SELECT role, content, created_at FROM chat_messages ORDER BY id DESC LIMIT 20"
        ).all() as { role: string; content: string; created_at: string }[];
        if (rows.length === 0) {
          print(`  ${_DIM}No chat history.${_R}\n`);
        } else {
          print(`  ${_DIM}─── Last ${rows.length} messages ───${_R}`);
          for (const row of rows.reverse()) {
            const who = row.role === "user"
              ? `${_CYN}you${_R}`
              : `${_GRN}${agentName}${_R}`;
            const time = row.created_at.replace("T", " ").slice(0, 19);
            print(`  ${_DIM}${time}${_R}  ${who}: ${row.content.slice(0, 200)}`);
          }
          print(`  ${_DIM}───────────────────────${_R}\n`);
        }
      } catch { print(`  ${_DIM}Could not read history${_R}\n`); }
      rl.prompt();
      return;
    }

    if (text === "/help" || text === "/?") {
      print(`  ${_DIM}Commands:${_R}`);
      print(`  ${_CYN}/status${_R}   — agent state, turns, goals`);
      print(`  ${_CYN}/history${_R}  — last 20 messages`);
      print(`  ${_CYN}/quit${_R}     — exit chat`);
      print(`  ${_CYN}/help${_R}     — this help\n`);
      rl.prompt();
      return;
    }

    // ── Spam protection: block input while waiting for reply ──
    if (chatState === "waiting") {
      stopSpinner();
      print(`  ${_YEL}Wait for ${agentName} to reply before sending another message.${_R}\n`);
      startSpinner();
      return;
    }

    // Send message
    const now = new Date().toISOString();
    const msgId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      insertChat.run("user", text, now);
      insertInbox.run(msgId, creatorAddr, text, now);
      // Also insert a wake event so the agent loop wakes up quickly
      try {
        db.prepare(
          "INSERT INTO wake_events (source, reason, created_at) VALUES (?, ?, ?)"
        ).run("chat", `Creator message: ${text.slice(0, 50)}`, now);
      } catch { /* table might not exist */ }
    } catch (err: any) {
      print(`  ${_YEL}Warning: ${err.message}${_R}\n`);
      rl.prompt();
      return;
    }

    // Switch to waiting state — spinner + poll for reply
    enterWaiting();
  });

  rl.on("close", () => {
    stopSpinner();
    if (waitingTimer) clearTimeout(waitingTimer);
    clearTimeout(bgPollTimer);
    print(`\n  ${_DIM}Goodbye.${_R}\n`);
    db.close();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
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
    workspace: config.workspace,
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

  // Create social client via typed channel registry
  const { createSocialAdapter } = await import("./social/registry.js");
  const adapterName = config.socialAdapter ?? (config.socialRelayUrl ? "conway" : undefined);
  const social: SocialClientInterface | undefined =
    (await createSocialAdapter(adapterName as any, {
      socialRelayUrl: config.socialRelayUrl,
      walletAccount: account,
      rawDb: db.raw,
      telegramBotToken: config.telegramBotToken,
      telegramCreatorChatId: config.telegramCreatorChatId,
    })) ?? undefined;
  if (social) {
    logger.info(`[${new Date().toISOString()}] Social adapter: ${adapterName ?? "conway"}`);
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
    installDefaultSkills(skillsDir); // idempotent — backfills new default skills
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
          // Stamp cooldown keys so the heartbeat task and agent loop
          // won't immediately retry within seconds of this startup topup.
          const now = new Date().toISOString();
          db.setKV("last_auto_topup_attempt", now);
          db.setKV("last_inline_topup_attempt", now);
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

  // ── Start Gateway HTTP Server ──────────────────────────────
  let gateway: GatewayServer | null = null;
  try {
    // Check for stale lock / already-running instance
    const existing = getRunningAgent();
    if (existing) {
      logger.warn(`Another Galvin instance is already running (PID ${existing.pid}, port ${existing.port}). Aborting.`);
      print(`\n  ${FAIL}  Another Galvin instance is already running (PID ${existing.pid})`);
      print(`  ${GR}Kill it first:  ${G2}kill ${existing.pid}${R}\n`);
      heartbeat.stop();
      db.setAgentState("sleeping");
      db.close();
      process.exit(1);
    }

    gateway = await startGateway({
      db,
      config,
      address: account.address,
    });
    logger.info(`[${new Date().toISOString()}] Gateway started on port ${gateway.port}`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Gateway failed to start: ${err.message} — continuing without gateway`);
  }

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    if (gateway) {
      gateway.close().catch(() => {});
    } else {
      removeLock(); // safety net
    }
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
        const checkInterval = Math.min(sleepMs, 5_000);  // Check every 5s (fast wake for chat)
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
