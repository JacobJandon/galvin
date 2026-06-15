/**
 * Galvin — Startup Wallet Funding Gate
 *
 * awaitFunding() blocks until the wallet has ≥ MINIMUM_USDC USDC on Base.
 * The heartbeat and all AI loops do NOT start until this check passes.
 *
 * Network:  Base Mainnet  (chain 8453, eip155:8453)
 * Asset:    USDC  (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
 * Minimum:  $1.00 USDC  ($5.00 strongly recommended for bootstrap topup)
 *
 * Shows the QR funding screen from src/ui/qr.ts with mode = "startup"
 * so the title reads "⚠ GALVIN NEEDS FUNDING — AI LOOPS PAUSED".
 * Auto-continues when the deposit is detected — no restart needed.
 */

import {
  showFundingScreen,
  updateFundingStatus,
  stopFundingScreen,
} from "./banner.js";

/**
 * Minimum USDC (dollars) required on Base before loops will start.
 * $5 is the bootstrap-topup floor: below it the agent cannot buy any compute
 * and just spins in the critical/dead tier (insufficient_quota every turn), so
 * there is no point starting — show the funding QR instead.
 */
export const MINIMUM_USDC = 5.0;

/** Polling interval in seconds. */
const CHECK_INTERVAL_SEC = 30;

export interface AwaitFundingOptions {
  /** Override the funding threshold in dollars. Defaults to MINIMUM_USDC. */
  minimum?: number;
  /** Always render the funding screen even if already funded. Used by the
   *  on-demand `galvin --fund` / `galvin --qr` command. */
  alwaysShow?: boolean;
}

/**
 * Block until the wallet holds ≥ `minimum` USDC on Base Mainnet.
 *
 * - If already funded (and not `alwaysShow`), returns immediately.
 * - Otherwise shows the full QR funding screen (startup mode) and polls every
 *   CHECK_INTERVAL_SEC seconds until the balance is confirmed on-chain.
 * - Auto-proceeds — no restart needed.
 *
 * Escape hatch: `GALVIN_SKIP_FUNDING_GATE=1` bypasses the gate entirely (e.g.
 * when funding inference via a provider key rather than the wallet).
 *
 * @param address    Hex wallet address (`0x…`)
 * @param getBalance Function that returns the current USDC balance in dollars
 * @param opts       Threshold / always-show overrides
 */
export async function awaitFunding(
  address:    string,
  getBalance: (addr: `0x${string}`) => Promise<number>,
  opts:       AwaitFundingOptions = {},
): Promise<void> {
  const minimum = opts.minimum ?? MINIMUM_USDC;

  // Escape hatch for non-wallet funding (provider key, etc.)
  if (!opts.alwaysShow && process.env.GALVIN_SKIP_FUNDING_GATE === "1") return;

  // Quick initial check — skip the screen entirely if already funded
  let balance = 0;
  try {
    balance = await getBalance(address as `0x${string}`);
  } catch { /* treat as zero — network may not be up yet */ }

  if (!opts.alwaysShow && balance >= minimum) return;

  // ── Show startup funding gate ─────────────────────────────────────────────
  showFundingScreen(address, "", CHECK_INTERVAL_SEC, "startup");

  let funded = false;
  while (!funded) {
    // Show "Checking on-chain…" spinner
    updateFundingStatus(0, CHECK_INTERVAL_SEC);
    try {
      balance = await getBalance(address as `0x${string}`);
      if (balance >= minimum) { funded = true; break; }
    } catch { /* retry */ }

    // Countdown to next check
    for (let s = CHECK_INTERVAL_SEC; s > 0; s--) {
      updateFundingStatus(s, CHECK_INTERVAL_SEC);
      await sleep(1_000);
    }
  }

  stopFundingScreen();

  const G = "\x1b[38;5;46m\x1b[1m", R = "\x1b[0m";
  process.stdout.write(`\n  ${G}✓ Wallet funded ($${balance.toFixed(2)} USDC) — starting Galvin…${R}\n\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

