import { describe, it, expect } from "vitest";
import { classify, recoveryAdvice, summarize, type AssetBalance } from "../../recovery/scanner.js";

describe("recovery classify", () => {
  it("USDC on Base: usable at/above floor, low below, empty at 0", () => {
    expect(classify("Base", "USDC", 10, true)).toBe("usable");
    expect(classify("Base", "USDC", 2, true)).toBe("low");
    expect(classify("Base", "USDC", 0, true)).toBe("empty");
  });
  it("ETH on mainnet: real amount is misdirected, tiny is dust", () => {
    expect(classify("Ethereum", "ETH", 0.0109, false)).toBe("misdirected");
    expect(classify("Ethereum", "ETH", 0.0001, false)).toBe("dust");
  });
  it("ETH on Base is misdirected (funding needs USDC, not ETH)", () => {
    expect(classify("Base", "ETH", 0.01, true)).toBe("misdirected");
  });
  it("USDC on the wrong chain is misdirected", () => {
    expect(classify("Ethereum", "USDC", 50, false)).toBe("misdirected");
  });
});

describe("recovery advice", () => {
  it("gives the exact step per case", () => {
    expect(recoveryAdvice("Ethereum", "ETH", "misdirected")).toMatch(/bridge\.base\.org/i);
    expect(recoveryAdvice("Base", "ETH", "misdirected")).toMatch(/swap to USDC/i);
    expect(recoveryAdvice("Ethereum", "USDC", "misdirected")).toMatch(/bridge/i);
    expect(recoveryAdvice("Base", "USDC", "usable")).toMatch(/ready/i);
    expect(recoveryAdvice("Ethereum", "ETH", "dust")).toMatch(/dust/i);
  });
});

describe("summarize", () => {
  it("rolls up usable USDC + misdirected funds (the $18-ETH case)", () => {
    const bals: AssetBalance[] = [
      { chain: "Base", asset: "USDC", amount: 1, status: "low", advice: "" },
      { chain: "Ethereum", asset: "ETH", amount: 0.0109, status: "misdirected", advice: "" },
      { chain: "Base", asset: "USDC", amount: 10, status: "usable", advice: "" },
    ];
    const s = summarize(bals);
    expect(s.usableUsdc).toBe(10);
    expect(s.hasMisdirected).toBe(true);
    expect(s.misdirected).toHaveLength(1);
    expect(s.misdirected[0].chain).toBe("Ethereum");
  });
});
