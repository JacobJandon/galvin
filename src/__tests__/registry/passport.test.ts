import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { toDidPkh } from "../../registry/credential.js";
import {
  issueOwnerPassport,
  issueDelegation,
  issueSpendMandate,
  issueAgentPassport,
  presentPassport,
  verifyPassportPresentation,
  type SpendMandateOptions,
  type DelegationOptions,
} from "../../registry/passport.js";

const acct = () => privateKeyToAccount(generatePrivateKey());
const CHALLENGE = "delta-nonce-abc123";

async function fullSetup(over: { deleg?: Partial<DelegationOptions>; mandate?: Partial<SpendMandateOptions> } = {}) {
  const owner = acct();
  const agent = acct();
  const kyc = acct();
  const ownerDid = toDidPkh(owner.address);
  const agentDid = toDidPkh(agent.address);
  const ownerPass = await issueOwnerPassport(kyc, ownerDid, { displayName: "Jane", verificationTier: "kyc", jurisdiction: "US" });
  const deleg = await issueDelegation(owner, agentDid, { scopes: ["purchase:flights", "pay:bills"], ...over.deleg });
  const mandate = await issueSpendMandate(owner, agentDid, { maxPerTxnCents: 100_000, categories: ["flights"], ...over.mandate });
  const agentPass = await issueAgentPassport(agent, { ownerDid, name: "Galvin", status: "kyc-verified" });
  const vp = await presentPassport(agent, [agentPass, deleg, mandate, ownerPass], CHALLENGE);
  return { owner, agent, kyc, ownerDid, agentDid, vp };
}

const baseOpts = (kycDid: string) => ({
  challenge: CHALLENGE,
  transaction: { amountCents: 50_000, merchant: "Delta", category: "flights" },
  requiredOwnerTier: "kyc" as const,
  trustedIssuers: [kycDid],
});

describe("AI Passport — Delta verification", () => {
  it("approves a fully valid agent purchase", async () => {
    const s = await fullSetup();
    const r = await verifyPassportPresentation(s.vp, baseOpts(toDidPkh(s.kyc.address)));
    expect(r.reasons).toEqual(["ok"]);
    expect(r.valid).toBe(true);
    expect(r.ownerDid).toBe(s.ownerDid);
    expect(r.agentDid).toBe(s.agentDid);
    expect(r.authorizedAmountCents).toBe(100_000);
  });

  it("rejects a replayed presentation (wrong challenge)", async () => {
    const s = await fullSetup();
    const r = await verifyPassportPresentation(s.vp, { ...baseOpts(toDidPkh(s.kyc.address)), challenge: "other-nonce" });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/challenge mismatch/);
  });

  it("rejects a tampered credential", async () => {
    const s = await fullSetup();
    const m = s.vp.credentials.find((c) => c.type.includes("SpendMandate"))!;
    (m.credentialSubject as Record<string, unknown>).maxPerTxnCents = 999_999_999;
    const r = await verifyPassportPresentation(s.vp, baseOpts(toDidPkh(s.kyc.address)));
    expect(r.valid).toBe(false);
  });

  it("rejects an over-limit spend", async () => {
    const s = await fullSetup();
    const r = await verifyPassportPresentation(s.vp, {
      ...baseOpts(toDidPkh(s.kyc.address)),
      transaction: { amountCents: 200_000, merchant: "Delta", category: "flights" },
    });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/exceeds maxPerTxn/);
  });

  it("rejects an out-of-scope category", async () => {
    const s = await fullSetup();
    const r = await verifyPassportPresentation(s.vp, {
      ...baseOpts(toDidPkh(s.kyc.address)),
      transaction: { amountCents: 5_000, merchant: "Casino", category: "gambling" },
    });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/scopes do not cover|not in mandate/);
  });

  it("rejects an expired delegation", async () => {
    const s = await fullSetup({ deleg: { scopes: ["purchase:flights"], notAfter: new Date(Date.now() - 1000).toISOString() } });
    const r = await verifyPassportPresentation(s.vp, baseOpts(toDidPkh(s.kyc.address)));
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/Delegation expired/);
  });

  it("rejects a blacklisted agent", async () => {
    const s = await fullSetup();
    const r = await verifyPassportPresentation(s.vp, { ...baseOpts(toDidPkh(s.kyc.address)), isBlacklisted: () => true });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/blacklisted/);
  });

  it("rejects when owner tier is below the required tier", async () => {
    const owner = acct();
    const agent = acct();
    const ownerDid = toDidPkh(owner.address);
    const agentDid = toDidPkh(agent.address);
    const ownerPass = await issueOwnerPassport(owner, ownerDid, { verificationTier: "self" }); // only self-tier
    const deleg = await issueDelegation(owner, agentDid, { scopes: ["purchase:flights"] });
    const mandate = await issueSpendMandate(owner, agentDid, { maxPerTxnCents: 100_000, categories: ["flights"] });
    const agentPass = await issueAgentPassport(agent, { ownerDid });
    const vp = await presentPassport(agent, [agentPass, deleg, mandate, ownerPass], CHALLENGE);
    const r = await verifyPassportPresentation(vp, {
      challenge: CHALLENGE,
      transaction: { amountCents: 5_000, merchant: "Delta", category: "flights" },
      requiredOwnerTier: "kyc",
      trustedIssuers: [ownerDid],
    });
    expect(r.valid).toBe(false);
    expect(r.reasons.join()).toMatch(/below required/);
  });

  it("enforces a per-transaction one-time mandate", async () => {
    const owner = acct();
    const agent = acct();
    const ownerDid = toDidPkh(owner.address);
    const agentDid = toDidPkh(agent.address);
    const deleg = await issueDelegation(owner, agentDid, { scopes: ["purchase:flights"] });
    const mandate = await issueSpendMandate(owner, agentDid, {
      maxPerTxnCents: 100_000,
      categories: ["flights"],
      transaction: { amountCents: 50_000, merchant: "Delta", category: "flights", nonce: "txn-1" },
    });
    const agentPass = await issueAgentPassport(agent, { ownerDid });
    const vp = await presentPassport(agent, [agentPass, deleg, mandate], CHALLENGE);

    const ok = await verifyPassportPresentation(vp, {
      challenge: CHALLENGE,
      transaction: { amountCents: 50_000, merchant: "Delta", category: "flights", nonce: "txn-1" },
    });
    expect(ok.valid).toBe(true);

    const bad = await verifyPassportPresentation(vp, {
      challenge: CHALLENGE,
      transaction: { amountCents: 60_000, merchant: "Delta", category: "flights", nonce: "txn-1" },
    });
    expect(bad.valid).toBe(false);
    expect(bad.reasons.join()).toMatch(/per-transaction mandate amount/);
  });
});
