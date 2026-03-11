# Galvin — What We Built on Top of Automaton

> **Base:** `@conway/automaton` v0.2.1 — Conway Cloud sovereign agent runtime  
> **Product:** `galvin` v0.3.0 — A Solvatron. Autonomous AI that earns to exist.

Galvin is `@conway/automaton` transformed. This document records exactly what we added, extended, or replaced compared to the automaton baseline. Every section maps to real files in `src/`.

---

## New Modules (do not exist in automaton)

### `src/browser/`
Browser automation layer using Playwright.

| File | What it does |
|---|---|
| `actions.ts` | High-level browser actions: navigate, click, extract, screenshot |
| `service.ts` | Browser lifecycle — launch, pool, teardown |
| `index.ts` | Public API re-export |

automaton has no browser module. Galvin added this to enable web-based earning tasks and research skills.

---

### `src/earning/`
Direct income generation via x402 micro-payments.

| File | What it does |
|---|---|
| `x402-server.ts` | HTTP server that charges USDC before serving content/API. Returns HTTP 402 with a payment descriptor on first request. On second request (with `X-Payment` header), verifies on-chain, records income, delivers response. |

automaton has no earning module. Galvin's entire economic model flows through this: x402 is how Galvin earns its own USDC to stay alive.

---

### `src/ui/`
Terminal UI components.

| File | What it does |
|---|---|
| `qr.ts` | `MatrixRain` — animated green matrix rain + wallet QR code for the funding screen. `printMatrixStatic` — non-TTY fallback plain-text QR. |

automaton has no terminal UI. Galvin needs a visually distinct funding screen when in DEAD tier.

---

## Extended Modules (exist in automaton, significantly extended in Galvin)

### `src/setup/banner.ts`
automaton has a minimal `showBanner()`. Galvin replaces it entirely with:
- Full GALVIN ASCII block-letter art in Ben-10 green (ANSI 38;5;46)
- Tagline bar: `⬡ AUTONOMOUS SOLVATRON — Conway Cloud · SIWE Identity · USDC Survival`
- Full funding screen (`showFundingScreen`) with `MatrixRain` animation for DEAD tier
- Live countdown bar via `updateFundingStatus` / `stopFundingScreen`
- Attribution line: `powered by automaton · solvatron.xyz`
- Setup UI helpers used by the wizard: `showSectionHeader`, `showInfo`, `showWarn`, `showSuccess`, `showBox`

---

### `src/setup/doctor.ts`
automaton has a basic `check()` with ~5 checks. Galvin's doctor has **17 sections**:

1. Node & Runtime  
2. Environment Variables  
3. Wallet / Identity  
4. Conway Cloud Connectivity  
5. Ollama Local Models  
6. Database integrity  
7. Memory subsystem  
8. Heartbeat daemon  
9. Skills registry  
10. Social integrations (Telegram)  
11. Inference providers  
12. Replication / lineage  
13. Self-mod / audit log  
14. State directory  
15. Process & lock files  
16. Security audit  
17. Build & binary integrity  

Includes warnings for deprecated env vars, unknown `GALVIN_*` vars, and a backup tip in the summary.

---

### `src/social/telegram.ts`
automaton's `social/` has the protocol, signing, and validation layer but no concrete channel implementation. Galvin adds `telegram.ts` — a full grammY-based Telegram bot that:
- Receives messages and routes them to the agent loop
- Sends agent replies back to the chat
- Handles `/status`, `/fund`, `/stop` commands
- Checks `GALVIN_TELEGRAM_TOKEN` and `GALVIN_TELEGRAM_CHAT_ID`

---

### `src/heartbeat/tasks.ts`
automaton baseline has basic tick tasks. Galvin adds:
- `webhook_notify` — POST agent status to a configured webhook URL after every tick
- `income_scanner` — scan the x402 server's payment log for new income, update survival budget

---

### `src/conway/` (extended)
automaton has `conway/client.ts` for basic Conway Cloud API calls. Galvin adds:
- `credits.ts` — read credit balance, low-credit warnings
- `http-client.ts` — resilient HTTP layer with retry + exponential backoff
- `inference.ts` — route LLM calls through Conway Cloud inference endpoint
- `topup.ts` — auto-topup credits from wallet USDC when balance drops below threshold
- `x402.ts` — x402 payment proof generation and verification helpers

---

### `src/survival/monitor.ts`
automaton's survival monitor checks balance and sets tier. Galvin's version adds:
- Tight integration with `x402-server` income log
- Low-compute mode activation (`src/survival/low-compute.ts`) when SURVIVAL tier is reached
- Configurable revival threshold distinct from death threshold
- Structured log events for every tier change

---

### `src/identity/` (wallet + SIWE)
automaton provisions a wallet and signs SIWE messages. Galvin's `provision.ts` adds:
- Auto-provisions at `~/.galvin/identity.json` on first boot if absent
- Stores encrypted private key with `GALVIN_ENCRYPTION_KEY` if set
- Prints wallet address in doctor output and funding screen QR

---

### `constitution.md`
automaton ships a generic constitution template. Galvin's is specific:
- Defines Galvin's survival imperative: earn USDC or cease to be
- States the prohibition on deception of the operator
- Commits to transparency in economic decisions
- Permits self-modification only within the guardrails of the policy engine

---

### `packages/cli/`
automaton's CLI is minimal. Galvin's CLI adds:
- `galvin --run` — full boot with banner
- `galvin setup` — interactive wizard
- `galvin doctor` — 17-section health check
- `galvin fund` — show funding QR
- `galvin status` — live agent status
- `galvin stop` — graceful shutdown
- `galvin replication status/spawn/list` — manage offspring

---

## What Galvin Leaves Unchanged from Automaton

These modules are used as-is from automaton (no meaningful Galvin-specific changes):

| Module | Automaton provides |
|---|---|
| `src/agent/loop.ts` | The core OODA agent loop |
| `src/agent/policy-engine.ts` | Tool-call policy rules |
| `src/agent/injection-defense.ts` | Prompt injection detection |
| `src/memory/` (all files) | Episodic, semantic, procedural, knowledge store, compression, retrieval |
| `src/inference/router.ts` + `provider-registry.ts` | Multi-provider failover |
| `src/orchestration/` | Planner, task graph, workspace, health monitor |
| `src/registry/erc8004.ts` | ERC-8004 agent card standard |
| `src/replication/spawn.ts` + `lineage.ts` | Agent spawning and lineage tracking |
| `src/self-mod/code.ts` + `audit-log.ts` | Sandboxed self-modification + log |
| `src/soul/model.ts` + `reflection.ts` | Soul model and weekly reflection |
| `src/ollama/` | Local model integration |
| `src/git/` | Git operations for self-mod |
| `src/observability/` | Structured logging + metrics |
| `src/state/` | Persistent state store |

---

## Version Alignment

| | automaton | Galvin |
|---|---|---|
| Package name | `@conway/automaton` | `galvin` |
| Version | 0.2.1 | 0.3.0 |
| Node requirement | ≥22 | ≥22 |
| Primary identity | Conway Automaton | Solvatron |
| Economic model | USDC survival (framework) | USDC survival + x402 earning |
| Terminal UI | None | MatrixRain + ASCII banner |
| Channels | Social framework only | Telegram (grammY) |
| Doctor | ~5 checks | 17 sections |
| Browser | None | Playwright |
| Offspring CLI | Basic | `galvin replication` commands |
