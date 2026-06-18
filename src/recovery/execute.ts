/**
 * Automated recovery — execute the bridge that moves misdirected ETH back onto
 * Base (the funding chain), using the wallet key Galvin already holds.
 *
 * Cross-chain (Ethereum → Base) is the hard, risky half; this automates it via
 * the canonical Base bridge (L1StandardBridge.depositETH), which credits the SAME
 * address on Base — no third party, no custom routing. The ETH→USDC swap on Base
 * is the easy remaining step (`galvin --recover` flags it once the ETH lands).
 *
 * Safety: dry-run by default — it builds + previews the exact transaction (to,
 * value, calldata, gas) and broadcasts ONLY when execute=true. Real, irreversible
 * money: a 2× gas buffer is reserved; it refuses if the balance can't cover gas.
 */
import { createWalletClient, createPublicClient, http, encodeFunctionData, parseEther } from "viem";
import { mainnet } from "viem/chains";
import type { PrivateKeyAccount } from "viem";

/** Canonical Base L1StandardBridge on Ethereum mainnet. */
export const BASE_L1_BRIDGE = "0x3154Cf16ccdb4C6d922629664174b904d80F2C35";

const DEPOSIT_ETH_ABI = [
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

export interface BridgeTx {
  to: `0x${string}`;
  value: bigint;
  data: `0x${string}`;
}

/** Build the bridge deposit tx (pure — testable without any network/funds). */
export function buildBridgeTx(valueWei: bigint, minGasLimit = 200_000): BridgeTx {
  return {
    to: BASE_L1_BRIDGE as `0x${string}`,
    value: valueWei,
    data: encodeFunctionData({ abi: DEPOSIT_ETH_ABI, functionName: "depositETH", args: [minGasLimit, "0x"] }),
  };
}

export interface BridgeResult {
  dryRun: boolean;
  balanceWei: bigint;
  valueWei: bigint; // amount actually bridged
  gas: bigint;
  gasCostWei: bigint;
  tx: BridgeTx;
  hash?: `0x${string}`;
}

export interface BridgeOptions {
  rpcUrl?: string;
  execute?: boolean; // false (default) = dry-run, build + preview only
  minResidualWei?: bigint; // never bridge if it would leave less than this for gas
}

const DEFAULT_RPC = "https://ethereum-rpc.publicnode.com";

/**
 * Compute + (optionally) broadcast the bridge of all mainnet ETH (minus a gas
 * buffer) from `account` to Base. Dry-run unless opts.execute === true.
 */
export async function executeBridge(account: PrivateKeyAccount, opts: BridgeOptions = {}): Promise<BridgeResult> {
  const rpcUrl = opts.rpcUrl ?? DEFAULT_RPC;
  const pub = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });

  const balanceWei = await pub.getBalance({ address: account.address });
  if (balanceWei === 0n) throw new Error("no ETH on Ethereum mainnet to recover");

  // Estimate gas with a conservative trial value, then reserve a 2× buffer.
  let gas: bigint;
  try {
    const trial = buildBridgeTx(balanceWei / 2n);
    gas = await pub.estimateGas({ account, to: trial.to, value: trial.value, data: trial.data });
  } catch {
    gas = 150_000n; // safe fallback for depositETH
  }
  const fees = await pub.estimateFeesPerGas().catch(() => ({ maxFeePerGas: 5_000_000_000n }));
  const maxFee = fees.maxFeePerGas ?? 5_000_000_000n;
  const gasCostWei = gas * maxFee;
  const buffer = gasCostWei * 2n; // 2× safety so the tx can't run out of gas
  const minResidual = opts.minResidualWei ?? buffer;

  if (balanceWei <= minResidual) {
    throw new Error(`balance ${balanceWei} wei can't cover gas reserve ${minResidual} wei`);
  }
  const valueWei = balanceWei - buffer;
  const tx = buildBridgeTx(valueWei);

  if (!opts.execute) {
    return { dryRun: true, balanceWei, valueWei, gas, gasCostWei, tx };
  }

  const wallet = createWalletClient({ account, chain: mainnet, transport: http(rpcUrl) });
  const hash = await wallet.sendTransaction({ to: tx.to, value: valueWei, data: tx.data, gas });
  return { dryRun: false, balanceWei, valueWei, gas, gasCostWei, tx, hash };
}

