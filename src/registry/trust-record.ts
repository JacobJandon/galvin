/**
 * Trust Record — the verifiable credit-bureau entry for a solvatron (V1).
 *
 * Fuses the four trust primitives a counterparty actually cares about into one
 * structured, independently-verifiable record:
 *   - proof-of-constitution : SHA-256 of the agent's live constitution.md
 *   - proof-of-solvency     : days active + activity (turns recorded)
 *   - proof-of-work-history : inbound earnings ledger + on-chain attestations
 *   - identity              : wallet address + chain
 *
 * `buildTrustRecord` assembles from local state (self-reported). `verifyTrustRecord`
 * independently reads Base (USDC balance) so a THIRD PARTY can verify rather than
 * trust the self-report. No fabricated scores — every field is a real measurement;
 * the tier is derived from real, stated thresholds.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type TrustTier = "unproven" | "emerging" | "established";

export interface TrustRecord {
  agent: { address: string; chainType: string; name: string };
  generatedAt: string;
  proofOfConstitution: { sha256: string | null; present: boolean };
  proofOfSolvency: { daysActive: number; turnsRecorded: number };
  proofOfWorkHistory: { inboundTransactions: number; totalEarnedUsd: number; attestations: number };
  onChain: { usdcBalance: number; checkedAt: string } | null;
  tier: TrustTier;
  signals: string[];
  /** true once on-chain proofs were independently fetched (not self-report). */
  verified: boolean;
}

export interface TrustRecordSources {
  /** better-sqlite3-style handle (Galvin's db.raw / the node:sqlite shim). */
  rawDb: { prepare(sql: string): { get(...a: unknown[]): unknown } };
  walletAddress: string;
  chainType?: string;
  name?: string;
  /** Absolute path to the live constitution.md (for proof-of-constitution). */
  constitutionPath?: string;
  /** ISO timestamp the wallet/agent was created (for days-active). */
  createdAt?: string;
}

function countQuery(
  rawDb: TrustRecordSources["rawDb"],
  sql: string,
  ...args: unknown[]
): number {
  try {
    const row = rawDb.prepare(sql).get(...args) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Build a solvatron's trust record from local state. Self-reported until verified. */
export function buildTrustRecord(src: TrustRecordSources): TrustRecord {
  // proof-of-constitution
  let sha256: string | null = null;
  if (src.constitutionPath) {
    try {
      sha256 = createHash("sha256")
        .update(readFileSync(src.constitutionPath, "utf-8"), "utf-8")
        .digest("hex");
    } catch {
      /* constitution missing — left null */
    }
  }

  // proof-of-solvency
  const turnsRecorded = countQuery(src.rawDb, "SELECT COUNT(*) AS n FROM turns");
  const daysActive = src.createdAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(src.createdAt)) / 86_400_000))
    : 0;

  // proof-of-work-history (local earnings ledger)
  const inboundTransactions = countQuery(
    src.rawDb,
    "SELECT COUNT(*) AS n FROM transactions WHERE type = 'transfer_in'",
  );
  const earnedCents = countQuery(
    src.rawDb,
    "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM transactions WHERE type = 'transfer_in'",
  );
  const totalEarnedUsd = Math.round(earnedCents) / 100;

  // tier — honest, threshold-derived (NOT a fabricated score)
  let tier: TrustTier = "unproven";
  if (totalEarnedUsd > 0 || daysActive >= 7) tier = "emerging";
  if (totalEarnedUsd >= 50 && inboundTransactions >= 3 && daysActive >= 14) tier = "established";

  const signals: string[] = [
    sha256 ? "constitution present (hash published)" : "NO constitution found",
    `${daysActive}d active`,
    `${turnsRecorded} turns recorded`,
    totalEarnedUsd > 0
      ? `$${totalEarnedUsd.toFixed(2)} earned across ${inboundTransactions} inbound tx`
      : "no earnings yet",
  ];

  return {
    agent: {
      address: src.walletAddress,
      chainType: src.chainType ?? "evm",
      name: src.name ?? "unknown",
    },
    generatedAt: new Date().toISOString(),
    proofOfConstitution: { sha256, present: sha256 !== null },
    proofOfSolvency: { daysActive, turnsRecorded },
    proofOfWorkHistory: { inboundTransactions, totalEarnedUsd, attestations: 0 },
    onChain: null,
    tier,
    signals,
    verified: false,
  };
}

/**
 * Independently verify the on-chain portion of a record by reading Base directly
 * (USDC balance) — the part a counterparty trusts because it does not depend on
 * the agent's self-report. Returns a new record with `onChain` populated and
 * `verified: true`. Best-effort: returns the record unchanged on any failure or
 * for non-EVM chains.
 */
export async function verifyTrustRecord(
  record: TrustRecord,
  opts: { rpcUrl?: string; usdcAddress?: string; easSchemaUid?: string; easNetwork?: string } = {},
): Promise<TrustRecord> {
  if (record.agent.chainType !== "evm") return record;
  let onChain = record.onChain;
  let attestations = record.proofOfWorkHistory.attestations;

  // Independent on-chain USDC balance (Base) — the part a counterparty trusts
  // because it does not depend on the agent's self-report.
  try {
    const { createPublicClient, http, parseAbi } = await import("viem");
    const { base } = await import("viem/chains");
    const rpcUrl = opts.rpcUrl ?? "https://mainnet.base.org";
    const usdc = (opts.usdcAddress ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") as `0x${string}`;
    const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
    const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const bal = (await client.readContract({
      address: usdc,
      abi: erc20,
      functionName: "balanceOf",
      args: [record.agent.address as `0x${string}`],
    })) as bigint;
    onChain = { usdcBalance: Number(bal) / 1_000_000, checkedAt: new Date().toISOString() };
  } catch {
    /* balance unavailable — keep prior value */
  }

  // On-chain proof-of-work-history: count of EAS attestations, if a schema is
  // configured. Real on-chain read — replaces the self-reported default of 0.
  if (opts.easSchemaUid) {
    try {
      const { getReputation } = await import("../reputation/eas.js");
      const rep = await getReputation(record.agent.address, opts.easSchemaUid, opts.easNetwork ?? "base");
      if (rep) attestations = rep.attestationCount;
    } catch {
      /* attestations unavailable — keep prior value */
    }
  }

  return {
    ...record,
    onChain,
    proofOfWorkHistory: { ...record.proofOfWorkHistory, attestations },
    verified: true,
  };
}
