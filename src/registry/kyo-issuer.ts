/**
 * KYO Issuer — the Know Your Owner attestation anchor.
 *
 * The one piece the passport chain needs that isn't pure crypto: an authority
 * that vouches "this owner DID is a real, accountable party" at some tier. The
 * design is FEDERATED, not a monopoly — merchants trust an issuer by adding its
 * DID to `trustedIssuers`, and anyone can run one. Solvatron operates one.
 *
 * Tiers degrade gracefully so the anchor works TODAY with no external dependency:
 *   - self        — owner signs a challenge proving wallet control. No dep. ✅
 *   - email       — owner verifies an email code. Minimal dep (mail send).
 *   - kyc         — a pluggable KycProvider (Stripe Identity / Persona / Onfido)
 *                   proofs real-world identity. Needs an account → honest adapter
 *                   that refuses until wired (no faked verification).
 *   - institution — manual/enterprise review.
 *
 * Issuance reuses passport.ts (`issueOwnerPassport`); this adds the verification
 * gate + the authority key.
 */
import { recoverMessageAddress } from "viem";
import type { PrivateKeyAccount } from "viem";
import { issueOwnerPassport } from "./passport.js";
import { toDidPkh, didToAddress, type VerifiableCredential } from "./credential.js";

/** Proofs real-world identity for the `kyc` tier. Pluggable; needs an account. */
export interface KycProvider {
  readonly name: string;
  isConfigured(): boolean;
  verify(ownerDid: string, ref: string): Promise<{ verified: boolean; jurisdiction?: string; reason?: string }>;
}

/** Honest placeholder — refuses rather than faking verification. */
export class UnconfiguredKycProvider implements KycProvider {
  constructor(public readonly name = "kyc", private readonly hint = "Wire a KYC adapter (Stripe Identity / Persona / Onfido).") {}
  isConfigured(): boolean {
    return false;
  }
  async verify(): Promise<{ verified: boolean; reason: string }> {
    return { verified: false, reason: `${this.name} KYC not configured. ${this.hint}` };
  }
}

export interface KyoIssuerOptions {
  authority: PrivateKeyAccount; // the issuer's signing key (the anchor)
  kycProvider?: KycProvider;
}

/** A fresh challenge the owner signs to prove control of their DID (self tier). */
export function kyoChallenge(ownerDid: string): string {
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `Solvatron KYO — prove control of ${ownerDid}\nnonce: ${nonce}`;
}

export class KyoIssuer {
  readonly did: string;
  private readonly kyc: KycProvider;

  constructor(private readonly opts: KyoIssuerOptions) {
    this.did = toDidPkh(opts.authority.address);
    this.kyc = opts.kycProvider ?? new UnconfiguredKycProvider();
  }

  /** self tier — verify the owner signed the challenge with the DID's key, then issue. No external dependency. */
  async issueSelf(
    ownerDid: string,
    challenge: string,
    signature: string,
    claims: { displayName?: string } = {},
  ): Promise<VerifiableCredential> {
    const addr = didToAddress(ownerDid);
    if (!addr) throw new Error("ownerDid is not a did:pkh");
    let signer: string;
    try {
      signer = await recoverMessageAddress({ message: challenge, signature: signature as `0x${string}` });
    } catch (e) {
      throw new Error(`bad signature: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (signer.toLowerCase() !== addr.toLowerCase()) {
      throw new Error("signature does not prove control of ownerDid");
    }
    return issueOwnerPassport(this.opts.authority, ownerDid, { ...claims, verificationTier: "self" });
  }

  /** kyc tier — requires a configured provider to attest real-world identity. */
  async issueKyc(
    ownerDid: string,
    providerRef: string,
    claims: { displayName?: string } = {},
  ): Promise<VerifiableCredential> {
    if (!didToAddress(ownerDid)) throw new Error("ownerDid is not a did:pkh");
    if (!this.kyc.isConfigured()) throw new Error(`KYC tier unavailable: ${this.kyc.name} not configured`);
    const r = await this.kyc.verify(ownerDid, providerRef);
    if (!r.verified) throw new Error(`KYC failed: ${r.reason ?? "not verified"}`);
    return issueOwnerPassport(this.opts.authority, ownerDid, {
      ...claims,
      verificationTier: "kyc",
      jurisdiction: r.jurisdiction,
    });
  }
}
