import { describe, it, expect } from "vitest";
import { classifyType, isEarned, isSpent, isEarnedInflow } from "../../accounting/classify.js";

describe("classifyType — only genuine earnings count as income", () => {
  it("transfer_in is earned", () => {
    expect(classifyType("transfer_in")).toBe("earned");
    expect(isEarned("transfer_in")).toBe(true);
  });

  it("buying credits / topup is SPENDING, never income", () => {
    expect(classifyType("credit_purchase")).toBe("spent");
    expect(classifyType("topup")).toBe("spent");
    expect(isEarned("credit_purchase")).toBe(false);
    expect(isEarned("topup")).toBe(false);
  });

  it("outflows and costs are spent", () => {
    for (const t of ["transfer_out", "inference", "x402_payment", "tool_use"]) {
      expect(isSpent(t)).toBe(true);
      expect(isEarned(t)).toBe(false);
    }
  });
});

describe("isEarnedInflow — own money is never income", () => {
  const wallet = "0xEbf6E981F893B83cab55dc2b18B2F2D3e34745FB";
  const owner = "0xAa8230c1DAEff7d816Cea415abEd2297e80DaB86";

  it("a genuine third-party payment IS earned", () => {
    expect(isEarnedInflow("0xCustomer", "0xCustomer", wallet, owner)).toBe(true);
  });

  it("Galvin's own swap/recovery (self-initiated tx) is NOT earned", () => {
    // recovery: Galvin signs the swap; USDC arrives from a DEX pool
    expect(isEarnedInflow(wallet, "0xUniswapPool", wallet, owner)).toBe(false);
    // case-insensitive
    expect(isEarnedInflow(wallet.toLowerCase(), "0xpool", wallet, owner)).toBe(false);
  });

  it("token coming out of Galvin's own address is NOT earned", () => {
    expect(isEarnedInflow("0xAnyone", wallet, wallet, owner)).toBe(false);
  });

  it("owner funding (as initiator or token source) is NOT earned", () => {
    expect(isEarnedInflow(owner, owner, wallet, owner)).toBe(false);
    expect(isEarnedInflow("0xExchange", owner, wallet, owner)).toBe(false);
  });

  it("works without a known owner", () => {
    expect(isEarnedInflow("0xCustomer", "0xCustomer", wallet)).toBe(true);
    expect(isEarnedInflow(wallet, "0xpool", wallet)).toBe(false);
  });
});
