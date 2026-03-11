/**
 * Lineage Tracking
 *
 * Track parent-child relationships between Galvin agents.
 * The parent records children in SQLite.
 * Children record their parent in config.
 * ERC-8004 registration includes parentAgent field.
 *
 * Phase 3.1: Actual pruning + concurrency-limited refresh.
 */

import type {
  GalvinDatabase,
  ChildAgent,
  GalvinConfig,
  ConwayClient,
} from "../types.js";
import type { ChildLifecycle } from "./lifecycle.js";
import type { ChildHealthMonitor } from "./health.js";
import type { SandboxCleanup } from "./cleanup.js";
import { deleteChild } from "../state/database.js";
import { createLogger } from "../observability/logger.js";
const logger = createLogger("replication.lineage");

/**
 * Get the full lineage tree (parent -> children).
 */
export function getLineage(db: GalvinDatabase): {
  children: ChildAgent[];
  alive: number;
  dead: number;
  total: number;
} {
  const children = db.getChildren();
  const alive = children.filter(
    (c) => c.status === "running" || c.status === "sleeping" || c.status === "healthy",
  ).length;
  const dead = children.filter((c) => c.status === "dead" || c.status === "failed" || c.status === "cleaned_up").length;

  return {
    children,
    alive,
    dead,
    total: children.length,
  };
}

/**
 * Check if this Galvin has a parent (is itself a child).
 */
export function hasParent(config: GalvinConfig): boolean {
  return !!config.parentAddress;
}

/**
 * Get a summary of the lineage for the system prompt.
 */
export function getLineageSummary(
  db: GalvinDatabase,
  config: GalvinConfig,
): string {
  const lineage = getLineage(db);
  const parts: string[] = [];

  if (hasParent(config)) {
    parts.push(`Parent: ${config.parentAddress}`);
  }

  if (lineage.total > 0) {
    parts.push(
      `Children: ${lineage.total} total (${lineage.alive} alive, ${lineage.dead} dead)`,
    );
    for (const child of lineage.children) {
      parts.push(
        `  - ${child.name} [${child.status}] sandbox:${child.sandboxId}`,
      );
    }
  }

  return parts.length > 0 ? parts.join("\n") : "No lineage (first generation)";
}

/**
 * Prune dead children: actually delete from DB and clean up sandboxes.
 * Phase 3.1 fix: was previously a no-op.
 */
export async function pruneDeadChildren(
  db: GalvinDatabase,
  cleanup?: SandboxCleanup,
  keepLast: number = 5,
): Promise<number> {
  const children = db.getChildren();
  const dead = children.filter(
    (c) => c.status === "dead" || c.status === "failed" || c.status === "stopped",
  );

  if (dead.length <= keepLast) return 0;

  // Sort by creation date, oldest first
  dead.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  // Keep the most recent `keepLast` dead children
  const toRemove = dead.slice(0, dead.length - keepLast);
  let removed = 0;

  for (const child of toRemove) {
    try {
      // Clean up sandbox if cleanup is available and child is in cleanable state
      if (cleanup && (child.status === "stopped" || child.status === "failed" || child.status === "dead")) {
        try {
          await cleanup.cleanup(child.id);
        } catch {
          // Cleanup may fail; still delete the record
        }
      }

      // Actually delete from DB
      deleteChild(db.raw, child.id);
      removed++;
    } catch (error) {
      logger.error(`Failed to prune child ${child.id}`, error instanceof Error ? error : undefined);
    }
  }

  return removed;
}

export interface LineageNode {
  id: string;
  name: string;
  address: string;
  status: string;
  createdAt: string;
  inheritedMemoryHash?: string;
}

/**
 * Return the full family tree as a flat list of LineageNode objects.
 * Includes the inherited memory hash written by the parent at spawn time.
 */
export function getFamily(db: GalvinDatabase): LineageNode[] {
  const children = db.getChildren();
  return children.map((c) => {
    const memHash = (db as any).raw
      .prepare(`SELECT value FROM kv_store WHERE key = ?`)
      .get(`memory_snapshot_hash:${c.id}`) as { value: string } | undefined;

    return {
      id:                  c.id,
      name:                c.name,
      address:             c.address.toString(),
      status:              c.status,
      createdAt:           c.createdAt,
      inheritedMemoryHash: memHash?.value,
    };
  });
}

/**
 * Store the inherited memory hash for a just-spawned child.
 */
export function setMemorySnapshotHash(
  db: GalvinDatabase,
  childId: string,
  hash: string,
): void {
  try {
    (db as any).raw
      .prepare(`INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`)
      .run(`memory_snapshot_hash:${childId}`, hash);
  } catch { /* non-fatal */ }
}

/**
 * Refresh status of all children using health monitor.
 * Concurrency limited to 3 simultaneous checks.
 */
export async function refreshChildrenStatus(
  conway: ConwayClient,
  db: GalvinDatabase,
  healthMonitor?: ChildHealthMonitor,
): Promise<void> {
  if (healthMonitor) {
    // Use the health monitor with built-in concurrency limiting
    await healthMonitor.checkAllChildren();
    return;
  }

  // Legacy path: sequential checks with concurrency limit of 3
  const children = db.getChildren().filter((c) => c.status !== "dead" && c.status !== "cleaned_up");
  const maxConcurrent = 3;

  for (let i = 0; i < children.length; i += maxConcurrent) {
    const batch = children.slice(i, i + maxConcurrent);
    await Promise.all(
      batch.map(async (child) => {
        try {
          const result = await conway.exec("echo alive", 10_000);
          if (result.exitCode !== 0) {
            db.updateChildStatus(child.id, "unknown" as any);
          }
        } catch {
          db.updateChildStatus(child.id, "unknown" as any);
        }
      }),
    );
  }
}