export function fmtEth(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(8);
}

// ─── Swap ETH → USDC on Base (the second leg) ─────────────────
import { base } from "viem/chains";

const BASE_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // Uniswap SwapRouter02
const BASE_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"; // Uniswap QuoterV2
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_FEE = 500; // 0.05% ETH/USDC pool (deepest on Base)

const QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

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

/** Pure: apply slippage to a quoted output (bps = basis points, 100 = 1%). */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Build the Uniswap exactInputSingle tx (pure — testable without network). */
export function buildSwapTx(account: `0x${string}`, amountIn: bigint, amountOutMinimum: bigint): BridgeTx {
  return {
    to: BASE_ROUTER as `0x${string}`,
    value: amountIn,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{ tokenIn: WETH_BASE, tokenOut: USDC_BASE, fee: POOL_FEE, recipient: account, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }],
    }),
  };
}

export interface SwapResult {
  dryRun: boolean;
  balanceWei: bigint;
  amountInWei: bigint;
  expectedUsdc: number;
  minUsdc: number;
  slippageBps: number;
  hash?: `0x${string}`;
}

export interface SwapOptions {
  rpcUrl?: string;
  execute?: boolean;
  slippageBps?: number; // default 100 = 1%
  gasReserveWei?: bigint;
}

const BASE_RPC = "https://mainnet.base.org";

/** Live Base ETH balance for an address (any wallet). */
export async function baseEthBalance(address: `0x${string}`, rpcUrl = BASE_RPC): Promise<bigint> {
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return pub.getBalance({ address });
}

export interface WaitOptions {
  rpcUrl?: string;
  timeoutMs?: number;
  intervalMs?: number;
  onTick?: (balanceWei: bigint, elapsedMs: number) => void;
}

/** Poll Base until the bridged ETH lands (balance reaches minWei) or timeout. */
export async function waitForBaseEth(account: PrivateKeyAccount, minWei: bigint, opts: WaitOptions = {}): Promise<bigint> {
  const rpcUrl = opts.rpcUrl ?? BASE_RPC;
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const timeout = opts.timeoutMs ?? 15 * 60 * 1000;
  const interval = opts.intervalMs ?? 20_000;
  const start = Date.now();
  for (;;) {
    const bal = await pub.getBalance({ address: account.address }).catch(() => 0n);
    if (bal >= minWei) return bal;
    const elapsed = Date.now() - start;
    if (elapsed >= timeout) throw new Error("timed out waiting for bridged ETH to land on Base");
    opts.onTick?.(bal, elapsed);
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** Quote + (optionally) execute ETH→USDC on Base. Dry-run unless execute===true. */
export async function executeSwap(account: PrivateKeyAccount, opts: SwapOptions = {}): Promise<SwapResult> {
  const rpcUrl = opts.rpcUrl ?? BASE_RPC;
  const slippageBps = opts.slippageBps ?? 100;
  const pub = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const balanceWei = await pub.getBalance({ address: account.address });
  const gasReserve = opts.gasReserveWei ?? parseEther("0.0001"); // Base gas is cheap
  if (balanceWei <= gasReserve) throw new Error("not enough ETH on Base to swap (after gas reserve)");
  const amountInWei = balanceWei - gasReserve;

  const { result } = await pub.simulateContract({
    address: BASE_QUOTER as `0x${string}`,
    abi: QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: amountInWei, fee: POOL_FEE, sqrtPriceLimitX96: 0n }],
    account,
  });
  const amountOut = result[0] as bigint;
  const amountOutMinimum = minOut(amountOut, slippageBps);
  const expectedUsdc = Number(amountOut) / 1e6;
  const minUsdc = Number(amountOutMinimum) / 1e6;

  if (!opts.execute) {
    return { dryRun: true, balanceWei, amountInWei, expectedUsdc, minUsdc, slippageBps };
  }

  const tx = buildSwapTx(account.address, amountInWei, amountOutMinimum);
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const hash = await wallet.sendTransaction({ to: tx.to, value: tx.value, data: tx.data });
  return { dryRun: false, balanceWei, amountInWei, expectedUsdc, minUsdc, slippageBps, hash };
}
