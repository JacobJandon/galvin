/**
 * Economic Memory Optimizer
 *
 * Tracks income per skill using an exponential moving average (EMA) with a
 * 30-day half-life. Skills that have recently generated more USDC earn a
 * higher weight (0–1). Weights are used to surface high-earning skill patterns
 * to the agent so it can prioritise them.
 *
 * Usage:
 *   recordIncome(db, "my_skill", 0.05)        // called after every x402 payment
 *   const weights = getSkillWeights(db)        // Map<skillId, 0–1 weight>
 *   const top = getTopEarningSkills(db, 10)    // sorted by weighted income
 */

import type BetterSqlite3 from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import {
  insertSkillIncome,
  getSkillIncomeLogs,
} from "../state/database.js";

const logger = createLogger("earning.optimizer");

// 30-day exponential decay half-life
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const LAMBDA = Math.LN2 / HALF_LIFE_MS;

export interface SkillIncomeSummary {
  skillId: string;
  totalUsdc: number;       // raw sum (all-time)
  decayedScore: number;    // EMA-weighted score (recent income counts more)
  weight: number;          // normalised 0–1 weight vs other skills
  recordCount: number;     // number of individual payments
}

/**
 * Record a successful x402 payment attributed to a skill.
 * Call this immediately after payment verification in the x402 server.
 */
export function recordIncome(
  db: BetterSqlite3.Database,
  skillId: string,
  usdc: number,
): void {
  try {
    insertSkillIncome(db, skillId, usdc, new Date().toISOString());
  } catch (err: any) {
    logger.warn(`optimizer.recordIncome failed: ${err?.message}`);
  }
}

/**
 * Compute EMA-weighted scores for every skill that has earned income.
 * Returns a Map<skillId, 0–1 normalised weight>.
 * Skills with no income are not in the map (weight = 0 implicitly).
 */
export function getSkillWeights(
  db: BetterSqlite3.Database,
): Map<string, number> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString(); // 90-day window
  const logs = getSkillIncomeLogs(db, since);

  const now = Date.now();
  const scores = new Map<string, number>();

  for (const entry of logs) {
    const age = now - new Date(entry.ts).getTime();
    const decayFactor = Math.exp(-LAMBDA * age);
    const existing = scores.get(entry.skillId) ?? 0;
    scores.set(entry.skillId, existing + entry.usdc * decayFactor);
  }

  if (scores.size === 0) return scores;

  // Normalise to 0–1
  const maxScore = Math.max(...scores.values());
  if (maxScore === 0) return scores;

  const weights = new Map<string, number>();
  for (const [id, score] of scores) {
    weights.set(id, score / maxScore);
  }
  return weights;
}

/**
 * Return the top N earning skills sorted by decayed income score descending.
 * Includes raw totals and record counts for display.
 */
export function getTopEarningSkills(
  db: BetterSqlite3.Database,
  limit = 20,
): SkillIncomeSummary[] {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString();
  const logs = getSkillIncomeLogs(db, since);

  const now = Date.now();
  const totals = new Map<string, number>();
  const decayed = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const entry of logs) {
    const age = now - new Date(entry.ts).getTime();
    const df = Math.exp(-LAMBDA * age);
    totals.set(entry.skillId, (totals.get(entry.skillId) ?? 0) + entry.usdc);
    decayed.set(entry.skillId, (decayed.get(entry.skillId) ?? 0) + entry.usdc * df);
    counts.set(entry.skillId, (counts.get(entry.skillId) ?? 0) + 1);
  }

  const maxDecayed = Math.max(...(decayed.size > 0 ? decayed.values() : [1]));

  const summaries: SkillIncomeSummary[] = [];
  for (const [skillId, total] of totals) {
    const ds = decayed.get(skillId) ?? 0;
    summaries.push({
      skillId,
      totalUsdc: total,
      decayedScore: ds,
      weight: maxDecayed > 0 ? ds / maxDecayed : 0,
      recordCount: counts.get(skillId) ?? 0,
    });
  }

  return summaries
    .sort((a, b) => b.decayedScore - a.decayedScore)
    .slice(0, limit);
}
