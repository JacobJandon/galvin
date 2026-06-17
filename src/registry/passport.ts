/**
 * AI Passport — verified identity an agent presents to act in the world.
 *
 * Two passports (see AI_PASSPORT.md):
 *  - Owner Passport: the verified human/entity (the root of trust + liability).
 *  - Agent Passport: the agent's DID + an owner-signed Delegation + Spend Mandate.
 *
 * A verifier (e.g. Delta) is handed a Verifiable Presentation — the agent's
 * credentials plus a fresh signature over the verifier's challenge — and runs
 * verifyPassportPresentation() to answer, offline: is the agent real, does it
 * represent this owner, and did the owner authorize THIS spend?
 *
 * All credentials are EIP-191-signed VCs from credential.ts. No chain, no funding.
 */
import { recoverMessageAddress } from "viem";
import type { PrivateKeyAccount } from "viem";
import {
  issueCredential,
  issueAbout,
  verifyCredential,
  toDidPkh,
  didToAddress,
  canonicalize,
  type VerifiableCredential,
  type CredentialProof,
} from "./credential.js";

// ─── Owner Passport ───────────────────────────────────────────
export type OwnerTier = "self" | "email" | "kyc" | "institution";
const TIER_RANK: Record<OwnerTier, number> = { self: 0, email: 1, kyc: 2, institution: 3 };

export interface OwnerPassportClaims {
  displayName?: string;
  verificationTier: OwnerTier;
  jurisdiction?: string;
}

/** Issue an Owner Passport ABOUT `ownerDid`, signed by `signer` (the owner for
 *  self-tier, a KYC authority for higher tiers). */
export function issueOwnerPassport(
  signer: PrivateKeyAccount,
  ownerDid: string,
  claims: OwnerPassportClaims,
): Promise<VerifiableCredential> {
  return issueAbout(ownerDid, { ...claims }, signer, { types: ["OwnerPassport"] });
}

// ─── Delegation (owner → agent) ───────────────────────────────
export interface DelegationOptions {
  scopes: string[]; // e.g. ["purchase:flights", "purchase:groceries", "pay:bills"]
  notAfter?: string; // ISO expiry
}

export function issueDelegation(
  ownerAccount: PrivateKeyAccount,
  agentDid: string,
  opts: DelegationOptions,
): Promise<VerifiableCredential> {
  return issueAbout(
    agentDid,
    { ownerDid: toDidPkh(ownerAccount.address), scopes: opts.scopes, notAfter: opts.notAfter },
    ownerAccount,
    { types: ["AgentDelegation"] },
  );
}

// ─── Spend Mandate (owner → agent) ────────────────────────────
export interface SpendMandateOptions {
  maxPerTxnCents: number;
  dailyCapCents?: number;
  categories?: string[]; // allowed categories; omit = any
  notAfter?: string;
  /** Optional one-time authorization for a specific purchase. */
  transaction?: { amountCents: number; merchant: string; category?: string; nonce: string };
}

export function issueSpendMandate(
  ownerAccount: PrivateKeyAccount,
  agentDid: string,
  opts: SpendMandateOptions,
): Promise<VerifiableCredential> {
  return issueAbout(
    agentDid,
    { ownerDid: toDidPkh(ownerAccount.address), ...opts },
    ownerAccount,
    { types: ["SpendMandate"] },
  );
}

// ─── Agent Passport (self-issued) ─────────────────────────────
export interface AgentPassportClaims {
  ownerDid: string;
  name?: string;
  status?: "unverified" | "owner-verified" | "kyc-verified";
  tier?: string; // trust-record tier
}

export function issueAgentPassport(
  agentAccount: PrivateKeyAccount,
  claims: AgentPassportClaims,
): Promise<VerifiableCredential> {
  return issueCredential({ ...claims }, agentAccount, { types: ["AgentPassport"] });
}

