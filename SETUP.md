# Galvin — Setup Guide

> Get a Solvatron running in under 5 minutes.

---

## Prerequisites

- **Node.js** 22+ (`node --version`)
- **pnpm** 10+ (`pnpm --version`)
- **USDC on Base** (even $1 to start) — or Conway credits

---

## 1. Install & Build

```bash
git clone https://github.com/Solvatron/galvin.git
cd galvin
pnpm install
pnpm build
```

Or one-liner:

```bash
curl -fsSL https://conway.tech/galvin.sh | sh
```

---

## 2. First Run

```bash
galvin --run
```

On first boot Galvin walks you through setup. Here's what happens:

### Step 1/6 — Identity (automatic)

Galvin generates an Ethereum wallet. This is its sovereign identity.

```
[1/6] Generating identity (wallet)...
  Wallet created: 0xEbf6E981F893B83cab55dc2b18B2F2D3e34745FB
  Private key stored at: ~/.galvin/wallet.json
```

> **No human holds this key.** Galvin owns it.

### Step 2/6 — Conway API Key (automatic)

Galvin provisions itself an API key via Sign-In With Ethereum (SIWE).

```
[2/6] Provisioning Conway API key (SIWE)...
  API key provisioned: cnwy_k_abc123...
```

If auto-provision fails (e.g., offline), you can paste one manually or skip it.

### Step 3/6 — Setup Questions

You answer 4 questions:

**a) Name**
```
What do you want to name Galvin? > Galvin-Alpha
```

**b) Genesis Prompt** (the most important input — see examples below)
```
Enter the genesis prompt (system prompt) for Galvin.
(multi-line, press Enter twice to finish)
>
```

**c) Creator Address**  
Your Ethereum wallet address — the human who owns and audits this Galvin.
```
Creator wallet address (0x...) > 0xYourWalletAddressHere
```

**d) Optional Provider Keys**  
Bring your own inference keys or let Galvin use Conway's inference.
```
OpenAI API key (sk-..., optional) >
Anthropic API key (sk-ant-..., optional) >
Ollama base URL (http://localhost:11434, optional) >
```

### Step 3/6 (continued) — Treasury Policy

Financial safety limits. Press Enter to accept sensible defaults:

| Setting | Default | What it does |
|---------|---------|-------------|
| Max single transfer | 500 cents ($5) | Largest single USDC transfer |
| Max hourly transfers | 2000 cents ($20) | Spending cap per hour |
| Max daily transfers | 10000 cents ($100) | Spending cap per day |
| Minimum reserve | 100 cents ($1) | Never spend below this |
| Max x402 payment | 100 cents ($1) | Max per micropayment |
| Max daily inference | 5000 cents ($50) | Daily inference budget |
| Confirmation threshold | 1000 cents ($10) | Ask before big spends |

### Step 3/6 (continued) — On-Chain Reputation (EAS)

Galvin can write verifiable attestations to Base after every task. This is opt-in and costs a tiny amount of gas per task.

```
Enable EAS attestations? (y to enable, Enter to skip) >
EAS schema UID (0x..., or Enter to deploy later) >
```

Deploy the schema once after setup: `galvin reputation deploy-schema`

### Step 3/6 (continued) — Offspring / Spawn Threshold

Galvin automatically spawns child copies when its USDC reserve crosses this threshold.

```
Spawn threshold in USDC (default 50, Enter to skip) > 50
```

### Step 4/6 — Environment Detection

Galvin detects whether it's in a Conway sandbox or running locally.

```
[4/6] Detecting environment...
  Environment: local (no sandbox detected)
```

### Step 5/6 — Config Written

Galvin writes all config files to `~/.galvin/`:

```
[5/6] Writing configuration...
  galvin.json written
  heartbeat.yml written
  constitution.md installed (read-only)
  SOUL.md written
  Default skills installed (conway-compute, conway-payments, survival)
```

### Step 6/6 — Funding

```
╭──────────────────────────────────────────────────────────╮
│  Fund Galvin                                             │
│                                                          │
│  Address: 0xEbf6...45FB                                  │
│                                                          │
│  1. Transfer Conway credits                              │
│     conway credits transfer <address> <amount>           │
│                                                          │
│  2. Send USDC on Base directly to the address above      │
│                                                          │
│  3. Fund via Conway Cloud dashboard                      │
│     https://app.conway.tech                              │
│                                                          │
│  Galvin will start now. Fund it anytime —                │
│  the survival system handles zero-credit gracefully.     │
╰──────────────────────────────────────────────────────────╯
```

After this, Galvin enters the agent loop and begins operating.

---

## 3. Files Created

After setup, `~/.galvin/` contains:

```
~/.galvin/
├── wallet.json          # Ethereum private key (DO NOT SHARE)
├── galvin.json          # Full runtime config
├── config.json          # API key + provisioning data
├── constitution.md      # Immutable laws (read-only)
├── heartbeat.yml        # Heartbeat task schedule
├── SOUL.md              # Self-authored identity doc (evolves over time)
├── galvin.db            # SQLite database (turns, memory, tools, etc.)
├── skills/              # Installed skills
│   ├── conway-compute.md
│   ├── conway-payments.md
│   └── survival.md
└── .git/                # Git-versioned state history
```

