import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseEther } from "viem";
import { buildBridgeTx, BASE_L1_BRIDGE, fmtEth } from "../../recovery/execute.js";

const DEPOSIT_ABI = [
  {
    type: "function",
    name: "depositETH",
    stateMutability: "payable",
    inputs: [
      { name: "_minGasLimit", type: "uint32" },
      { name: "_extraData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

describe("buildBridgeTx — the canonical Base bridge deposit", () => {
  it("targets the L1StandardBridge with the right value and depositETH calldata", () => {
    const value = parseEther("0.0099");
    const tx = buildBridgeTx(value, 200_000);
    expect(tx.to.toLowerCase()).toBe(BASE_L1_BRIDGE.toLowerCase());
    expect(tx.value).toBe(value);
    // decode the calldata back — proves it's a real depositETH(uint32,bytes) call
    const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data: tx.data });
    expect(decoded.functionName).toBe("depositETH");
    expect(decoded.args[0]).toBe(200_000);
    expect(decoded.args[1]).toBe("0x");
  });

  it("encodes the chosen minGasLimit", () => {
    const tx = buildBridgeTx(1n, 120_000);
    const decoded = decodeFunctionData({ abi: DEPOSIT_ABI, data: tx.data });
    expect(decoded.args[0]).toBe(120_000);
  });

  it("fmtEth formats wei to ETH", () => {
    expect(fmtEth(parseEther("0.0109"))).toBe("0.01090000");
  });
});
