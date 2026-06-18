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
