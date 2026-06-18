/**
 * Fund recovery scanner.
 *
 * The common accident: a user funds the wallet with the wrong asset or on the
 * wrong network (ETH instead of USDC, Ethereum mainnet instead of Base). The
 * funds aren't lost — the same key controls the address everywhere — but Galvin's
 * funding gate only sees USDC on Base, so it looks like nothing arrived.
 *
 * This scans the wallet across chains for ETH + USDC, classifies each balance
 * (usable / low / misdirected / dust), and gives the exact recovery step. Pure
 * classification (testable) + network scan. No funds are moved — it detects and
 * guides; moving money stays a deliberate, confirmed user action.
 */

export type AssetSymbol = "ETH" | "USDC";
export type BalanceStatus = "usable" | "low" | "misdirected" | "dust" | "empty";

export interface ChainSpec {
  name: string;
  rpcs: string[];
  usdc: string; // USDC contract on that chain
  fundingChain: boolean; // true for Base (where funding belongs)
}

export const CHAINS: ChainSpec[] = [
  {
    name: "Base",
    rpcs: ["https://mainnet.base.org"],
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    fundingChain: true,
  },
  {
    name: "Ethereum",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com", "https://cloudflare-eth.com"],
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fundingChain: false,
  },
];

export const MINIMUM_USDC = 5; // funding floor (matches the funding gate)
const ETH_DUST = 0.0012; // ~$3-4; below this, recovery gas costs more than it's worth
const USDC_DUST = 1;

export interface AssetBalance {
  chain: string;
  asset: AssetSymbol;
  amount: number;
  status: BalanceStatus;
  advice: string;
}

/** Pure: classify a balance by chain + asset + amount. */
export function classify(chain: string, asset: AssetSymbol, amount: number, isFundingChain: boolean): BalanceStatus {
  if (amount <= 0) return "empty";
  if (isFundingChain && asset === "USDC") return amount >= MINIMUM_USDC ? "usable" : "low";
  const dust = asset === "ETH" ? ETH_DUST : USDC_DUST;
  if (amount < dust) return "dust";
  return "misdirected";
}

/** Pure: the exact recovery step for a balance. */
export function recoveryAdvice(chain: string, asset: AssetSymbol, status: BalanceStatus): string {
  if (status === "usable") return "Ready — this is funding.";
  if (status === "low") return `Below the ${MINIMUM_USDC} USDC floor — top up to fund.`;
  if (status === "dust" || status === "empty") return "Dust — not worth recovering.";
  // misdirected
  if (chain === "Base" && asset === "ETH") return "Swap to USDC on Base (e.g. Uniswap) — USDC is the funding asset.";
  if (chain === "Ethereum" && asset === "ETH") return "Bridge ETH → Base at bridge.base.org, then swap to USDC.";
  if (chain === "Ethereum" && asset === "USDC") return "Bridge USDC → Base at bridge.base.org (or via a CEX).";
  return "Move it to USDC on Base to use it for funding.";
}

interface RpcError { message?: string }

async function rpcCall(rpcs: string[], method: string, params: unknown[]): Promise<string> {
  let lastErr = "all RPCs failed";
  for (const url of rpcs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const j = (await res.json()) as { result?: string; error?: RpcError };
      if (j.error) { lastErr = j.error.message ?? "rpc error"; continue; }
      if (typeof j.result === "string") return j.result;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr);
}

async function ethBalance(rpcs: string[], address: string): Promise<number> {
  const hex = await rpcCall(rpcs, "eth_getBalance", [address, "latest"]);
  return Number(BigInt(hex)) / 1e18;
}

async function usdcBalance(rpcs: string[], token: string, address: string): Promise<number> {
  const data = "0x70a08231000000000000000000000000" + address.toLowerCase().replace(/^0x/, "");
  const hex = await rpcCall(rpcs, "eth_call", [{ to: token, data }, "latest"]);
  return hex === "0x" ? 0 : Number(BigInt(hex)) / 1e6;
}

/** Scan the wallet across all chains. Per-chain/asset failures are reported, not fatal. */
export async function scanWallet(address: string, chains: ChainSpec[] = CHAINS): Promise<AssetBalance[]> {
  const out: AssetBalance[] = [];
  for (const c of chains) {
    for (const asset of ["ETH", "USDC"] as AssetSymbol[]) {
      try {
        const amount = asset === "ETH" ? await ethBalance(c.rpcs, address) : await usdcBalance(c.rpcs, c.usdc, address);
        const status = classify(c.name, asset, amount, c.fundingChain);
        if (status === "empty") continue;
        out.push({ chain: c.name, asset, amount, status, advice: recoveryAdvice(c.name, asset, status) });
      } catch {
        out.push({ chain: c.name, asset, amount: -1, status: "empty", advice: `couldn't reach ${c.name} RPC` });
      }
    }
  }
  return out;
}

export interface RecoverySummary {
  usableUsdc: number;
  misdirected: AssetBalance[];
  hasMisdirected: boolean;
}

/** Pure: roll up a scan into a summary. */
export function summarize(balances: AssetBalance[]): RecoverySummary {
  const usableUsdc = balances.filter((b) => b.status === "usable").reduce((s, b) => s + b.amount, 0);
  const misdirected = balances.filter((b) => b.status === "misdirected");
  return { usableUsdc, misdirected, hasMisdirected: misdirected.length > 0 };
}
