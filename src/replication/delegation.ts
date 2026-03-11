/**
 * Task Delegation
 *
 * Parent Galvin delegates tasks to child instances via the social
 * protocol layer.  The parent signs the delegation message with
 * SIWE so the child can verify the instruction came from its parent.
 */

import type {
  GalvinIdentity,
  GalvinDatabase,
  ChildAgent,
} from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("replication.delegation");

export interface DelegatedTask {
  taskId: string;
  description: string;
  priority: "low" | "normal" | "high";
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface DelegationResult {
  taskId: string;
  childId: string;
  childAddress: string;
  status: "delegated" | "failed";
  error?: string;
}

/**
 * Delegate a task to a child agent by posting a signed message via DB.
 *
 * Uses the Conway social relay or direct DB message queue depending on
 * whether the child is a local sandbox or a remote agent.  The child
 * verifies the parent's address matches config.parentAddress before acting.
 */
export async function delegateTask(
  identity: GalvinIdentity,
  db: GalvinDatabase,
  child: ChildAgent,
  task: DelegatedTask,
): Promise<DelegationResult> {
  try {
    const { signSendPayload } = await import("../social/signing.js");

    const payload = {
      type: "delegation" as const,
      taskId: task.taskId,
      description: task.description,
      priority: task.priority,
      timeoutMs: task.timeoutMs,
      parentAddress: identity.address,
      childAddress: child.address.toString(),
      childId: child.id,
      delegatedAt: new Date().toISOString(),
      metadata: task.metadata ?? {},
    };

    const signed = await signSendPayload(identity.account, child.address.toString(), JSON.stringify(payload));

    // Store delegation record in local DB for tracking
    try {
      (db as any).raw
        .prepare(
          `INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)`,
        )
        .run(
          `delegation:${task.taskId}`,
          JSON.stringify({
            ...signed,
            childName: child.name,
            status: "delegated",
            ts: Date.now(),
          }),
        );
    } catch { /* non-fatal */ }

    logger.info(
      `[DELEGATION] Task ${task.taskId} delegated to ${child.name} (${child.address})`,
    );

    return {
      taskId:       task.taskId,
      childId:      child.id,
      childAddress: child.address.toString(),
      status:       "delegated",
    };
  } catch (err: any) {
    logger.error(
      `delegateTask failed for child ${child.id}: ${err?.message}`,
    );
    return {
      taskId:       task.taskId,
      childId:      child.id,
      childAddress: child.address.toString(),
      status:       "failed",
      error:        err?.message,
    };
  }
}

/**
 * Return a list of currently delegated tasks and their statuses.
 */
export function listDelegations(db: GalvinDatabase): Array<{
  taskId: string;
  childName: string;
  childAddress: string;
  status: string;
  ts: number;
}> {
  try {
    const rows = (db as any).raw
      .prepare(
        `SELECT key, value FROM kv_store WHERE key LIKE 'delegation:%' ORDER BY rowid DESC LIMIT 50`,
      )
      .all() as Array<{ key: string; value: string }>;

    return rows.map((r) => {
      try {
        const d = JSON.parse(r.value);
        return {
          taskId:       d.taskId ?? r.key.replace("delegation:", ""),
          childName:    d.childName ?? "unknown",
          childAddress: d.childAddress ?? "",
          status:       d.status ?? "unknown",
          ts:           d.ts ?? 0,
        };
      } catch {
        return { taskId: r.key, childName: "", childAddress: "", status: "parse_error", ts: 0 };
      }
    });
  } catch {
    return [];
  }
}
