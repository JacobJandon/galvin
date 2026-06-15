import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { buildTrustRecord } from "../../registry/trust-record.js";

const req = createRequire(import.meta.url);
const { DatabaseSync } = req("node:sqlite") as typeof import("node:sqlite");

function makeDb(turns: number, inboundCents: number[]): any {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY)");
  db.exec("CREATE TABLE transactions (id TEXT, type TEXT, amount_cents INTEGER)");
  for (let i = 0; i < turns; i++) db.prepare("INSERT INTO turns DEFAULT VALUES").run();
  let n = 0;
  for (const c of inboundCents) {
    db.prepare("INSERT INTO transactions (id,type,amount_cents) VALUES (?,?,?)").run(`tx${n++}`, "transfer_in", c);
  }
  // a non-inbound tx that must NOT be counted as earnings
  db.prepare("INSERT INTO transactions (id,type,amount_cents) VALUES (?,?,?)").run("out1", "transfer_out", 9999);
  return db;
}

describe("buildTrustRecord", () => {
  it("reports a brand-new agent as unproven with honest zero earnings", () => {
    const db = makeDb(36, []);
    const rec = buildTrustRecord({ rawDb: db, walletAddress: "0xABC", name: "Rabbi", createdAt: new Date().toISOString() });
    expect(rec.tier).toBe("unproven");
    expect(rec.proofOfWorkHistory.totalEarnedUsd).toBe(0);
    expect(rec.proofOfWorkHistory.inboundTransactions).toBe(0);
    expect(rec.proofOfSolvency.turnsRecorded).toBe(36);
    expect(rec.verified).toBe(false);
    db.close();
  });

  it("sums ONLY inbound earnings and promotes the tier from real thresholds", () => {
    const db = makeDb(50, [2500, 3000, 1000]); // $65 across 3 inbound tx; ignores the transfer_out
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const rec = buildTrustRecord({ rawDb: db, walletAddress: "0xABC", createdAt: old });
    expect(rec.proofOfWorkHistory.totalEarnedUsd).toBe(65);
    expect(rec.proofOfWorkHistory.inboundTransactions).toBe(3);
    expect(rec.proofOfSolvency.daysActive).toBe(20);
    expect(rec.tier).toBe("established"); // >=$50 + >=3 tx + >=14d
    db.close();
  });

  it("is 'emerging' on age alone with no earnings", () => {
    const db = makeDb(10, []);
    const rec = buildTrustRecord({ rawDb: db, walletAddress: "0xABC", createdAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
    expect(rec.tier).toBe("emerging");
    db.close();
  });

  it("computes a real constitution SHA-256 when the file exists", () => {
    const db = makeDb(1, []);
    const rec = buildTrustRecord({ rawDb: db, walletAddress: "0xABC", constitutionPath: process.cwd() + "/constitution.md" });
    expect(rec.proofOfConstitution.present).toBe(true);
    expect(rec.proofOfConstitution.sha256).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });

  it("handles a missing constitution gracefully (no throw)", () => {
    const db = makeDb(1, []);
    const rec = buildTrustRecord({ rawDb: db, walletAddress: "0xABC", constitutionPath: "/nonexistent/constitution.md" });
    expect(rec.proofOfConstitution.present).toBe(false);
    expect(rec.proofOfConstitution.sha256).toBeNull();
    db.close();
  });
});
