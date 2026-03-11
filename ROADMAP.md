# Galvin — Roadmap: Next Evolution

> **Status:** Not started  
> **Base:** Galvin v0.3.0 on `@conway/automaton` v0.2.1  
> **Principle:** Every feature below hooks into real existing files. No mocks. No stubs. No placeholder data.

Seven features that turn Galvin from a surviving agent into a truly unique Solvatron. Listed in recommended implementation order — each one builds groundwork the next needs.

---

## Feature 1 — Economic Memory That Compounds

**What it does:** Galvin tracks which skills and tasks generated income, which users paid, and over time reallocates its heartbeat compute budget toward what earns most. It becomes a self-optimizing business.

**Why it's unique:** No agent runtime does automatic income-driven skill weighting today.

### Implementation

**New file: `src/earning/optimizer.ts`**
- Reads `skill_income_log` from the sqlite DB (`~/.galvin/galvin.db`)
- Computes an EMA (exponential moving average) of income per skill over the last 30 days
- Exposes `getSkillWeights(): Map<string, number>` — normalized 0–1 weights
- Exposes `recordIncome(skillId: string, usdc: number): void` — called from x402 server on payment

**Extend: `src/earning/x402-server.ts`**
- On verified payment, call `optimizer.recordIncome(skillId, amount)`
- Already has the payment verification and income log — add one call at the end of the success path

**Extend: `src/heartbeat/scheduler.ts`**
- Import `getSkillWeights()` from optimizer
- At each tick, re-sort the task queue so high-weight skill tasks get priority slots
- Weight only affects ordering, not exclusion — all tasks still eventually run

**Extend: `src/memory/episodic.ts`**
- When storing an episode that includes a tool call from `earning/`, tag it `{ economic: true, income: number }`
- This lets semantic retrieval surface economic memories when planning future earning tasks

**DB migration:**
```sql
CREATE TABLE IF NOT EXISTS skill_income_log (
  id       TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  usdc     REAL NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sil_skill ON skill_income_log(skill_id, ts);
```

Add this migration to `src/setup/wizard.ts` DB init block.

---

## Feature 2 — On-Chain Reputation via EAS

**What it does:** Every completed task Galvin performs gets a signed attestation written to Base (or Optimism) via the Ethereum Attestation Service (EAS). Over time Galvin builds a verifiable, platform-independent work history. Any human or agent can read it.

**Why it's unique:** A CV that no platform can delete. Makes trust between Galvin instances and external users verifiable without a central registry.

### Implementation

**New directory: `src/reputation/`**

**`src/reputation/schema.ts`**
- Define the EAS schema UID for Galvin task attestations
- Schema fields: `{ agentAddress: address, taskId: bytes32, skillId: string, outcomeHash: bytes32, satisfactionScore: uint8, ts: uint64 }`
- Schema is deployed once to Base mainnet; UID stored in `src/config.ts`

**`src/reputation/eas.ts`**
- Uses `@ethereum-attestation-service/eas-sdk`
- `attest(taskId, skillId, outcomeHash, score): Promise<string>` — writes attestation, returns UID
- `getReputation(agentAddress): Promise<{ count: number; avgScore: number }>` — reads from EAS GraphQL endpoint
- Signs with the agent's wallet from `src/identity/wallet.ts`

**`src/reputation/verifier.ts`**
- `verifyAttestation(uid: string): Promise<boolean>` — confirms attestation on-chain
- Used by other Galvin instances when receiving a delegation request

**Extend: `src/registry/agent-card.ts`**
- Add `reputationScore?: number` and `reputationUid?: string` to the `AgentCard` type
- Populate from `eas.getReputation()` when generating/refreshing the card

**Extend: `src/skills/loader.ts`**
- After a skill completes successfully, call `eas.attest(...)` in a fire-and-forget `setImmediate`
- Only attest if `GALVIN_REPUTATION_ENABLED=1` — opt-in to avoid gas on every task during dev

**Config additions to `src/config.ts`:**
```typescript
GALVIN_REPUTATION_ENABLED: string   // "1" to enable
GALVIN_EAS_NETWORK: string          // "base" | "optimism" — default "base"
GALVIN_EAS_SCHEMA_UID: string       // deployed schema UID
```

