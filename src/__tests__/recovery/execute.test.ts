import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseEther } from "viem";
import { buildBridgeTx, BASE_L1_BRIDGE, fmtEth, minOut, buildSwapTx } from "../../recovery/execute.js";

const ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

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

describe("swap ETH→USDC on Base — slippage + calldata", () => {
  it("minOut applies slippage in basis points", () => {
    expect(minOut(1_000_000n, 100)).toBe(990_000n); // 1% off 1.0 USDC
    expect(minOut(1_000_000n, 50)).toBe(995_000n); // 0.5%
    expect(minOut(1_000_000n, 0)).toBe(1_000_000n);
  });

  it("builds exactInputSingle: WETH→USDC, fee 500, value = amountIn, slippage floor", () => {
    const amt = parseEther("0.0096");
    const tx = buildSwapTx("0xEbf6E981F893B83cab55dc2b18B2F2D3e34745FB", amt, 17_000_000n);
    expect(tx.value).toBe(amt);
    expect(tx.to.toLowerCase()).toBe("0x2626664c2603336e57b271c5c0b26f421741e481"); // SwapRouter02
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: tx.data });
    expect(decoded.functionName).toBe("exactInputSingle");
    const p = decoded.args[0] as {
      tokenIn: string; tokenOut: string; fee: number; amountIn: bigint; amountOutMinimum: bigint;
    };
    expect(p.tokenIn.toLowerCase()).toBe("0x4200000000000000000000000000000000000006"); // WETH
    expect(p.tokenOut.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC
    expect(p.fee).toBe(500);
    expect(p.amountIn).toBe(amt);
    expect(p.amountOutMinimum).toBe(17_000_000n);
  });
});
