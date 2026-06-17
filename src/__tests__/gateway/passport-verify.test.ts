import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createDatabase } from "../../state/database.js";
import { startGateway, type GatewayServer } from "../../gateway/index.js";
import { toDidPkh } from "../../registry/credential.js";
import {
  issueOwnerPassport,
  issueDelegation,
  issueSpendMandate,
  issueAgentPassport,
  presentPassport,
} from "../../registry/passport.js";
import type { GalvinConfig } from "../../types.js";

let server: GatewayServer | undefined;
let dbPath = "";

afterAll(async () => {
  if (server) await server.close();
  try { fs.rmSync(dbPath); } catch { /* ignore */ }
});

describe("POST /passport/verify — production endpoint over real HTTP", () => {
  it("approves a valid purchase (200) and declines an over-limit one (402)", async () => {
    dbPath = path.join(os.tmpdir(), `gw-pp-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDatabase(dbPath);
    server = await startGateway({
      db,
      config: { name: "test", creatorAddress: "0xtest" } as unknown as GalvinConfig,
      address: "0xtest",
      port: 0,
    });

    const owner = privateKeyToAccount(generatePrivateKey());
    const agent = privateKeyToAccount(generatePrivateKey());
    const kyc = privateKeyToAccount(generatePrivateKey());
    const ownerDid = toDidPkh(owner.address);
    const agentDid = toDidPkh(agent.address);
    const kycDid = toDidPkh(kyc.address);
    const ownerPass = await issueOwnerPassport(kyc, ownerDid, { verificationTier: "kyc" });
    const deleg = await issueDelegation(owner, agentDid, { scopes: ["purchase:flights"] });
    const mandate = await issueSpendMandate(owner, agentDid, { maxPerTxnCents: 100_000, categories: ["flights"] });
    const agentPass = await issueAgentPassport(agent, { ownerDid });
    const challenge = "merchant-nonce-1";
    const vp = await presentPassport(agent, [agentPass, deleg, mandate, ownerPass], challenge);
    const reqBody = (amountCents: number) => ({
      presentation: vp,
      challenge,
      transaction: { amountCents, merchant: "Delta", category: "flights" },
      requiredOwnerTier: "kyc",
      trustedIssuers: [kycDid],
    });
    const post = (b: unknown) =>
      fetch(`http://127.0.0.1:${server!.port}/passport/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });

    const ok = await post(reqBody(50_000));
    expect(ok.status).toBe(200);
    expect((await ok.json()).valid).toBe(true);

    const declined = await post(reqBody(200_000));
    expect(declined.status).toBe(402); // Payment Required = declined
    const body = await declined.json();
    expect(body.valid).toBe(false);
    expect(body.reasons.join()).toMatch(/exceeds maxPerTxn/);
  });

  it("400s a malformed request", async () => {
    const res = await fetch(`http://127.0.0.1:${server!.port}/passport/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: "x" }), // missing presentation
    });
    expect(res.status).toBe(400);
  });
});