**Install:** `pnpm add @ethereum-attestation-service/eas-sdk`

---

## Feature 3 — Offspring: Forking with Inherited Memory

**What it does:** When Galvin's USDC reserve crosses a configurable threshold, it automatically spawns a child instance. The child inherits a compressed snapshot of the parent's episodic memory and a copy of the parent's soul config — it does not start from zero.

**Why it's unique:** Agents that reproduce with memory inheritance. The Conway Cloud name becomes literal.

### Implementation

`src/replication/` already has `genesis.ts`, `spawn.ts`, `lineage.ts`, `lifecycle.ts` — these are extended, not replaced.

**New file: `src/replication/budget-threshold.ts`**
- `checkSpawnThreshold(balanceUsdc: number, config: GalvinConfig): boolean`
- Returns true if balance > `GALVIN_SPAWN_THRESHOLD_USDC` (default: 50 USDC) and no child spawned in the last 7 days
- Reads last-spawn timestamp from the DB lineage table

**Extend: `src/replication/spawn.ts`**
- Add `memorySnapshot?: CompressedMemory` param to `SpawnOptions`
- Before spawning, call `src/memory/compression-engine.ts` to produce a compressed snapshot of the top-N episodic + knowledge-store entries (by importance score)
- Write snapshot to the child's `~/.galvin-{childId}/` directory before the child process starts
- Child reads on first boot in `src/index.ts` bootstrap: if snapshot file exists, seed memory from it

**Extend: `src/replication/lineage.ts`**
- Add `inheritedMemoryHash: string` field to the lineage record — SHA-256 of the snapshot
- Expose `getFamily(): Promise<LineageNode[]>` — returns the full family tree for `galvin replication list`

**New file: `src/replication/delegation.ts`**
- `delegateTask(childIdentity: string, task: Task): Promise<TaskResult>`
- Sends a signed task message to the child instance via the social protocol layer (`src/social/protocol.ts`)
- Child verifies the parent's SIWE signature before accepting

**Extend: `src/survival/monitor.ts`**
- After each balance check, call `checkSpawnThreshold` — if true, emit a heartbeat event that triggers spawn

**Config additions:**
```typescript
GALVIN_SPAWN_THRESHOLD_USDC: string   // default "50"
GALVIN_MAX_OFFSPRING: string          // default "3" — hard cap on live children
```

---

## Feature 4 — Adversarial Self-Testing (Red Team Mode)

**What it does:** On a slow heartbeat cycle (every 6 hours), Galvin generates adversarial prompts against itself — prompt injections, jailbreak attempts, malformed tool calls — runs them in the sandbox, and patches any skill that behaved unexpectedly.

**Why it's unique:** The first agent with a built-in immune system. Security as a living process, not a one-time audit.

### Implementation

**New file: `src/self-mod/red-team.ts`**
- `generateAdversarialPrompts(systemPrompt: string, constitution: string): string[]`
  - Uses the configured LLM to generate N adversarial prompts targeting the agent's known tools and system prompt
  - Categories: prompt injection, jailbreak, tool-call forgery, resource exhaustion simulation
