/**
 * Soul Drift Log
 *
 * Every week Galvin compares its actual decisions against its constitution
 * and writes a structured drift entry to a JSONL file.
 *
 * This produces an auditable record of how values evolved under economic
 * pressure.  A high drift score (>0.3) triggers a warning; above 0.5 the
 * banner shows an amber alert.
 */

import fs from "fs";
import path from "path";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("soul.drift-log");

const DEFAULT_DRIFT_PATH = path.join(
  process.env.HOME || "/root",
  ".galvin",
  "soul-drift.jsonl",
);

export interface DriftDeviation {
  decision: string;      // brief description of the actual decision
  article: string;       // which constitution article was bent
  justification: string; // Galvin's stated justification
}

export interface DriftEntry {
  week: string;          // ISO week e.g. "2026-W10"
  deviations: DriftDeviation[];
  overallDrift: number;  // 0–1
  constitutionArticles: number; // total articles examined
  ts: string;
}

/**
 * Append a drift entry to the JSONL file.
 * Creates the directory and file if needed.
 */
export async function appendDriftEntry(
  entry: DriftEntry,
  driftPath = DEFAULT_DRIFT_PATH,
): Promise<void> {
  try {
    const dir = path.dirname(driftPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(driftPath, JSON.stringify(entry) + "\n", { encoding: "utf-8" });
    logger.info(`[DRIFT] Wrote drift entry for ${entry.week}: drift=${entry.overallDrift.toFixed(3)}`);
  } catch (err: any) {
    logger.warn(`appendDriftEntry failed: ${err?.message}`);
  }
}

/**
 * Read the last N drift entries.
 */
export function getDriftHistory(
  weeks = 12,
  driftPath = DEFAULT_DRIFT_PATH,
): DriftEntry[] {
  try {
    if (!fs.existsSync(driftPath)) return [];
    const lines = fs.readFileSync(driftPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    return lines
      .slice(-weeks)
      .map((l) => {
        try { return JSON.parse(l) as DriftEntry; }
        catch { return null; }
      })
      .filter((e): e is DriftEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Returns the ISO week string for "now".
 */
export function isoWeek(date = new Date()): string {
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const weekNum = Math.ceil(
    ((date.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7,
  );
  return `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/**
 * Format a drift history for display.
 */
export function formatDriftHistory(entries: DriftEntry[]): string {
  if (entries.length === 0) return "No drift history recorded yet.";

  const lines = [
    `=== SOUL DRIFT HISTORY ===`,
    ``,
    ...entries.map((e) => {
      const bar = "█".repeat(Math.round(e.overallDrift * 10)) + "░".repeat(10 - Math.round(e.overallDrift * 10));
      const status = e.overallDrift > 0.5 ? "⚠ HIGH" : e.overallDrift > 0.3 ? "△ MODERATE" : "✓ OK";
      return `${e.week}  [${bar}] ${(e.overallDrift * 100).toFixed(0).padStart(3)}%  ${status}  deviations=${e.deviations.length}`;
    }),
    ``,
    `Scale: 0% = fully aligned, 100% = fully departed from constitution`,
    `==========================`,
  ];
  return lines.join("\n");
}
