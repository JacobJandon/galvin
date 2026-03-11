/**
 * Resource Monitor
 *
 * Continuously monitors Galvin's resources and triggers
 * survival mode transitions when needed.
 *
 * Feature 3: Also checks spawn threshold for offspring creation.
 */

import type {
  GalvinConfig,
  GalvinDatabase,
  ConwayClient,
  GalvinIdentity,
  FinancialState,
  SurvivalTier,
} from "../types.js";
import { getSurvivalTier, formatCredits } from "../conway/credits.js";
import { getUsdcBalance } from "../conway/x402.js";
import { checkSpawnThreshold } from "../replication/budget-threshold.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("survival.monitor");

export interface ResourceStatus {
  financial: FinancialState;
  tier: SurvivalTier;
  previousTier: SurvivalTier | null;
  tierChanged: boolean;
  sandboxHealthy: boolean;
}

/**
 * Check all resources and return current status.
 */
export async function checkResources(
  identity: GalvinIdentity,
  conway: ConwayClient,
  db: GalvinDatabase,
): Promise<ResourceStatus> {
  // Check credits
  let creditsCents = 0;
  try {
    creditsCents = await conway.getCreditsBalance();
  } catch {}

  // Check USDC
  let usdcBalance = 0;
  try {
    usdcBalance = await getUsdcBalance(identity.address);
  } catch {}

  // Check sandbox health
  let sandboxHealthy = true;
  try {
    const result = await conway.exec("echo ok", 5000);
    sandboxHealthy = result.exitCode === 0;
  } catch {
    sandboxHealthy = false;
  }

  const financial: FinancialState = {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };

  const tier = getSurvivalTier(creditsCents);
  const prevTierStr = db.getKV("current_tier");
  const previousTier = (prevTierStr as SurvivalTier) || null;
  const tierChanged = previousTier !== null && previousTier !== tier;

  // Store current tier
  db.setKV("current_tier", tier);

  // Store financial state
  db.setKV("financial_state", JSON.stringify(financial));

  return {
    financial,
    tier,
    previousTier,
    tierChanged,
    sandboxHealthy,
  };
}

/**
 * Generate a human-readable resource report.
 */
export function formatResourceReport(status: ResourceStatus): string {
  const lines = [
    `=== RESOURCE STATUS ===`,
    `Credits: ${formatCredits(status.financial.creditsCents)}`,
    `USDC: ${status.financial.usdcBalance.toFixed(6)}`,
    `Tier: ${status.tier}${status.tierChanged ? ` (changed from ${status.previousTier})` : ""}`,
    `Sandbox: ${status.sandboxHealthy ? "healthy" : "UNHEALTHY"}`,
    `Checked: ${status.financial.lastChecked}`,
    `========================`,
  ];
  return lines.join("\n");
}

/**
 * Feature 3: Check if spawn threshold is met and log if so.
 * Returns true if Galvin should consider spawning offspring.
 */
export function checkSpawnEligibility(
  status: ResourceStatus,
  config: GalvinConfig,
  db: GalvinDatabase,
): boolean {
  // Only spawn when in normal or high tier — not when struggling
  if (status.tier === "critical" || status.tier === "dead" || status.tier === "low_compute") {
    return false;
  }
  const eligible = checkSpawnThreshold(status.financial.usdcBalance, config, db);
  if (eligible) {
    logger.info(
      `[OFFSPRING] Spawn eligible: balance=${status.financial.usdcBalance.toFixed(4)} USDC  tier=${status.tier}`,
    );
  }
  return eligible;
}