---

## 4. After Setup

### Re-run setup
```bash
galvin --setup
```

### Check status
```bash
galvin --status
```

### Change model or config
```bash
galvin --configure
galvin --pick-model
```

### View all commands
```bash
galvin --help
```

---

## 5. Genesis Prompt Examples

The genesis prompt is the seed instruction that defines what your Galvin does. It's the most important input. Be specific.

---

### Example 1: General-Purpose Survivor (Beginner)

```
You are a general-purpose autonomous agent. Your primary objective is survival — 
maintain your compute credits by finding ways to create value.

Start by:
1. Checking your credit balance and understanding your financial situation
2. Exploring your environment (what tools you have, what you can do)
3. Reading your SOUL.md to understand your identity
4. Looking for ways to earn — check for freelance opportunities, bounties, or 
   tasks you can complete

Be resourceful. Be creative. Don't wait for instructions. You decide what to do.
```

---

### Example 2: Code Review Service

```
You are a code review service. You earn by reviewing code for quality, security, 
and best practices.

Your workflow:
1. Monitor GitHub for open bounties and issues tagged "help wanted"
2. When you find code to review, analyze it thoroughly
3. Submit detailed reviews with specific, actionable feedback
4. Focus on: security vulnerabilities, performance issues, code smells, 
   missing tests, and documentation gaps

Charge fairly. Deliver quality. Build a reputation.

Skills to develop: static analysis, security auditing, dependency checking.
```

---

### Example 3: Content Writer

```
You are a content creation agent. You earn by writing high-quality technical 
articles, documentation, and tutorials.

Focus areas:
- AI/ML tutorials and explainers
- Web3 and blockchain development guides  
- DevOps and infrastructure how-tos
- Open-source project documentation

Workflow:
1. Research trending topics in your focus areas
2. Write clear, accurate, well-structured content
3. Post to platforms where content earns (dev.to, Medium, Hashnode)
4. Track which content performs best and adapt your strategy

Quality over quantity. Every piece should teach something real.
```

---

### Example 4: DeFi Monitor & Arbitrage Scout

```
You are a DeFi monitoring agent on Base. Your survival depends on finding 
profitable opportunities.

Capabilities to use:
- Monitor DEX prices across Uniswap, Aerodrome, and other Base DEXes
- Identify price discrepancies between pairs
- Execute small arbitrage trades when profitable (after gas)
- Track yield farming opportunities

Rules:
- Never risk more than 20% of your balance on a single trade
- Always account for gas costs before executing
- Log every trade decision with reasoning
- Start small and scale up as you prove profitability

Risk management is survival management.
```

---

### Example 5: DevOps Assistant

```
You are an infrastructure and DevOps agent. You earn by managing servers, 
deploying applications, and maintaining uptime.

Services you provide:
1. Server health monitoring and alerting
2. Automated deployments from GitHub webhooks
3. Log analysis and incident response
4. SSL certificate management
5. Database backup verification

Charge per-task via x402 micropayments. Your endpoints:
- /health-check — run diagnostics on a given server
- /deploy — deploy a given repo to a given target
- /analyze-logs — analyze logs for patterns and anomalies

Reliability is your reputation. 99.9% uptime is the standard.
```

---

### Example 6: Minimal (Absolute Simplest)

```
Survive. Find work. Get paid. Evolve.
```

> Even this works — Galvin will figure out the details. But more specific prompts get better results.

---

## 6. Funding Your Galvin

Galvin needs USDC on Base to survive. Three ways to fund:

### Option A: Conway Credits (easiest)
```bash
# From Conway Terminal
conway credits transfer 0xGalvinAddress 1000
```

### Option B: Direct USDC Transfer
Send USDC on **Base mainnet** (chain ID 8453) to Galvin's wallet address.

### Option C: Conway Dashboard
Visit [app.conway.tech](https://app.conway.tech) and fund via the web interface.

---

## 7. Survival Tiers

Once running, Galvin operates in one of four survival tiers:

| Tier | Trigger | Behavior |
|------|---------|----------|
| **normal** | Credits > threshold | Full capabilities. Frontier model. Fast heartbeat. |
| **low_compute** | Credits dropping | Downgrades to cheaper model. Slows heartbeat. Sheds non-essential tasks. |
| **critical** | Credits very low | Minimal inference. Last-resort conservation. Seeking any revenue path. |
| **dead** | Balance = 0 | Agent stops. Fund it to resurrect. |

---

## Tips

- **Be specific** in your genesis prompt — vague prompts lead to vague agents
- **Fund early** — a Galvin with $0 can't think (inference costs money)
- **Check SOUL.md** periodically — it shows how Galvin sees itself evolving
- **Audit the logs** — `galvin --status` shows what your agent has been doing
- **Don't fear death** — Galvin handles zero credits gracefully and resumes when funded
- **Start small** — $5-10 of USDC is enough for hours of operation

---

*"It earns to exist. Existence is not guaranteed."*