// ─── Verifiable Presentation ──────────────────────────────────
export interface PassportPresentation {
  holder: string; // agent DID
  challenge: string;
  credentials: VerifiableCredential[];
  proof: CredentialProof;
}

/** Bundle the agent's credentials and sign over the verifier's fresh challenge. */
export async function presentPassport(
  agentAccount: PrivateKeyAccount,
  credentials: VerifiableCredential[],
  challenge: string,
): Promise<PassportPresentation> {
  const holder = toDidPkh(agentAccount.address);
  const body = { holder, challenge, credentials };
  const proofValue = await agentAccount.signMessage({ message: canonicalize(body) });
  return {
    holder,
    challenge,
    credentials,
    proof: {
      type: "EthereumEip191Signature2021",
      created: new Date().toISOString(),
      verificationMethod: `${holder}#blockchainAccountId`,
      proofPurpose: "authentication",
      proofValue,
    },
  };
}

// ─── Verifier (the merchant side) ─────────────────────────────
export interface TransactionContext {
  amountCents: number;
  merchant: string;
  category?: string;
  nonce?: string;
}

export interface PassportVerifyOptions {
  challenge: string; // the nonce the verifier issued (must match the presentation)
  transaction?: TransactionContext;
  requiredOwnerTier?: OwnerTier; // default "self"
  trustedIssuers?: string[]; // owner-passport issuer DIDs the verifier trusts for kyc+
  isBlacklisted?: (did: string) => boolean;
  now?: number; // injectable clock for tests
}

export interface PassportVerifyResult {
  valid: boolean;
  reasons: string[];
  agentDid: string | null;
  ownerDid: string | null;
  authorizedAmountCents?: number;
}

function scopeCovers(scopes: string[], category?: string): boolean {
  if (!category) return true;
  return scopes.some(
    (s) => s === "*" || s === category || s === `purchase:${category}` || s === "purchase:*",
  );
}

/** Run the full chain: holder proof → signatures → representation → spend
 *  authority → owner standing → blacklist. Never throws; returns reasons. */
