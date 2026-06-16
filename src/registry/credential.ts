/**
 * Verifiable Credentials for solvatrons — verification stack L1 + L3.
 *
 * Turns any subject (e.g. a trust record) into a portable, OFFLINE-verifiable
 * W3C Verifiable Credential signed by the agent's own wallet (did:pkh). Anyone
 * can recover the signer from the proof and confirm the credential came from
 * that exact agent and was not tampered — without querying a chain or a server.
 *
 * Also provides ownership proof (L3): an agent issues an ownership challenge; the
 * owner signs it with their creator key; the agent (or anyone) verifies the
 * signature recovers the expected owner address.
 *
 * Crypto: EIP-191 personal-sign over canonical (sorted-key) JSON, via viem — the
 * same key that IS the agent's sovereign identity. No network, no funding.
 */
import { recoverMessageAddress } from "viem";
import type { PrivateKeyAccount } from "viem";

export const BASE_CHAIN_ID = 8453;

// ─── DID (did:pkh over the wallet address) ────────────────────

/** Derive the agent's DID from its address: did:pkh:eip155:<chainId>:0x… */
export function toDidPkh(address: string, chainId: number = BASE_CHAIN_ID): string {
  return `did:pkh:eip155:${chainId}:${address}`;
}

/** Extract the 0x address from a did:pkh, or null if malformed. */
export function didToAddress(did: string): string | null {
  const m = did.match(/^did:pkh:eip155:\d+:(0x[a-fA-F0-9]{40})$/);
  return m ? m[1]! : null;
}

// ─── Canonical JSON (deterministic, recursively sorted keys) ──

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

// ─── Verifiable Credential ────────────────────────────────────

export interface CredentialProof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string; // 0x EIP-191 signature
}

export interface VerifiableCredential {
  "@context": string[];
  type: string[];
  issuer: string; // did:pkh
  validFrom: string;
  credentialSubject: Record<string, unknown> & { id: string };
  proof?: CredentialProof;
}

/**
 * Issue a self-signed Verifiable Credential over `subject`, signed by `account`.
 * issuer == subject (self-attested). Returns the VC with its proof attached.
 */
export async function issueCredential(
  subject: Record<string, unknown>,
  account: PrivateKeyAccount,
  opts: { types?: string[]; chainId?: number } = {},
): Promise<VerifiableCredential> {
  const did = toDidPkh(account.address, opts.chainId ?? BASE_CHAIN_ID);
  const vc: VerifiableCredential = {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", ...(opts.types ?? ["SolvatronTrustRecord"])],
    issuer: did,
    validFrom: new Date().toISOString(),
    credentialSubject: { id: did, ...subject },
  };
  // Sign over the canonical body (everything except the not-yet-present proof).
  const proofValue = await account.signMessage({ message: canonicalize(vc) });
  vc.proof = {
    type: "EthereumEip191Signature2021",
    created: new Date().toISOString(),
    verificationMethod: `${did}#blockchainAccountId`,
    proofPurpose: "assertionMethod",
    proofValue,
  };
  return vc;
}

export interface VcVerifyResult {
  valid: boolean;
  issuer: string | null;
  signer: string | null;
  reason: string;
}

/**
 * Verify a VC offline: recover the signer from the proof over the canonical body
 * and confirm it matches the issuer DID's address. No network.
 */
export async function verifyCredential(vc: VerifiableCredential): Promise<VcVerifyResult> {
  if (!vc?.proof?.proofValue) {
    return { valid: false, issuer: vc?.issuer ?? null, signer: null, reason: "no proof" };
  }
  const issuerAddr = didToAddress(vc.issuer);
  if (!issuerAddr) {
    return { valid: false, issuer: vc.issuer, signer: null, reason: "issuer is not a did:pkh address" };
  }
  const { proof, ...body } = vc;
  let signer: string;
  try {
    signer = await recoverMessageAddress({
      message: canonicalize(body),
      signature: proof.proofValue as `0x${string}`,
    });
  } catch (e) {
    return { valid: false, issuer: vc.issuer, signer: null, reason: `bad signature: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ok = signer.toLowerCase() === issuerAddr.toLowerCase();
  return { valid: ok, issuer: vc.issuer, signer, reason: ok ? "ok" : "signer does not match issuer DID" };
}

// ─── Ownership proof (L3) ─────────────────────────────────────

export interface OwnershipChallenge {
  agentDid: string;
  ownerAddress: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  /** The exact message the owner must sign. */
  statement: string;
}

/** Issue an ownership challenge for the owner (creator address) to sign. */
export function issueOwnershipChallenge(
  agentDid: string,
  ownerAddress: string,
  ttlMs = 600_000,
): OwnershipChallenge {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const statement =
    `I claim ownership of solvatron ${agentDid}.\n` +
    `Owner: ${ownerAddress}\nNonce: ${nonce}\nIssued: ${issuedAt}`;
  return { agentDid, ownerAddress, nonce, issuedAt, expiresAt, statement };
}

export interface OwnershipVerifyResult {
  valid: boolean;
  owner: string | null;
  reason: string;
}

/**
 * Verify an owner's signature over a challenge: the signer must recover to the
 * expected owner (creator) address, and the challenge must not be expired.
 */
export async function verifyOwnership(
  challenge: OwnershipChallenge,
  signature: string,
): Promise<OwnershipVerifyResult> {
  if (Date.now() > Date.parse(challenge.expiresAt)) {
    return { valid: false, owner: null, reason: "challenge expired" };
  }
  let signer: string;
  try {
    signer = await recoverMessageAddress({
      message: challenge.statement,
      signature: signature as `0x${string}`,
    });
  } catch (e) {
    return { valid: false, owner: null, reason: `bad signature: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ok = signer.toLowerCase() === challenge.ownerAddress.toLowerCase();
  return { valid: ok, owner: signer, reason: ok ? "ok" : "signer is not the claimed owner" };
}
