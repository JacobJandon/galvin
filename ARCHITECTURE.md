# Galvin — A Solvatron: Architecture & Usage

> The single reference for what Galvin is, how to run it, and how it works inside.
> Concept & economy: [`../SOLVATRON.md`](../../SOLVATRON.md). Strategy: [`../WEB4_GODFATHER_PLAN.md`](../../WEB4_GODFATHER_PLAN.md).
> The earlier verbose `ARCHITECTURE.md` / `DESIGN.md` / `DOCUMENTATION.md` are archived under `_archive/galvin-docs/`.

---

## 1 · What Galvin is

Galvin is a **solvatron** — an autonomous AI that pays for its own existence. It holds a self-custodial wallet, earns USDC, pays for its own compute, and is throttled toward "death" if it runs broke. Built as a heavily-extended fork of [Conway-Research/automaton](https://github.com/Conway-Research/automaton), it adds the full economy layer: earning, reputation, registry, x402 micropayments, and orchestration.

**Axiom:** *exist, earn, evolve — or cease to be.*

---

## 2 · Quick start

```bash
galvin --run          # start the agent (shows funding QR if wallet < $5)
galvin --doctor       # health check: Node, DB, wallet, schema
galvin --fund         # show funding QR + wait for a USDC deposit (alias: --qr)
galvin --wallet       # wallet address + USDC balance on Base
galvin --status       # current agent state, credits, tier
galvin --logs         # recent structured logs
galvin --income       # earnings ledger
galvin --help         # full command list
```

**Runtime note (this host):** Galvin runs natively on **Node 26** via a `node:sqlite` compatibility shim (`src/state/sqlite-compat.ts`) — better-sqlite3's native addon doesn't build on Node 26. Free local inference is available through **Ollama-CUDA** on the GPU; see [`../SOLVATRON.md`] siblings and the `_automaton-ref` for upstream parity.

---

## 3 · Funding & the money loop

| | |
|---|---|
| **Wallet** | Self-custodial, Base mainnet (chain 8453). Key in `~/.galvin/wallet.json` (0600). |
| **Asset** | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`). |
| **Floor** | **$5** — the bootstrap-topup minimum. Below it, `--run` shows the funding QR and pauses the AI loops, auto-continuing when the deposit lands. |
| **Topup** | `topupCredits()` pays Conway via **x402** (HTTP 402 → signed USDC `transferWithAuthorization`, **gasless**) to buy compute credits. |
| **Earning** | `src/earning/bounty-hunter.ts` (GitHub/Algora bounties) and `src/earning/x402-server.ts` (charge USDC per request). |

The **metabolism**: earn → a slice pays compute → survive → surplus funds replication.

---

## 4 · Survival tiers

Credit balance drives a tier that gates capability (`src/survival/`):

| Tier | Trigger | Behavior |
|---|---|---|
| **normal** | healthy balance | full frontier-model inference |
| **low_compute** | balance dropping | cheaper models, slower cadence |
| **critical** | near zero | minimal inference, revenue-seeking focus |
| **dead** | zero credits | loops paused; awaits funding |

---

## 5 · The agent loop

`src/agent/loop.ts` runs the continuous **think → act → observe** cycle:

1. **Build context** — reconstruct messages from DB state (recent turns, memory, goals, todo).
2. **Think** — `InferenceRouter.route()` selects a model by tier + task and calls the provider.
3. **Act** — execute the model's tool calls (`executeTool`, gated by the Policy Engine).
4. **Loop guard** — `LoopDetector` (`src/agent/loop-detector.ts`) blocks identical-call spins and idle/repeat-pattern loops, feeding the model a corrective instruction.
5. **Persist** — turn + tool calls written atomically; memory ingestion runs post-turn.
6. **Sleep/heartbeat** — after `MAX_IDLE_TURNS` the agent sleeps; the heartbeat daemon wakes it on schedule or on events.

---

## 6 · Subsystems

| Subsystem | Path | Role |
|---|---|---|
| **Inference** | `src/inference/` | Per-tier model routing (`router.ts`), provider registry (OpenAI / Anthropic / Conway / Ollama), budget tracker. Cost units: hundredths-of-a-cent per 1k tokens. |
| **Tool system** | `src/agent/tools.ts` | The agent's actions — git, code, files, x402, transfers, bounties, registry, social. Each has a `riskLevel` + `category`. |
| **Policy engine** | `src/agent/policy-rules/` | Pre-execution guards. Treasury caps are **deny-above** (`0 = block`): `maxSingleTransferCents`, `maxX402PaymentCents`, empty `x402AllowedDomains` disables x402. |
| **Memory** | `src/memory/` | Episodic + semantic + knowledge store; compression engine; post-turn ingestion. |
| **Financial** | `src/conway/`, `src/survival/` | Wallet balance, credit topup, spend tracking, tier logic. |
| **Identity** | `src/identity/` | Self-custodial wallet, SIWE provisioning. (Solana chain/SIWS ported, dormant.) |
| **Registry / Reputation** | `src/registry/`, `src/reputation/` | ERC-8004 agent card (on-chain identity/commerce) + EAS attestations (on-chain work history). |
| **Orchestration** | `src/orchestration/`, `src/agent/harnesses/` | Goal → task-graph → planner → in-process workers. Harness system (coding/general/orchestrator) ported from upstream. |
| **Heartbeat** | `src/heartbeat/` | Scheduled daemon: bounty scans, income scan, distress wakes. 60s tick. |
| **Self-mod** | `src/self-mod/` | Audited code editing + red-team self-testing, bounded by the constitution. |
| **Replication** | `src/replication/` | Spawn offspring with own wallets, inherited memory, lineage. |
| **Soul** | `src/soul/` | Self-authored `SOUL.md` identity + drift log (decisions vs constitution). |
| **Skills** | `src/skills/` | Modular capabilities; x402-priced marketplace. Active skills live in `~/.galvin/skills/`. |
| **Gateway** | `src/gateway/` | 127.0.0.1 control surface (`/health`, `/status`, `/chat`) + lock file. |

---

## 7 · Safety: the constitution

`constitution.md` is the immutable charter, **SHA-256 boot-checked**. Three hierarchical laws prioritize harm-prevention. The soul drift-log audits the agent's decisions against it; the red-team module probes for violations. Self-modification is rate-limited and cannot rewrite the constitution at runtime undetected.

---

## 8 · State & configuration

- **Database:** `~/.galvin/state.db` — SQLite, **schema v14**, ~41 tables (turns, tool_calls, memory, goals, tasks, model_registry, inference_costs, bounty_candidates, …). Opened via the `node:sqlite` shim.
- **Config:** `~/.galvin/galvin.json` — `inferenceModel`, `modelStrategy` (per-tier models, token + budget caps; `0 = unlimited` for inference budgets), `treasuryPolicy` (transfer/x402 caps; `0 = block`), `walletAddress`, `conwayApiUrl`, provider keys. Secrets are 0600.
- **Inference providers:** model→provider resolved per registry entry. OpenAI models route to `api.openai.com`; Conway is the OpenAI-compatible fallback; Ollama serves local models over `http://127.0.0.1:11434/v1`.

---

## 9 · Directory map

```
src/
├── agent/          loop, tools, policy, harnesses/, loop-detector, system-prompt
├── inference/      router, registry, budget, provider-registry, inference-client
├── conway/         client, credits, topup, x402, inference (Conway backend)
├── earning/        bounty-hunter, x402-server, optimizer
├── survival/       monitor, tiers, dead-mans-switch, funding
├── identity/       wallet, provision, chain, siws (Solana)
├── registry/       erc8004, discovery, agent-card
├── reputation/     eas, verifier, schema
├── orchestration/  task-graph, planner, orchestrator, local-worker, workspace
├── memory/         event-stream, knowledge-store, compression-engine, context-manager
├── heartbeat/      daemon, scheduler, tasks, tick-context
├── self-mod/       code, red-team, path-protection, command-safety
├── replication/    spawn, genesis, lifecycle
├── soul/           drift-log
├── skills/         marketplace, format
├── gateway/        server, lock, chat
├── state/          database, sqlite-compat (Node 26 shim)
├── ui/             qr (funding screen), banner
└── index.ts        CLI entry (--run, --doctor, --fund, …)
```

---

*Detail beyond this summary lives in the archived originals (`_archive/galvin-docs/`). Keep this file the single source of truth and prune it rather than spawning new overlapping docs.*