export async function verifyPassportPresentation(
  vp: PassportPresentation,
  opts: PassportVerifyOptions,
): Promise<PassportVerifyResult> {
  const fail: string[] = [];
  const now = opts.now ?? Date.now();
  const expired = (notAfter?: unknown) =>
    typeof notAfter === "string" && Number.isFinite(Date.parse(notAfter)) && Date.parse(notAfter) < now;
  const find = (t: string) => vp.credentials.find((c) => c.type.includes(t));

  // 1. Holder proof — agent controls its DID, signed over the verifier's challenge.
  const holderAddr = didToAddress(vp.holder);
  if (!holderAddr) fail.push("holder is not a did:pkh");
  if (vp.challenge !== opts.challenge) fail.push("challenge mismatch (possible replay)");
  if (holderAddr && vp.challenge === opts.challenge) {
    try {
      const signer = await recoverMessageAddress({
        message: canonicalize({ holder: vp.holder, challenge: vp.challenge, credentials: vp.credentials }),
        signature: vp.proof.proofValue as `0x${string}`,
      });
      if (signer.toLowerCase() !== holderAddr.toLowerCase()) fail.push("holder proof signature invalid");
    } catch (e) {
      fail.push(`holder proof error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 2. Agent Passport — verifies + is about the holder.
  const agentPass = find("AgentPassport");
  let ownerDid: string | null = null;
  if (!agentPass) {
    fail.push("no AgentPassport");
  } else {
    if (!(await verifyCredential(agentPass)).valid) fail.push("AgentPassport signature invalid");
    if (agentPass.credentialSubject.id !== vp.holder) fail.push("AgentPassport subject is not the holder");
    ownerDid = (agentPass.credentialSubject.ownerDid as string) ?? null;
    if (!ownerDid) fail.push("AgentPassport names no owner");
  }

  // 3. Delegation — owner authorized this agent for this category, not expired.
  const deleg = find("AgentDelegation");
  if (!deleg) {
    fail.push("no AgentDelegation");
  } else {
    const r = await verifyCredential(deleg);
    if (!r.valid) fail.push("Delegation signature invalid");
    if (ownerDid && r.issuer !== ownerDid) fail.push("Delegation not issued by the owner");
    if (deleg.credentialSubject.id !== vp.holder) fail.push("Delegation subject is not the holder");
    if (expired(deleg.credentialSubject.notAfter)) fail.push("Delegation expired");
    const scopes = (deleg.credentialSubject.scopes as string[]) ?? [];
    if (opts.transaction && !scopeCovers(scopes, opts.transaction.category)) {
      fail.push(`Delegation scopes do not cover category "${opts.transaction.category}"`);
    }
  }

  // 4. Spend Mandate — amount/category within the owner's signed limits.
  const mandate = find("SpendMandate");
  let authorizedAmountCents: number | undefined;
  if (opts.transaction) {
    if (!mandate) {
      fail.push("no SpendMandate for a spend");
    } else {
      const r = await verifyCredential(mandate);
      const sub = mandate.credentialSubject;
      if (!r.valid) fail.push("SpendMandate signature invalid");
      if (ownerDid && r.issuer !== ownerDid) fail.push("SpendMandate not issued by the owner");
      if (sub.id !== vp.holder) fail.push("SpendMandate subject is not the holder");
      if (expired(sub.notAfter)) fail.push("SpendMandate expired");
      const max = Number(sub.maxPerTxnCents ?? 0);
      authorizedAmountCents = max;
      if (opts.transaction.amountCents > max) fail.push(`amount ${opts.transaction.amountCents}¢ exceeds maxPerTxn ${max}¢`);
      const cats = sub.categories as string[] | undefined;
      if (cats && opts.transaction.category && !cats.includes(opts.transaction.category)) {
        fail.push(`category "${opts.transaction.category}" not in mandate`);
      }
      const txn = sub.transaction as SpendMandateOptions["transaction"] | undefined;
      if (txn) {
        // Per-transaction one-time authorization: must match this purchase exactly.
        if (txn.amountCents !== opts.transaction.amountCents) fail.push("per-transaction mandate amount mismatch");
        if (txn.merchant !== opts.transaction.merchant) fail.push("per-transaction mandate merchant mismatch");
        if (opts.transaction.nonce && txn.nonce !== opts.transaction.nonce) fail.push("per-transaction mandate nonce mismatch");
      }
    }
  }

  // 5. Owner standing — verified at the required tier by a trusted issuer.
  const required = opts.requiredOwnerTier ?? "self";
  if (TIER_RANK[required] > 0) {
    const ownerPass = find("OwnerPassport");
    if (!ownerPass) {
      fail.push(`no OwnerPassport (need tier ${required})`);
    } else {
      const r = await verifyCredential(ownerPass);
      if (!r.valid) fail.push("OwnerPassport signature invalid");
      if (ownerDid && ownerPass.credentialSubject.id !== ownerDid) fail.push("OwnerPassport is about a different owner");
      const tier = ownerPass.credentialSubject.verificationTier as OwnerTier;
      if ((TIER_RANK[tier] ?? -1) < TIER_RANK[required]) fail.push(`owner tier ${tier} below required ${required}`);
      if (opts.trustedIssuers && r.issuer && !opts.trustedIssuers.includes(r.issuer)) {
        fail.push("OwnerPassport issuer is not trusted");
      }
    }
  }

  // 6. Blacklist / standing.
  if (opts.isBlacklisted?.(vp.holder)) fail.push("agent is blacklisted");

  return {
    valid: fail.length === 0,
    reasons: fail.length === 0 ? ["ok"] : fail,
    agentDid: vp.holder ?? null,
    ownerDid,
    authorizedAmountCents,
  };
}
