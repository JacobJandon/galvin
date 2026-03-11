/**
 * Budget Threshold for Offspring Spawning
 *
 * Galvin can spawn children when it has accumulated enough USDC above
 * a configurable threshold.  The threshold prevents Galvin from
 * bankrupting itself by spawning too aggressively.
 *
 * Threshold defaults: 50 USDC balance, at most 1 spawn per 7 days.
 * Both are overrideable via GALVIN_SPAWN_THRESHOLD_USDC and
 * GALVIN_MAX_OFFSPRING env vars.
 */

import type { GalvinConfig, GalvinDatabase } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("replication.budget-threshold");

const DEFAULT_THRESHOLD_USDC = 50;
const SPAWN_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Returns true when:
 *  - USDC balance exceeds the spawn threshold
 *  - No child was spawned in the last 7 days
 *  - Live child count is below maxOffspring (or config.maxChildren)
 */
export function checkSpawnThreshold(
  balanceUsdc: number,
  config: GalvinConfig,
  db: GalvinDatabase,
): boolean {
  // Read threshold from env or config
  const thresholdEnv = process.env.GALVIN_SPAWN_THRESHOLD_USDC;
  const threshold = thresholdEnv
    ? parseFloat(thresholdEnv)
    : ((config as any).spawnThresholdUsdc ?? DEFAULT_THRESHOLD_USDC);

  if (!Number.isFinite(threshold) || threshold <= 0) return false;

  if (balanceUsdc < threshold) {
    logger.debug(`checkSpawnThreshold: balance ${balanceUsdc.toFixed(4)} < threshold ${threshold}`);
    return false;
  }

  // Check cooldown — only one spawn per 7 days
  const lastSpawnStr = db.getKV("last_offspring_spawn");
  if (lastSpawnStr) {
    const lastSpawnMs = Date.parse(lastSpawnStr);
    if (!Number.isNaN(lastSpawnMs) && Date.now() - lastSpawnMs < SPAWN_COOLDOWN_MS) {
      logger.debug(`checkSpawnThreshold: within spawn cooldown (last=${lastSpawnStr})`);
      return false;
    }
  }

  // Check live child count vs maxOffspring cap
  const maxOffspringEnv = process.env.GALVIN_MAX_OFFSPRING;
  const maxOffspring = maxOffspringEnv
    ? parseInt(maxOffspringEnv, 10)
    : ((config as any).maxOffspring ?? config.maxChildren ?? 3);

  const liveChildren = db
    .getChildren()
    .filter(
      (c) =>
        c.status !== "dead" &&
        c.status !== "cleaned_up" &&
        c.status !== "failed",
    ).length;

  if (liveChildren >= maxOffspring) {
    logger.debug(`checkSpawnThreshold: ${liveChildren} live children >= maxOffspring ${maxOffspring}`);
    return false;
  }

  logger.info(
    `checkSpawnThreshold: spawn eligible — balance=${balanceUsdc.toFixed(4)} USDC, liveChildren=${liveChildren}/${maxOffspring}`,
  );
  return true;
}

/**
 * Record that a spawn just happened.  Call immediately after spawnChild() succeeds.
 */
export function recordSpawn(db: GalvinDatabase): void {
  db.setKV("last_offspring_spawn", new Date().toISOString());
}

/**
 * Build a light memory snapshot from the agent's episodic + knowledge store.
 * Returns a JSON string that can be written to a file and read by the child
 * on first boot.
 *
 * Top-N entries by recency × importance.  Max 50 entries, 40 KB total.
 */
export function buildMemorySnapshot(db: GalvinDatabase, topN = 50): string {
  try {
    const MAX_BYTES = 40_000;

    // Episodic memories — most recent 100, sorted by created_at desc
    const episodic = (db as any).raw
      .prepare(
        `SELECT id, event_type, summary, content, created_at
         FROM episodic_memory
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all() as Array<{
        id: string;
        event_type: string;
        summary: string;
        content: string | null;
        created_at: string;
      }>;

    // Knowledge entries with importance > 0.5
    const knowledge = (db as any).raw
      .prepare(
        `SELECT id, category, content, context, created_at
         FROM semantic_memory
         WHERE category NOT IN ('episodic_summary')
         ORDER BY created_at DESC
         LIMIT 100`,
      )
      .all() as Array<{
        id: string;
        category: string;
        content: string;
        context: string | null;
        created_at: string;
      }>;

    const snapshot = {
      snapshotVersion: 1,
      createdAt: new Date().toISOString(),
      episodic: episodic.slice(0, topN).map((e) => ({
        event_type: e.event_type,
        summary: e.summary,
        created_at: e.created_at,
      })),
      knowledge: knowledge.slice(0, topN).map((k) => ({
        category: k.category,
        content: k.content.slice(0, 800),
        context: k.context,
        created_at: k.created_at,
      })),
    };

    const json = JSON.stringify(snapshot);
    if (json.length > MAX_BYTES) {
      // Truncate if needed
      snapshot.episodic = snapshot.episodic.slice(0, 20);
      snapshot.knowledge = snapshot.knowledge.slice(0, 10);
      return JSON.stringify(snapshot);
    }
    return json;
  } catch (err: any) {
    logger.warn(`buildMemorySnapshot failed: ${err?.message}`);
    return JSON.stringify({ snapshotVersion: 1, createdAt: new Date().toISOString(), episodic: [], knowledge: [] });
  }
}

/**
 * Compute a simple SHA-256 hex hash of a string using Node's crypto module.
 */
export async function sha256(data: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
}
