import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KyoIssuer, kyoChallenge, type KycProvider } from "../../registry/kyo-issuer.js";
import { verifyCredential, toDidPkh } from "../../registry/credential.js";
import {
  issueDelegation,
  issueSpendMandate,
  issueAgentPassport,
  presentPassport,
  verifyPassportPresentation,
} from "../../registry/passport.js";

const acct = () => privateKeyToAccount(generatePrivateKey());

describe("KYO issuer — the attestation anchor", () => {
  it("issues a self-tier Owner Passport after the owner proves wallet control (no external dep)", async () => {
    const authority = acct();
    const owner = acct();
    const issuer = new KyoIssuer({ authority });
    const ownerDid = toDidPkh(owner.address);
    const ch = kyoChallenge(ownerDid);
    const sig = await owner.signMessage({ message: ch });
    const kyo = await issuer.issueSelf(ownerDid, ch, sig, { displayName: "Jane" });
    expect(kyo.issuer).toBe(issuer.did); // signed by the authority
    expect(kyo.credentialSubject.id).toBe(ownerDid); // about the owner
    expect(kyo.credentialSubject.verificationTier).toBe("self");
    expect((await verifyCredential(kyo)).valid).toBe(true);
  });

  it("rejects a self-tier request whose signature isn't the owner's key", async () => {
    const issuer = new KyoIssuer({ authority: acct() });
    const owner = acct();
    const imposter = acct();
    const ownerDid = toDidPkh(owner.address);
    const ch = kyoChallenge(ownerDid);
    const sig = await imposter.signMessage({ message: ch });
    await expect(issuer.issueSelf(ownerDid, ch, sig)).rejects.toThrow(/does not prove control/);
  });

  it("refuses the kyc tier when no provider is configured (honest, not faked)", async () => {
    const issuer = new KyoIssuer({ authority: acct() });
    await expect(issuer.issueKyc(toDidPkh(acct().address), "ref")).rejects.toThrow(/not configured/);
  });

  it("issues kyc tier via a configured provider, and the KYO passes the merchant verifier", async () => {
    const authority = acct();
    const owner = acct();
    const agent = acct();
    const ownerDid = toDidPkh(owner.address);
    const agentDid = toDidPkh(agent.address);
    const stub: KycProvider = { name: "stub", isConfigured: () => true, verify: async () => ({ verified: true, jurisdiction: "US" }) };
    const issuer = new KyoIssuer({ authority, kycProvider: stub });

    const kyo = await issuer.issueKyc(ownerDid, "ref-123", { displayName: "Jane" });
    expect(kyo.credentialSubject.verificationTier).toBe("kyc");
    expect(kyo.credentialSubject.jurisdiction).toBe("US");

    const deleg = await issueDelegation(owner, agentDid, { scopes: ["purchase:flights"] });
    const mandate = await issueSpendMandate(owner, agentDid, { maxPerTxnCents: 100_000, categories: ["flights"] });
    const agentPass = await issueAgentPassport(agent, { ownerDid });
    const vp = await presentPassport(agent, [agentPass, deleg, mandate, kyo], "merchant-nonce");
    const r = await verifyPassportPresentation(vp, {
      challenge: "merchant-nonce",
      transaction: { amountCents: 50_000, merchant: "Delta", category: "flights" },
      requiredOwnerTier: "kyc",
      trustedIssuers: [issuer.did], // the merchant trusts this KYO authority
    });
    expect(r.reasons).toEqual(["ok"]);
    expect(r.valid).toBe(true);
  });
});
