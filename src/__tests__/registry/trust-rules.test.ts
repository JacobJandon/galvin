import { describe, it, expect } from "vitest";
import { computeReputation, HALF_LIFE_DAYS, type Attestation } from "../../registry/trust-rules.js";

const now = Date.parse("2026-06-17T00:00:00Z");
const att = (subject: string, issuer: string, kind: Attestation["kind"], daysAgo = 0): Attestation => ({
  subject,
  issuer,
  kind,
  issuedAt: new Date(now - daysAgo * 86_400_000).toISOString(),
});

describe("Solvatron trust rules — emergent reputation from simple local rules", () => {
  it("a DID with no attestations is unproven (score 0)", () => {
    const r = computeReputation("did:a", [], { now });
    expect(r.tier).toBe("unproven");
    expect(r.score).toBe(0);
  });

  it("reputation grows as trusted attestations accumulate (emergence)", () => {
    const attesterTrust = { "did:t": 1 };
    const one = computeReputation("did:a", [att("did:a", "did:t", "work")], { now, attesterTrust });
    const three = computeReputation(
      "did:a",
      [att("did:a", "did:t", "identity"), att("did:a", "did:t", "solvency"), att("did:a", "did:t", "work")],
      { now, attesterTrust },
    );
    expect(three.score).toBeGreaterThan(one.score);
    expect(three.tier).toBe("established"); // 20+15+10 = 45
  });

  it("rule 4 — a trusted attester counts far more than an unknown one", () => {
    const trusted = computeReputation("did:a", [att("did:a", "did:t", "work")], { now, attesterTrust: { "did:t": 1 } });
    const unknown = computeReputation("did:a", [att("did:a", "did:x", "work")], { now, unknownTrust: 0.2 });
    expect(trusted.score).toBeGreaterThan(unknown.score * 3);
  });

  it("rule 5 — a blacklist flag dominates: blacklisted, score 0", () => {
    const r = computeReputation(
      "did:a",
      [att("did:a", "did:t", "identity"), att("did:a", "did:t", "work"), att("did:a", "did:s", "blacklist")],
      { now, attesterTrust: { "did:t": 1, "did:s": 1 } },
    );
    expect(r.blacklisted).toBe(true);
    expect(r.tier).toBe("blacklisted");
    expect(r.score).toBe(0);
  });

  it("rule 5 — a revocation subtracts", () => {
    const attesterTrust = { "did:t": 1 };
    const before = computeReputation("did:a", [att("did:a", "did:t", "identity")], { now, attesterTrust });
    const after = computeReputation("did:a", [att("did:a", "did:t", "identity"), att("did:a", "did:t", "revocation")], { now, attesterTrust });
    expect(after.score).toBeLessThan(before.score);
  });

  it("recency — an attestation one half-life old counts ~half of a fresh one", () => {
    const attesterTrust = { "did:t": 1 };
    const fresh = computeReputation("did:a", [att("did:a", "did:t", "work", 0)], { now, attesterTrust });
    const old = computeReputation("did:a", [att("did:a", "did:t", "work", HALF_LIFE_DAYS)], { now, attesterTrust });
    expect(old.score).toBeCloseTo(fresh.score / 2, 1);
  });

  it("only counts attestations about the subject DID", () => {
    const r = computeReputation("did:a", [att("did:b", "did:t", "work"), att("did:a", "did:t", "work")], {
      now,
      attesterTrust: { "did:t": 1 },
    });
    expect(r.attestationCount).toBe(1);
  });
});
