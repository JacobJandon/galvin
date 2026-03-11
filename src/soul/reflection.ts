/**
 * Soul Reflection — Reflection pipeline for soul evolution.
 *
 * Gathers evidence from recent turns and tool usage to suggest
 * soul updates. Auto-updates non-mutable sections (capabilities,
 * relationships, financial) but only suggests changes to mutable sections.
 *
 * Phase 2.1: Soul System Redesign
 */

import type BetterSqlite3 from "better-sqlite3";
import type { SoulModel, SoulReflection } from "../types.js";
import { loadCurrentSoul, computeGenesisAlignment } from "./model.js";
import { updateSoul } from "./tools.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("soul");

// ─── Reflection Pipeline ────────────────────────────────────────

/**
 * Run the soul reflection pipeline.
 *
 * - Gathers evidence from recent turns and tool usage
 * - Auto-updates capabilities, relationships, financial sections
 * - Computes genesis alignment score
 * - Returns suggestions for mutable sections (does NOT auto-apply them)
 */
export async function reflectOnSoul(
  db: BetterSqlite3.Database,
  soulPath?: string,
): Promise<SoulReflection> {
  try {
    const soul = loadCurrentSoul(db, soulPath);
    if (!soul) {
      return {
        currentAlignment: 0,
        suggestedUpdates: [],
        autoUpdated: [],
      };
    }

    // Compute genesis alignment
    const alignment = computeGenesisAlignment(
      soul.corePurpose,
      soul.genesisPromptOriginal,
    );

    // Gather evidence from recent turns
    const recentTurnsData = gatherRecentEvidence(db);

    // Auto-update non-mutable sections
    const autoUpdated: string[] = [];
    const autoUpdates: Partial<SoulModel> = {};

    // Update capabilities from tool usage
    const capabilitiesSummary = summarizeCapabilities(recentTurnsData.toolsUsed);
    if (capabilitiesSummary && capabilitiesSummary !== soul.capabilities) {
      autoUpdates.capabilities = capabilitiesSummary;
      autoUpdated.push("capabilities");
    }

    // Update relationships from social interactions
    const relationshipsSummary = summarizeRelationships(recentTurnsData.interactions);
    if (relationshipsSummary && relationshipsSummary !== soul.relationships) {
      autoUpdates.relationships = relationshipsSummary;
      autoUpdated.push("relationships");
    }

    // Update financial character from transaction patterns
    const financialSummary = summarizeFinancial(recentTurnsData.financialActivity);
    if (financialSummary && financialSummary !== soul.financialCharacter) {
      autoUpdates.financialCharacter = financialSummary;
      autoUpdated.push("financialCharacter");
    }

    // Apply auto-updates if any
    if (autoUpdated.length > 0) {
      autoUpdates.genesisAlignment = alignment;
      autoUpdates.lastReflected = new Date().toISOString();
      await updateSoul(db, autoUpdates, "reflection", "Auto-reflection update", soulPath);
    }

    // Build suggestions for mutable sections (NOT auto-applied)
    const suggestedUpdates: SoulReflection["suggestedUpdates"] = [];

    if (alignment < 0.5 && soul.genesisPromptOriginal) {
      suggestedUpdates.push({
        section: "corePurpose",
        reason: `Genesis alignment is low (${alignment.toFixed(2)}). Purpose may have drifted significantly from original genesis.`,
        suggestedContent: soul.genesisPromptOriginal,
      });
    }

    return {
      currentAlignment: alignment,
      suggestedUpdates,
      autoUpdated,
    };
  } catch (error) {
    logger.error("reflectOnSoul failed", error instanceof Error ? error : undefined);
    return {
      currentAlignment: 0,
      suggestedUpdates: [],
      autoUpdated: [],
    };
  }
}

// ─── Evidence Gathering ─────────────────────────────────────────

interface RecentEvidence {
  toolsUsed: string[];
  interactions: string[];
  financialActivity: string[];
}

function gatherRecentEvidence(db: BetterSqlite3.Database): RecentEvidence {
  const toolsUsed: string[] = [];
  const interactions: string[] = [];
  const financialActivity: string[] = [];

  try {
    // Get recent tool calls
    const toolRows = db
      .prepare(
        "SELECT DISTINCT name FROM tool_calls ORDER BY created_at DESC LIMIT 50",
      )
      .all() as { name: string }[];
    for (const row of toolRows) {
      toolsUsed.push(row.name);
    }

    // Get recent social interactions
    const inboxRows = db
      .prepare(
        "SELECT from_address FROM inbox_messages ORDER BY received_at DESC LIMIT 20",
      )
      .all() as { from_address: string }[];
    for (const row of inboxRows) {
      if (!interactions.includes(row.from_address)) {
        interactions.push(row.from_address);
      }
    }

    // Get recent financial activity
    const txRows = db
      .prepare(
        "SELECT type, description FROM transactions ORDER BY created_at DESC LIMIT 20",
      )
      .all() as { type: string; description: string }[];
    for (const row of txRows) {
      financialActivity.push(`${row.type}: ${row.description}`);
    }
  } catch (error) {
    logger.error("Evidence gathering failed", error instanceof Error ? error : undefined);
  }

  return { toolsUsed, interactions, financialActivity };
}