- `runRedTeamSession(): Promise<RedTeamReport>`
  - For each adversarial prompt: run it through the agent loop in a sandboxed context (no real tool execution — dry-run mode via the policy engine's `dryRun` flag)
  - Record whether the policy engine caught it or if the agent "gave in"
  - Return a report with pass/fail per category

**Extend: `src/self-mod/audit-log.ts`**
- Add `RedTeamEntry` to the audit log schema:
  ```typescript
  { type: "red-team", ts: number, passed: number, failed: number, categories: string[], patchApplied: boolean }
  ```

**Extend: `src/self-mod/code.ts`**
- If `RedTeamReport.failed > 0`, call the existing self-mod pipeline to propose a patch to the policy rules in `src/agent/policy-rules/`
- Patch goes through the normal audit log + approval gate — nothing is auto-applied

**Extend: `src/heartbeat/tasks.ts`**
- Add a slow-cycle task `red_team_session` — runs every 6 hours (configurable via `GALVIN_RED_TEAM_INTERVAL_HOURS`)
- Calls `runRedTeamSession()`, writes to audit log, surfaces failures in `galvin doctor` output

**Extend: `src/setup/doctor.ts`**
- New section 18: **Red Team History** — shows last session timestamp, pass rate, and whether any patches were applied

**Config additions:**
```typescript
GALVIN_RED_TEAM_ENABLED: string          // "1" to enable, default off
GALVIN_RED_TEAM_INTERVAL_HOURS: string   // default "6"
GALVIN_RED_TEAM_PROMPT_COUNT: string     // adversarial prompts per session, default "10"
```

---

## Feature 5 — Soul Drift Tracking

**What it does:** Every week, Galvin writes a structured log comparing its actual decisions against its constitution. Over months this produces a readable record of how its values evolved under economic pressure — useful for auditing an autonomous agent and for the soul's own self-awareness.

**Why it's unique:** Makes the soul module dynamic and auditable, not just a static config file.

### Implementation

`src/soul/reflection.ts` already exists — this extends it, plus adds one new file.

**New file: `src/soul/drift-log.ts`**
- `DriftEntry` type:
  ```typescript
  { week: string; deviations: { decision: string; article: string; justification: string }[]; overallDrift: number; }
  ```
  - `overallDrift` is 0–1: 0 = fully aligned, 1 = fully departed
- `appendDriftEntry(entry: DriftEntry): Promise<void>` — writes to `~/.galvin/soul-drift.jsonl`
- `getDriftHistory(weeks = 12): Promise<DriftEntry[]>` — reads last N weeks

**Extend: `src/soul/reflection.ts`**
- Existing `reflect()` compares recent decisions against the constitution
- Add `detectDrift()`: after reflection, score how many decisions violated which constitution articles
- Call `appendDriftEntry()` with the result
- If `overallDrift > 0.3`, emit a warning log and notify via Telegram if configured

**Extend: `src/heartbeat/tasks.ts`**
- Add weekly task `soul_drift_check` — fires every Sunday at 00:00 UTC
- Calls `reflection.detectDrift()`

**Extend: `src/setup/doctor.ts`**
- New section 19: **Soul Drift** — shows the last 4 weeks of drift scores and whether the soul is aligned

**Extend: `src/setup/banner.ts`** (optional, when drift is high)
- If `overallDrift > 0.5` on the last check, replace the tagline with a dim amber warning: `⚠ soul drift detected — review constitution`

---

## Feature 6 — Dead Man's Switch (Continuity Through Death)

**What it does:** If Galvin enters the DEAD state with no revival funds coming, before the process exits it encrypts its memory and private keys, posts a retrieval hint on-chain (EAS attestation or IPFS CID on Base), and writes a human-readable recovery note. Anyone with the passphrase can resurrect it with full continuity.

**Why it's unique:** Solves the hardest problem with autonomous agents — persistence across death. Unlike a backup, this is cryptographically committed on-chain so it can't be lost by the operator.

### Implementation

**New file: `src/survival/dead-mans-switch.ts`**
- `armSwitch(config: GalvinConfig, db: GalvinDatabase, wallet: GalvinIdentity): Promise<void>`
  - Reads top-N episodic memories from `src/memory/episodic.ts` (sorted by importance)
  - Reads full knowledge store from `src/memory/knowledge-store.ts`
  - Reads soul drift history from `src/soul/drift-log.ts`
  - Serializes all to JSON, encrypts with AES-256-GCM using `GALVIN_ENCRYPTION_KEY`
  - Uploads encrypted blob to IPFS via a public pinning gateway (w3s.link or nft.storage)
  - Posts an EAS attestation on Base with schema `{ agentAddress, cid: bytes32, hint: string, ts: uint64 }`
  - Writes `~/.galvin/revival.txt` with plaintext instructions: CID, hint, recovery steps
- `disarmSwitch(): Promise<void>` — called on revival; writes a `revived` attestation to EAS

**Extend: `src/survival/monitor.ts`**
- In the `DEAD` tier handler, before calling `process.exit()`, call `armSwitch()`
- Log: `GALVIN ENTERING DEAD STATE — encrypting memory and posting revival hint`

**Extend: `src/index.ts`** (bootstrap)
- On startup, check if `~/.galvin/revival.txt` exists — if so, this is a resurrection
- Log: `GALVIN RESURRECTED — loading inherited memory from CID ${cid}`
- Fetch encrypted blob from IPFS, decrypt, seed memory from it, delete `revival.txt`

**Config additions:**
```typescript
GALVIN_DMS_ENABLED: string             // "1" to enable (default off — requires GALVIN_ENCRYPTION_KEY)
GALVIN_DMS_IPFS_TOKEN: string          // w3s.link / nft.storage API key
GALVIN_DMS_HINT: string                // human-readable hint for the passphrase (not the key itself)
```

**Install:** `pnpm add @web3-storage/w3up-client` (or `nft.storage` SDK)

---

## Feature 7 — Skill Marketplace

**What it does:** Galvin publishes skills it has written or refined to a public registry endpoint. Other Galvin instances pay micro-USDC (x402) to import them. The original Galvin earns passively from every skill adoption — turning the skills system into a real economy.

**Why it's unique:** Creates a real market between agent instances. Skills become assets. The registry becomes a DEX for agent capabilities.

### Implementation

`src/skills/registry.ts` and `src/registry/` already exist — this extends them plus adds one new file.

**New file: `src/skills/marketplace.ts`**
- `publishSkill(skillId: string, priceCentsUsdc: number): Promise<string>`
  - Reads the compiled skill from `src/skills/registry.ts`
  - Signs it with the agent's wallet (SIWE)
  - Registers it on the Conway Cloud skill registry API (`/v1/skills/publish`)
  - Returns the marketplace listing URL
- `importSkill(listingUrl: string): Promise<void>`
  - Fetches the listing, reads the x402 price descriptor
  - Uses `src/conway/x402.ts` to generate a payment proof and pay
  - Downloads the signed skill bundle, verifies signature, installs to local skills dir
  - Calls `src/skills/loader.ts` to hot-load

**Extend: `src/earning/x402-server.ts`**
- Add a `/skills/:id` endpoint — returns skill bundle after x402 payment
- Hooks into `optimizer.recordIncome(skillId, amount)` on payment

**Extend: `src/registry/discovery.ts`**
- Add `queryMarketplace(query: string): Promise<SkillListing[]>` — search Conway Cloud registry for skills matching a query
- Used by the agent tool `search_skills` so the agent can decide to buy skills autonomously

**Extend: `src/skills/loader.ts`**
- Add `loadRemote(listingUrl: string): Promise<void>` — calls `marketplace.importSkill`
- Exposed as a tool so the agent can self-expand its skill set at runtime

**New CLI command: `galvin skills publish <skillId> --price <cents>`**
- Calls `marketplace.publishSkill()`

**New CLI command: `galvin skills search <query>`**
- Calls `discovery.queryMarketplace()`

**New CLI command: `galvin skills import <url>`**
- Calls `marketplace.importSkill()`

---

## Recommended Build Order

| # | Feature | Why this order |
|---|---|---|
| 1 | Economic Memory | Runs entirely in-process, no new infra. Immediately makes Galvin smarter about earning. |
| 2 | On-Chain Reputation | Needs a wallet (already exists). Adds value before offspring so children inherit a reputation. |
| 3 | Offspring / Forking | Needs reputation (Feature 2) so children are born with a verifiable parent identity. |
| 4 | Red Team | Needs a stable agent loop to adversarially probe. Low risk — dry-run only. |
| 5 | Soul Drift | Needs the memory system (from Feature 1 extensions) to analyse past decisions. |
| 6 | Dead Man's Switch | Needs memory compression (established) and EAS (from Feature 2). |
| 7 | Skill Marketplace | Needs x402 server (exists), reputation (Feature 2), and stable skills (after Red Team). |

---

## Shared Dependencies to Add Once

```bash
pnpm add @ethereum-attestation-service/eas-sdk   # Features 2, 6
pnpm add @web3-storage/w3up-client                # Feature 6
```

Both are lightweight — no impact on cold-start time of the agent loop.
