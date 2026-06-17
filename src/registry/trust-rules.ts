/**
 * The Solvatron Trust Protocol — five simple local rules that, repeated across
 * the network, make a global trust web *emerge* with no central authority.
 * Boids / ant-colony / Game-of-Life / blockchain: simple rules + scale + feedback
 * = complexity. No node sees the whole graph; each just follows the rules.
 *
 *   1. BE YOUR KEY        — identity is a wallet (a DID). No registrar, no signup.
 *   2. SIGN YOUR CLAIMS   — any claim about any DID is a signed attestation (a VC).
 *   3. VERIFY LOCALLY     — trust only what you can check yourself, offline.
 *   4. WEIGHT BY THE WEIGHER — an attestation is worth the attester's OWN trust
 *                           (transitive, PageRank-like): a vouch from a trusted,
 *                           solvent agent counts more than one from a stranger.
 *   5. REMEMBER BETRAYAL  — a proven-false claim or a scam/honeypot flag is a
 *                           NEGATIVE attestation that subtracts and isolates. Feedback.
 *
 * Rules 1-3 are credential.ts / passport.ts (DID, signed VCs, offline verify).
 * This module is rules 4-5: computeReputation() turns a local bag of verified
 * attestations into a score + tier. Run it everywhere; the trust web emerges.
 */

export type AttestationKind = "identity" | "solvency" | "work" | "vouch" | "revocation" | "blacklist";

/** A verified attestation (signature already checked via credential.ts). */
export interface Attestation {
  subject: string; // DID the claim is about
  issuer: string; // DID making the claim (the attester)
  kind: AttestationKind;
  issuedAt: string; // ISO timestamp
}

// Rule 5 in numbers: positive kinds add, negative kinds subtract; a blacklist dominates.
const KIND_WEIGHT: Record<AttestationKind, number> = {
  identity: 20,
  solvency: 15,
  work: 10,
  vouch: 5,
  revocation: -40,
  blacklist: -1000,
};

/** Attestations decay — recent behavior matters more (half-life in days). */
export const HALF_LIFE_DAYS = 180;

export interface ReputationOptions {
  /** Rule 4: each attester's own trust (0..1). Unknown attesters → unknownTrust. */
  attesterTrust?: Record<string, number>;
  unknownTrust?: number; // default 0.2
  now?: number;
}

export type ReputationTier = "blacklisted" | "unproven" | "emerging" | "established" | "trusted";

export interface Reputation {
  did: string;
  score: number;
  tier: ReputationTier;
  positive: number;
  negative: number;
  attestationCount: number;
  blacklisted: boolean;
}

function recencyFactor(issuedAt: string, now: number): number {
  const ms = Date.parse(issuedAt);
  if (!Number.isFinite(ms)) return 0;
  const ageDays = Math.max(0, (now - ms) / 86_400_000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * Rules 4 + 5 made concrete: the emergent local reputation of a DID, computed
 * from the verified attestations about it. Pure, deterministic, offline.
 */
export function computeReputation(
  did: string,
  attestations: Attestation[],
  opts: ReputationOptions = {},
): Reputation {
  const now = opts.now ?? Date.now();
  const unknownTrust = opts.unknownTrust ?? 0.2;
  const trustOf = (issuer: string) =>
    Math.max(0, Math.min(1, opts.attesterTrust?.[issuer] ?? unknownTrust));

  const about = attestations.filter((a) => a.subject === did);
  let positive = 0;
  let negative = 0;
  let blacklisted = false;

  for (const a of about) {
    if (a.kind === "blacklist") blacklisted = true;
    const w = KIND_WEIGHT[a.kind] * trustOf(a.issuer) * recencyFactor(a.issuedAt, now);
    if (w >= 0) positive += w;
    else negative += -w;
  }

  const score = blacklisted ? 0 : Math.max(0, positive - negative);
  const tier: ReputationTier = blacklisted
    ? "blacklisted"
    : score >= 50
      ? "trusted"
      : score >= 25
        ? "established"
        : score >= 8
          ? "emerging"
          : "unproven";

  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    did,
    score: round(score),
    tier,
    positive: round(positive),
    negative: round(negative),
    attestationCount: about.length,
    blacklisted,
  };
}