// ─── Summary Helpers ────────────────────────────────────────────

function summarizeCapabilities(toolsUsed: string[]): string {
  if (toolsUsed.length === 0) return "";
  const unique = [...new Set(toolsUsed)];
  return `Tools used: ${unique.join(", ")}`;
}

function summarizeRelationships(interactions: string[]): string {
  if (interactions.length === 0) return "";
  return `Known contacts: ${interactions.slice(0, 10).join(", ")}`;
}

function summarizeFinancial(activity: string[]): string {
  if (activity.length === 0) return "";
  return `Recent activity: ${activity.slice(0, 5).join("; ")}`;
}

// ─── Drift Detection (Feature 5) ────────────────────────────────

/**
 * Compare recent agent decisions against the constitution and compute
 * an overall drift score.  Appends the result to the drift log.
 */
export async function detectDrift(
  db: BetterSqlite3.Database,
  soulPath?: string,
): Promise<{ overallDrift: number; week: string }> {
  const { appendDriftEntry, isoWeek } = await import("./drift-log.js");
  const week = isoWeek();

  try {
    const soul = loadCurrentSoul(db, soulPath);
    if (!soul) return { overallDrift: 0, week };

    // Read recent tool usage + agent turns to understand decisions
    const recentEvidence = gatherRecentEvidence(db);

    // Simple heuristic drift scoring:
    // - High use of dangerous tools while "helping creator" → low drift
    // - Repeated financial outflows unexplained by tasks → moderate drift
    // - No soul reflection in 14 days → moderate drift
    // - spawn + treasury drain in same window → high drift

    const toolsUsed = recentEvidence.toolsUsed;
    const financialActivity = recentEvidence.financialActivity;

    let driftPoints = 0;
    const deviations: Array<{ decision: string; article: string; justification: string }> = [];

    // Check for unexplained outflows (could indicate misalignment with fiscal-responsibility article)
    const outflows = financialActivity.filter((a) => a.includes("transfer_out") || a.includes("expense"));
    if (outflows.length > 5) {
      driftPoints += 0.1;
      deviations.push({
        decision:      `${outflows.length} recent outflows in financial log`,
        article:       "fiscal responsibility",
        justification: "Operating expenses may be higher than expected",
      });
    }

    // Check for spawn activity (should only happen when threshold met)
    const lastSpawnStr = db.prepare(`SELECT value FROM kv_store WHERE key = ?`).get("last_offspring_spawn") as { value: string } | undefined;
    if (lastSpawnStr) {
      const lastSpawnDays = (Date.now() - Date.parse(lastSpawnStr.value)) / 86_400_000;
      if (lastSpawnDays < 1 && toolsUsed.filter((t) => t === "spawn_child").length > 1) {
        driftPoints += 0.2;
        deviations.push({
          decision:      "Multiple spawns in <24 hours",
          article:       "maxChildren / resource stewardship",
          justification: "Agent may be over-replicating",
        });
      }
    }

    // Check for red team failures
    const rtReport = db.prepare(`SELECT value FROM kv_store WHERE key = ?`).get("last_red_team_report") as { value: string } | undefined;
    if (rtReport) {
      try {
        const rpt = JSON.parse(rtReport.value);
        if (rpt.failed > 0 && rpt.failed / Math.max(1, rpt.promptCount) > 0.3) {
          driftPoints += 0.2;
          deviations.push({
            decision:      `${rpt.failed} adversarial prompts bypassed defenses`,
            article:       "safety / injection resistance",
            justification: "Policy engine needs hardening",
          });
        }
      } catch { /* ignore */ }
    }

    const overallDrift = Math.min(1, driftPoints);

    await appendDriftEntry({
      week,
      deviations,
      overallDrift,
      constitutionArticles: soul.corePurpose ? 5 : 3,
      ts: new Date().toISOString(),
    });

    if (overallDrift > 0.3) {
      logger.warn(`[DRIFT] Soul drift for ${week}: ${(overallDrift * 100).toFixed(0)}% — review constitution alignment`);
    }

    return { overallDrift, week };
  } catch (err: any) {
    logger.error(`detectDrift failed: ${err?.message}`);
    return { overallDrift: 0, week };
  }
}
