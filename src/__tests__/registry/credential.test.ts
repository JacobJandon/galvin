import { describe, it, expect } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  toDidPkh,
  didToAddress,
  canonicalize,
  issueCredential,
  verifyCredential,
  issueOwnershipChallenge,
  verifyOwnership,
} from "../../registry/credential.js";

const newAccount = () => privateKeyToAccount(generatePrivateKey());

describe("DID (did:pkh)", () => {
  it("roundtrips address ↔ did:pkh and rejects junk", () => {
    const a = newAccount();
    const did = toDidPkh(a.address);
    expect(did).toMatch(/^did:pkh:eip155:8453:0x[a-fA-F0-9]{40}$/);
    expect(didToAddress(did)).toBe(a.address);
    expect(didToAddress("not-a-did")).toBeNull();
    expect(didToAddress("did:pkh:eip155:8453:0xshort")).toBeNull();
  });
});

describe("canonicalize", () => {
  it("is recursively key-order independent", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
    expect(canonicalize([{ z: 1, a: 2 }])).toBe('[{"a":2,"z":1}]');
  });
});

describe("Verifiable Credential", () => {
  it("issues and verifies a self-signed VC", async () => {
    const a = newAccount();
    const vc = await issueCredential({ tier: "emerging", earned: 0 }, a);
    expect(vc.issuer).toBe(toDidPkh(a.address));
    expect(vc.credentialSubject.id).toBe(toDidPkh(a.address));
    expect(vc.proof?.proofValue).toMatch(/^0x[a-fA-F0-9]+$/);
    const r = await verifyCredential(vc);
    expect(r.valid).toBe(true);
    expect(r.signer?.toLowerCase()).toBe(a.address.toLowerCase());
  });

  it("rejects a tampered credential (changed subject)", async () => {
    const a = newAccount();
    const vc = await issueCredential({ tier: "unproven", earned: 0 }, a);
    (vc.credentialSubject as Record<string, unknown>).earned = 1_000_000; // forge earnings
    const r = await verifyCredential(vc);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/signer does not match/);
  });

  it("rejects a forged issuer (claim to be another address)", async () => {
    const real = newAccount();
    const attacker = newAccount();
    const vc = await issueCredential({ tier: "established" }, real);
    vc.issuer = toDidPkh(attacker.address); // pretend the attacker issued it
    const r = await verifyCredential(vc);
    expect(r.valid).toBe(false);
  });

  it("rejects a VC with no proof", async () => {
    const a = newAccount();
    const vc = await issueCredential({ x: 1 }, a);
    delete vc.proof;
    const r = await verifyCredential(vc);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("no proof");
  });

  it("rejects a garbage signature", async () => {
    const a = newAccount();
    const vc = await issueCredential({ x: 1 }, a);
    vc.proof!.proofValue = "0xdeadbeef";
    const r = await verifyCredential(vc);
    expect(r.valid).toBe(false);
  });
});

describe("Ownership proof (L3)", () => {
  it("verifies a valid owner signature", async () => {
    const owner = newAccount();
    const agent = newAccount();
    const ch = issueOwnershipChallenge(toDidPkh(agent.address), owner.address);
    const sig = await owner.signMessage({ message: ch.statement });
    const r = await verifyOwnership(ch, sig);
    expect(r.valid).toBe(true);
    expect(r.owner?.toLowerCase()).toBe(owner.address.toLowerCase());
  });

  it("rejects a signature from an imposter key", async () => {
    const owner = newAccount();
    const imposter = newAccount();
    const agent = newAccount();
    const ch = issueOwnershipChallenge(toDidPkh(agent.address), owner.address);
    const sig = await imposter.signMessage({ message: ch.statement });
    const r = await verifyOwnership(ch, sig);
    expect(r.valid).toBe(false);
  });

  it("rejects an expired challenge", async () => {
    const owner = newAccount();
    const ch = issueOwnershipChallenge(toDidPkh(owner.address), owner.address, -1);
    const sig = await owner.signMessage({ message: ch.statement });
    const r = await verifyOwnership(ch, sig);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
});
