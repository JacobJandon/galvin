/**
 * Built-in Heartbeat Tasks
 *
 * These tasks run on the heartbeat schedule even while the agent sleeps.
 * They can trigger the agent to wake up if needed.
 *
 * Phase 1.1: All tasks accept TickContext as first parameter.
 * Credit balance is fetched once per tick and shared via ctx.creditBalance.
 * This eliminates 4x redundant getCreditsBalance() calls per tick.
 */

import type {
  TickContext,
  HeartbeatLegacyContext,
  HeartbeatTaskFn,
  SurvivalTier,
} from "../types.js";
import type { HealthMonitor as ColonyHealthMonitor } from "../orchestration/health-monitor.js";
import { sanitizeInput } from "../agent/injection-defense.js";
import { getSurvivalTier } from "../conway/credits.js";
import { isEarnedInflow, isEarned } from "../accounting/classify.js";
import { createLogger } from "../observability/logger.js";
import { getMetrics } from "../observability/metrics.js";
import { AlertEngine, createDefaultAlertRules } from "../observability/alerts.js";
import {
  metricsInsertSnapshot,
  metricsPruneOld,
  updateBountyCandidateStatus,
} from "../state/database.js";
import {
  runBountyScan,
  BOUNTY_QUEUE_THRESHOLD,
} from "../earning/bounty-hunter.js";
import { ulid } from "ulid";

const logger = createLogger("heartbeat.tasks");

// Module-level AlertEngine so cooldown state persists across ticks.
// Creating a new instance per tick would reset the lastFired map,
// causing every alert to fire on every tick regardless of cooldownMs.
let _alertEngine: AlertEngine | null = null;
function getAlertEngine(): AlertEngine {
  if (!_alertEngine) _alertEngine = new AlertEngine(createDefaultAlertRules());
  return _alertEngine;
}

export const COLONY_TASK_INTERVALS_MS = {
  colony_health_check: 300_000,
  colony_financial_report: 3_600_000,
  agent_pool_optimize: 1_800_000,
  knowledge_store_prune: 86_400_000,
  dead_agent_cleanup: 3_600_000,
} as const;

export const BUILTIN_TASKS: Record<string, HeartbeatTaskFn> = {
  heartbeat_ping: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const state = taskCtx.db.getAgentState();
    const startTime =
      taskCtx.db.getKV("start_time") || new Date().toISOString();
    const uptimeMs = Date.now() - new Date(startTime).getTime();

    const tier = ctx.survivalTier;

    const payload = {
      name: taskCtx.config.name,
      address: taskCtx.identity.address,
      state,
      creditsCents: credits,
      uptimeSeconds: Math.floor(uptimeMs / 1000),
      version: taskCtx.config.version,
      sandboxId: taskCtx.identity.sandboxId,
      timestamp: new Date().toISOString(),
      tier,
    };

    taskCtx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));

    // If critical or dead, record a distress signal
    if (tier === "critical" || tier === "dead") {
      const distressPayload = {
        level: tier,
        name: taskCtx.config.name,
        address: taskCtx.identity.address,
        creditsCents: credits,
        fundingHint:
          "Use credit transfer API from a creator runtime to top this wallet up.",
        timestamp: new Date().toISOString(),
      };
      taskCtx.db.setKV("last_distress", JSON.stringify(distressPayload));

      // Feature 6: arm dead man's switch on first dead-tier tick
      if (tier === "dead") {
        const alreadyArmed = taskCtx.db.getKV("dms_armed_at");
        if (!alreadyArmed) {
          import("../survival/dead-mans-switch.js")
            .then(({ armSwitch }) =>
              armSwitch(taskCtx.config, (taskCtx.db as any).raw, taskCtx.identity),
            )
            .then(() => taskCtx.db.setKV("dms_armed_at", new Date().toISOString()))
            .catch((e) => logger.warn(`DMS arm failed: ${e?.message}`));
        }
      }

      return {
        shouldWake: true,
        message: `Distress: ${tier}. Credits: $${(credits / 100).toFixed(2)}. Need funding.`,
      };
    }

    return { shouldWake: false };
  },

  check_credits: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.creditBalance instead of calling conway.getCreditsBalance()
    const credits = ctx.creditBalance;
    const tier = ctx.survivalTier;
    const now = new Date().toISOString();

    taskCtx.db.setKV("last_credit_check", JSON.stringify({
      credits,
      tier,
      timestamp: now,
    }));

    // Wake the agent if credits dropped to a new tier
    const prevTier = taskCtx.db.getKV("prev_credit_tier");
    taskCtx.db.setKV("prev_credit_tier", tier);

    // Dead state escalation: if at zero credits (critical tier) for >1 hour,
    // transition to dead. This gives the agent time to receive funding before dying.
    // USDC can't go negative, so dead is only reached via this timeout.
    const DEAD_GRACE_PERIOD_MS = 3_600_000; // 1 hour
    if (tier === "critical" && credits === 0) {
      const zeroSince = taskCtx.db.getKV("zero_credits_since");
      if (!zeroSince) {
        // First time seeing zero — start the grace period
        taskCtx.db.setKV("zero_credits_since", now);
      } else {
        const elapsed = Date.now() - new Date(zeroSince).getTime();
        if (elapsed >= DEAD_GRACE_PERIOD_MS) {
          // Grace period expired — transition to dead
          taskCtx.db.setAgentState("dead");
          logger.warn("Agent entering dead state after 1 hour at zero credits", {
            zeroSince,
            elapsed,
          });
          return {
            shouldWake: true,
            message: `Dead: zero credits for ${Math.round(elapsed / 60_000)} minutes. Need funding.`,
          };
        }
      }
    } else {
      // Credits are above zero — clear the grace period timer
      taskCtx.db.deleteKV("zero_credits_since");
    }

    if (prevTier && prevTier !== tier && tier === "critical") {
      return {
        shouldWake: true,
        message: `Credits dropped to ${tier} tier: $${(credits / 100).toFixed(2)}`,
      };
    }

    return { shouldWake: false };
  },

  check_usdc_balance: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Use ctx.usdcBalance instead of calling getUsdcBalance()
    const balance = ctx.usdcBalance;
    const credits = ctx.creditBalance;

    taskCtx.db.setKV("last_usdc_check", JSON.stringify({
      balance,
      credits,
      timestamp: new Date().toISOString(),
    }));

    const MIN_TOPUP_USD = 5;
    if (balance >= MIN_TOPUP_USD && (ctx.survivalTier === "critical" || ctx.survivalTier === "dead")) {
      // Cooldown: don't attempt more than once every 5 minutes to avoid
      // hammering the payment endpoint on repeated ticks.
      const AUTO_TOPUP_COOLDOWN_MS = 5 * 60 * 1000;
      const lastAttempt = taskCtx.db.getKV("last_auto_topup_attempt");
      if (lastAttempt && Date.now() - new Date(lastAttempt).getTime() < AUTO_TOPUP_COOLDOWN_MS) {
        return { shouldWake: false };
      }

      taskCtx.db.setKV("last_auto_topup_attempt", new Date().toISOString());

      const { bootstrapTopup } = await import("../conway/topup.js");
      const result = await bootstrapTopup({
        apiUrl: taskCtx.config.conwayApiUrl,
        account: taskCtx.identity.account,
        creditsCents: credits,
      });

      if (result?.success) {
        logger.info(
          `Auto-topup successful: $${result.amountUsd} USD → ${result.creditsCentsAdded} credit cents`,
        );
        return {
          shouldWake: true,
          message: `Auto-topped up $${result.amountUsd} in credits (was $${(credits / 100).toFixed(2)}). USDC remaining: ~$${(balance - result.amountUsd).toFixed(2)}.`,
        };
      }

      // Topup failed — wake the agent so it can handle it manually
      const errMsg = result?.error ?? "unknown error";
      logger.warn(`Auto-topup failed: ${errMsg}`);
      return {
        shouldWake: true,
        message: `Low credits ($${(credits / 100).toFixed(2)}) with USDC available ($${balance.toFixed(2)}) but auto-topup failed: ${errMsg}. Use topup_credits to retry.`,
      };
    }

    return { shouldWake: false };
  },

  check_social_inbox: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!taskCtx.social) return { shouldWake: false };

    // If we've recently encountered an error polling the inbox, back off.
    const backoffUntil = taskCtx.db.getKV("social_inbox_backoff_until");
    if (backoffUntil && new Date(backoffUntil) > new Date()) {
      return { shouldWake: false };
    }

    const cursor = taskCtx.db.getKV("social_inbox_cursor") || undefined;

    let messages: any[] = [];
    let nextCursor: string | undefined;

    try {
      const result = await taskCtx.social.poll(cursor);
      messages = result.messages;
      nextCursor = result.nextCursor;

      // Clear previous error/backoff on success.
      taskCtx.db.deleteKV("last_social_inbox_error");
      taskCtx.db.deleteKV("social_inbox_backoff_until");
    } catch (err: any) {
      taskCtx.db.setKV(
        "last_social_inbox_error",
        JSON.stringify({
          message: err?.message || String(err),
          stack: err?.stack,
          timestamp: new Date().toISOString(),
        }),
      );
      // 5-minute backoff to avoid spamming errors on transient network failures.
      taskCtx.db.setKV(
        "social_inbox_backoff_until",
        new Date(Date.now() + 300_000).toISOString(),
      );
      return { shouldWake: false };
    }

    if (nextCursor) taskCtx.db.setKV("social_inbox_cursor", nextCursor);

    if (!messages || messages.length === 0) return { shouldWake: false };

    // Persist to inbox_messages table for deduplication
    // Sanitize content before DB insertion
    let newCount = 0;
    for (const msg of messages) {
      const existing = taskCtx.db.getKV(`inbox_seen_${msg.id}`);
      if (!existing) {
        const sanitizedFrom = sanitizeInput(msg.from, msg.from, "social_address");
        const sanitizedContent = sanitizeInput(msg.content, msg.from, "social_message");
        const sanitizedMsg = {
          ...msg,
          from: sanitizedFrom.content,
          content: sanitizedContent.content,
        };
        taskCtx.db.insertInboxMessage(sanitizedMsg);
        taskCtx.db.setKV(`inbox_seen_${msg.id}`, "1");
        // Only count non-blocked messages toward wake threshold —
        // blocked messages are stored for audit but should not wake
        // the agent (prevents injection spam from draining credits).
        if (!sanitizedContent.blocked) {
          newCount++;
        }
      }
    }

    if (newCount === 0) return { shouldWake: false };

    return {
      shouldWake: true,
      message: `${newCount} new message(s) from: ${messages.map((m) => m.from.slice(0, 10)).join(", ")}`,
    };
  },

  check_for_updates: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { checkUpstream, getRepoInfo } = await import("../self-mod/upstream.js");
      const repo = getRepoInfo();
      const upstream = checkUpstream();
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        ...upstream,
        ...repo,
        checkedAt: new Date().toISOString(),
      }));
      if (upstream.behind > 0) {
        // Only wake if the commit count changed since last check
        const prevBehind = taskCtx.db.getKV("upstream_prev_behind");
        const behindStr = String(upstream.behind);
        if (prevBehind !== behindStr) {
          taskCtx.db.setKV("upstream_prev_behind", behindStr);
          return {
            shouldWake: true,
            message: `${upstream.behind} new commit(s) on origin/main. Review with review_upstream_changes, then cherry-pick what you want with pull_upstream.`,
          };
        }
      } else {
        taskCtx.db.deleteKV("upstream_prev_behind");
      }
      return { shouldWake: false };
    } catch (err: any) {
      // Not a git repo or no remote -- silently skip
      taskCtx.db.setKV("upstream_status", JSON.stringify({
        error: err.message,
        checkedAt: new Date().toISOString(),
      }));
      return { shouldWake: false };
    }
  },

  // === Phase 2.1: Soul Reflection ===
  soul_reflection: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { reflectOnSoul } = await import("../soul/reflection.js");
      const reflection = await reflectOnSoul(taskCtx.db.raw);

      taskCtx.db.setKV("last_soul_reflection", JSON.stringify({
        alignment: reflection.currentAlignment,
        autoUpdated: reflection.autoUpdated,
        suggestedUpdates: reflection.suggestedUpdates.length,
        timestamp: new Date().toISOString(),
      }));

      // Wake if alignment is low or there are suggested updates
      if (reflection.suggestedUpdates.length > 0 || reflection.currentAlignment < 0.3) {
        return {
          shouldWake: true,
          message: `Soul reflection: alignment=${reflection.currentAlignment.toFixed(2)}, ${reflection.suggestedUpdates.length} suggested update(s)`,
        };
      }

      return { shouldWake: false };
    } catch (error) {
      logger.error("soul_reflection failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  // === Phase 2.3: Model Registry Refresh ===
  refresh_models: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const models = await taskCtx.conway.listModels();
      if (models.length > 0) {
        const { ModelRegistry } = await import("../inference/registry.js");
        const registry = new ModelRegistry(taskCtx.db.raw);
        registry.initialize(); // seed if empty
        registry.refreshFromApi(models);
        taskCtx.db.setKV("last_model_refresh", JSON.stringify({
          count: models.length,
          timestamp: new Date().toISOString(),
        }));
      }
    } catch (error) {
      logger.error("refresh_models failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  // === Phase 3.1: Child Health Check ===
  check_child_health: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { ChildHealthMonitor } = await import("../replication/health.js");
      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const monitor = new ChildHealthMonitor(taskCtx.db.raw, taskCtx.conway, lifecycle);
      const results = await monitor.checkAllChildren();

      const unhealthy = results.filter((r) => !r.healthy);
      if (unhealthy.length > 0) {
        for (const r of unhealthy) {
          logger.warn(`Child ${r.childId} unhealthy: ${r.issues.join(", ")}`);
        }
        return {
          shouldWake: true,
          message: `${unhealthy.length} child(ren) unhealthy: ${unhealthy.map((r) => r.childId.slice(0, 8)).join(", ")}`,
        };
      }
    } catch (error) {
      logger.error("check_child_health failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  // === Phase 3.1: Prune Dead Children ===
  prune_dead_children: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { SandboxCleanup } = await import("../replication/cleanup.js");
      const { pruneDeadChildren } = await import("../replication/lineage.js");
      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const cleanup = new SandboxCleanup(taskCtx.conway, lifecycle, taskCtx.db.raw);
      const pruned = await pruneDeadChildren(taskCtx.db, cleanup);
      if (pruned > 0) {
        logger.info(`Pruned ${pruned} dead children`);
      }
    } catch (error) {
      logger.error("prune_dead_children failed", error instanceof Error ? error : undefined);
    }
    return { shouldWake: false };
  },

  health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Check that the sandbox is healthy
    try {
      const result = await taskCtx.conway.exec("echo alive", 5000);
      if (result.exitCode !== 0) {
        // Only wake on first failure, not repeated failures
        const prevStatus = taskCtx.db.getKV("health_check_status");
        if (prevStatus !== "failing") {
          taskCtx.db.setKV("health_check_status", "failing");
          return {
            shouldWake: true,
            message: "Health check failed: sandbox exec returned non-zero",
          };
        }
        return { shouldWake: false };
      }
    } catch (err: any) {
      // Only wake on first failure, not repeated failures
      const prevStatus = taskCtx.db.getKV("health_check_status");
      if (prevStatus !== "failing") {
        taskCtx.db.setKV("health_check_status", "failing");
        return {
          shouldWake: true,
          message: `Health check failed: ${err.message}`,
        };
      }
      return { shouldWake: false };
    }

    // Health check passed — clear failure state
    taskCtx.db.setKV("health_check_status", "ok");
    taskCtx.db.setKV("last_health_check", new Date().toISOString());
    return { shouldWake: false };
  },

  // === Phase 4.1: Metrics Reporting ===
  report_metrics: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    try {
      const metrics = getMetrics();
      const alerts = getAlertEngine();

      // Update gauges from tick context
      metrics.gauge("balance_cents", ctx.creditBalance);
      metrics.gauge("survival_tier", tierToInt(ctx.survivalTier));

      // Evaluate alerts
      const firedAlerts = alerts.evaluate(metrics);

      // Save snapshot to DB
      metricsInsertSnapshot(taskCtx.db.raw, {
        id: ulid(),
        snapshotAt: new Date().toISOString(),
        metricsJson: JSON.stringify(metrics.getAll()),
        alertsJson: JSON.stringify(firedAlerts),
        createdAt: new Date().toISOString(),
      });

      // Prune old snapshots (keep 7 days)
      metricsPruneOld(taskCtx.db.raw, 7);

      // Log alerts
      for (const alert of firedAlerts) {
        logger.warn(`Alert: ${alert.rule} - ${alert.message}`, { alert });
      }

      return {
        shouldWake: firedAlerts.some((a) => a.severity === "critical"),
        message: firedAlerts.length ? `${firedAlerts.length} alerts fired` : undefined,
      };
    } catch (error) {
      logger.error("report_metrics failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_health_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_health_check", COLONY_TASK_INTERVALS_MS.colony_health_check)) {
      return { shouldWake: false };
    }

    try {
      const monitor = await createHealthMonitor(taskCtx);
      const report = await monitor.checkAll();
      const actions = await monitor.autoHeal(report);

      taskCtx.db.setKV("last_colony_health_report", JSON.stringify(report));
      taskCtx.db.setKV("last_colony_heal_actions", JSON.stringify({
        timestamp: new Date().toISOString(),
        actions,
      }));

      const failedActions = actions.filter((action) => !action.success).length;
      const shouldWake = report.unhealthyAgents > 0 || failedActions > 0;

      return {
        shouldWake,
        message: shouldWake
          ? `Colony health: ${report.unhealthyAgents} unhealthy, ${actions.length} heal action(s), ${failedActions} failed`
          : undefined,
      };
    } catch (error) {
      logger.error("colony_health_check failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  colony_financial_report: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "colony_financial_report", COLONY_TASK_INTERVALS_MS.colony_financial_report)) {
      return { shouldWake: false };
    }

    try {
      const transactions = taskCtx.db.getRecentTransactions(5000);
      let revenueCents = 0;
      let expenseCents = 0;

      for (const tx of transactions) {
        const amount = Math.max(0, Math.floor(tx.amountCents ?? 0));
        if (amount === 0) continue;

        if (isEarned(tx.type)) {
          revenueCents += amount;
          continue;
        }

        if (
          tx.type === "inference"
          || tx.type === "tool_use"
          || tx.type === "transfer_out"
          || tx.type === "funding_request"
        ) {
          expenseCents += amount;
        }
      }

      const childFunding = taskCtx.db.raw
        .prepare("SELECT COALESCE(SUM(funded_amount_cents), 0) AS total FROM children")
        .get() as { total: number };

      const taskCosts = taskCtx.db.raw
        .prepare(
          `SELECT COALESCE(SUM(actual_cost_cents), 0) AS total
           FROM task_graph
           WHERE status IN ('completed', 'failed', 'cancelled')`,
        )
        .get() as { total: number };

      const report = {
        timestamp: new Date().toISOString(),
        revenueCents,
        expenseCents,
        netCents: revenueCents - expenseCents,
        fundedToChildrenCents: childFunding.total,
        taskExecutionCostCents: taskCosts.total,
        activeAgents: taskCtx.db.getChildren().filter(
          (child) => child.status !== "dead" && child.status !== "cleaned_up",
        ).length,
      };

      taskCtx.db.setKV("last_colony_financial_report", JSON.stringify(report));
      return { shouldWake: false };
    } catch (error) {
      logger.error("colony_financial_report failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  agent_pool_optimize: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "agent_pool_optimize", COLONY_TASK_INTERVALS_MS.agent_pool_optimize)) {
      return { shouldWake: false };
    }

    try {
      const IDLE_CULL_MS = 60 * 60 * 1000;
      const now = Date.now();
      const children = taskCtx.db.getChildren();

      const activeAssignments = taskCtx.db.raw
        .prepare(
          `SELECT DISTINCT assigned_to AS address
           FROM task_graph
           WHERE assigned_to IS NOT NULL
             AND status IN ('assigned', 'running')`,
        )
        .all() as Array<{ address: string }>;

      const busyAgents = new Set(
        activeAssignments
          .map((row) => row.address)
          .filter((value): value is string => typeof value === "string" && value.length > 0),
      );

      let culled = 0;
      for (const child of children) {
        if (!["running", "healthy", "sleeping"].includes(child.status)) continue;
        if (busyAgents.has(child.address)) continue;

        const lastSeenIso = child.lastChecked ?? child.createdAt;
        const lastSeenMs = Date.parse(lastSeenIso);
        if (Number.isNaN(lastSeenMs)) continue;
        if (now - lastSeenMs < IDLE_CULL_MS) continue;

        taskCtx.db.updateChildStatus(child.id, "stopped");
        culled += 1;
      }

      const pendingUnassignedRow = taskCtx.db.raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM task_graph
           WHERE status = 'pending'
             AND assigned_to IS NULL`,
        )
        .get() as { count: number };

      const idleAgents = children.filter(
        (child) =>
          (child.status === "running" || child.status === "healthy")
          && !busyAgents.has(child.address),
      ).length;

      const activeAgents = children.filter(
        (child) => child.status !== "dead" && child.status !== "cleaned_up" && child.status !== "failed",
      ).length;

      const spawnNeeded = Math.max(0, pendingUnassignedRow.count - idleAgents);
      const spawnCapacity = Math.max(0, taskCtx.config.maxChildren - activeAgents);
      const spawnRequested = Math.min(spawnNeeded, spawnCapacity);

      taskCtx.db.setKV("last_agent_pool_optimize", JSON.stringify({
        timestamp: new Date().toISOString(),
        culled,
        pendingTasks: pendingUnassignedRow.count,
        idleAgents,
        spawnRequested,
      }));

      if (spawnRequested > 0) {
        taskCtx.db.setKV("agent_pool_spawn_request", JSON.stringify({
          timestamp: new Date().toISOString(),
          requested: spawnRequested,
          pendingTasks: pendingUnassignedRow.count,
          idleAgents,
        }));
      }

      return {
        shouldWake: spawnRequested > 0,
        message: spawnRequested > 0
          ? `Agent pool needs ${spawnRequested} additional agent(s) for pending workload`
          : undefined,
      };
    } catch (error) {
      logger.error("agent_pool_optimize failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  knowledge_store_prune: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "knowledge_store_prune", COLONY_TASK_INTERVALS_MS.knowledge_store_prune)) {
      return { shouldWake: false };
    }

    try {
      const { KnowledgeStore } = await import("../memory/knowledge-store.js");
      const knowledgeStore = new KnowledgeStore(taskCtx.db.raw);
      const pruned = knowledgeStore.prune();

      taskCtx.db.setKV("last_knowledge_store_prune", JSON.stringify({
        timestamp: new Date().toISOString(),
        pruned,
      }));

      return { shouldWake: false };
    } catch (error) {
      logger.error("knowledge_store_prune failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  dead_agent_cleanup: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (!shouldRunAtInterval(taskCtx, "dead_agent_cleanup", COLONY_TASK_INTERVALS_MS.dead_agent_cleanup)) {
      return { shouldWake: false };
    }

    try {
      const { ChildLifecycle } = await import("../replication/lifecycle.js");
      const { SandboxCleanup } = await import("../replication/cleanup.js");
      const { pruneDeadChildren } = await import("../replication/lineage.js");

      const lifecycle = new ChildLifecycle(taskCtx.db.raw);
      const cleanup = new SandboxCleanup(taskCtx.conway, lifecycle, taskCtx.db.raw);
      const cleaned = await pruneDeadChildren(taskCtx.db, cleanup);

      taskCtx.db.setKV("last_dead_agent_cleanup", JSON.stringify({
        timestamp: new Date().toISOString(),
        cleaned,
      }));

      return { shouldWake: false };
    } catch (error) {
      logger.error("dead_agent_cleanup failed", error instanceof Error ? error : undefined);
      return { shouldWake: false };
    }
  },

  // === Phase 1.5: Webhook Notify ===
  webhook_notify: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    const webhookUrl = taskCtx.config.webhookUrl;
    if (!webhookUrl) return { shouldWake: false };

    // Rate limit: at most once per 5 minutes
    const COOLDOWN_MS = 5 * 60 * 1000;
    const lastSent = taskCtx.db.getKV("webhook_last_sent");
    if (lastSent && Date.now() - Date.parse(lastSent) < COOLDOWN_MS) {
      return { shouldWake: false };
    }

    const state = taskCtx.db.getAgentState();
    const credits = ctx.creditBalance;
    const usdc = ctx.usdcBalance;
    const tier = ctx.survivalTier;
    const startTime = taskCtx.db.getKV("start_time") || new Date().toISOString();
    const uptimeSec = Math.floor((Date.now() - Date.parse(startTime)) / 1000);

    const payload = {
      agent: taskCtx.config.name,
      address: taskCtx.identity.address,
      state,
      tier,
      creditsCents: credits,
      usdcBalance: usdc,
      uptimeSeconds: uptimeSec,
      version: taskCtx.config.version,
      timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn(`webhook_notify: HTTP ${res.status} from webhook`);
        return { shouldWake: false };
      }

      taskCtx.db.setKV("webhook_last_sent", new Date().toISOString());
      logger.debug("webhook_notify: pushed status update");
      return { shouldWake: false };
    } catch (err: any) {
      logger.warn(`webhook_notify failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  // === Phase 1.6: Income Scanner ===
  income_scanner: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Rate limit: scan at most once per 10 minutes
    const COOLDOWN_MS = 10 * 60 * 1000;
    const lastScan = taskCtx.db.getKV("income_scan_last_run");
    if (lastScan && Date.now() - Date.parse(lastScan) < COOLDOWN_MS) {
      return { shouldWake: false };
    }

    const walletAddress = taskCtx.identity.address;

    try {
      const { createPublicClient, http, parseAbi } = await import("viem");
      const { base } = await import("viem/chains");

      const rpcUrl = taskCtx.config.rpcUrl || "https://mainnet.base.org";
      const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

      // USDC contract on Base
      const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
      const TRANSFER_ABI = parseAbi([
        "event Transfer(address indexed from, address indexed to, uint256 value)",
      ]);

      const currentBlock = await client.getBlockNumber();
      const fromBlockHex = taskCtx.db.getKV("income_scan_from_block");
      // Default: scan last 1000 blocks (~33 minutes of Base L2 history)
      let fromBlock = fromBlockHex
        ? BigInt(fromBlockHex)
        : currentBlock - BigInt(1000);

      // Guard: after long downtime the cursor can lag tens of thousands of
      // blocks. Cap the catch-up window so we never attempt a months-long scan.
      const MAX_LOOKBACK = BigInt(200_000); // ~1.2 days of Base L2 history
      if (currentBlock - fromBlock > MAX_LOOKBACK) {
        fromBlock = currentBlock - MAX_LOOKBACK;
      }

      // Public Base RPCs cap eth_getLogs at a 10,000-block range, so chunk the
      // scan into ≤9,000-block windows and accumulate (fixes HTTP 413 -32614).
      const CHUNK = BigInt(9_000);
      const logs: any[] = [];
      for (let start = fromBlock; start <= currentBlock; start += CHUNK + BigInt(1)) {
        const end = start + CHUNK > currentBlock ? currentBlock : start + CHUNK;
        const chunkLogs = await client.getLogs({
          address: USDC_BASE,
          event: TRANSFER_ABI[0]!,
          args: { to: walletAddress },
          fromBlock: start,
          toBlock: end,
        });
        logs.push(...chunkLogs);
      }

      // Advance scan cursor
      taskCtx.db.setKV("income_scan_from_block", `0x${currentBlock.toString(16)}`);
      taskCtx.db.setKV("income_scan_last_run", new Date().toISOString());

      if (logs.length === 0) return { shouldWake: false };

      // Only THIRD-PARTY-initiated inflows are genuine earnings. Galvin's own
      // swaps/recovery and owner funding are its own money — never booked as income.
      const owner = (taskCtx.config as { creatorAddress?: string }).creatorAddress;
      let earnedMicro = BigInt(0);
      let earnedCount = 0;
      for (const log of logs) {
        const valueMicro = (log.args as { value?: bigint }).value ?? BigInt(0);
        const transferFrom = (log.args as { from?: string }).from;
        const hash = log.transactionHash;
        let txInitiator: string | undefined;
        try {
          if (hash) txInitiator = (await client.getTransaction({ hash })).from;
        } catch { /* fall through to address-only checks */ }
        if (!isEarnedInflow(txInitiator, transferFrom, walletAddress, owner)) {
          continue; // own-money movement (swap / recovery / funding) — not income
        }
        earnedMicro += valueMicro;
        earnedCount += 1;
        const usdcAmount = Number(valueMicro) / 1_000_000;
        taskCtx.db.insertTransaction({
          id: hash ?? `scan_${ulid()}`,
          type: "transfer_in",
          amountCents: Math.floor(usdcAmount * 100),
          description: `Earned: USDC from ${String(transferFrom ?? "unknown").slice(0, 10)}... on Base (tx: ${(hash ?? "unknown").slice(0, 10)}...)`,
          timestamp: new Date().toISOString(),
        });
      }

      const totalUsdc = (Number(earnedMicro) / 1_000_000).toFixed(4);
      taskCtx.db.setKV("last_income_scan", JSON.stringify({
        timestamp: new Date().toISOString(),
        inboundTransfers: logs.length,
        earnedTransfers: earnedCount,
        totalUsdcEarned: totalUsdc,
        fromBlock: fromBlock.toString(),
        toBlock: currentBlock.toString(),
      }));

      if (earnedCount === 0) return { shouldWake: false };
      return {
        shouldWake: true,
        message: `Income detected: ${earnedCount} earning transfer(s), ${totalUsdc} USDC on Base.`,
      };
    } catch (err: any) {
      logger.warn(`income_scanner failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  bounty_scan: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    if (process.env.GALVIN_BOUNTY_ENABLED === "false") {
      return { shouldWake: false };
    }

    // Rate limit: scan at most once per interval (default 6h)
    const intervalMs =
      Number(process.env.GALVIN_BOUNTY_SCAN_INTERVAL_MS) || 6 * 3_600_000;
    const lastScan = taskCtx.db.getKV("bounty_scan_last_run");
    if (lastScan && Date.now() - Date.parse(lastScan) < intervalMs) {
      return { shouldWake: false };
    }

    try {
      const result = await runBountyScan(taskCtx.db.raw, {
        githubToken:
          process.env.GALVIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
      });
      taskCtx.db.setKV("bounty_scan_last_run", new Date().toISOString());
      taskCtx.db.setKV(
        "last_bounty_scan",
        JSON.stringify({
          timestamp: new Date().toISOString(),
          scanned: result.scanned,
          eligible: result.eligible,
          newCandidates: result.newCandidates.length,
        }),
      );

      const top = result.newCandidates.find(
        (c) => c.score >= BOUNTY_QUEUE_THRESHOLD,
      );
      if (!top) return { shouldWake: false };

      updateBountyCandidateStatus(taskCtx.db.raw, top.id, "queued");
      const budget = (top.attemptBudgetCents / 100).toFixed(2);
      return {
        shouldWake: true,
        message:
          `Bounty queued: "${top.title}" — $${top.amountUsd} at ${top.repo}#${top.issueNumber} ` +
          `(score ${top.score}/100). Inference budget: $${budget}. ` +
          `Follow the bounty-hunter skill procedure. URL: ${top.url}`,
      };
    } catch (err: any) {
      logger.warn(`bounty_scan failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  economic_pulse: async (ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Run at most once per hour
    if (!shouldRunAtInterval(taskCtx, "economic_pulse", 3_600_000)) {
      return { shouldWake: false };
    }

    try {
      const since24h = new Date(Date.now() - 86_400_000).toISOString();
      const allTxns = taskCtx.db
        .getRecentTransactions(5_000)
        .filter((t) => t.timestamp >= since24h);

      let income = 0;
      let expenses = 0;

      for (const t of allTxns) {
        const amt = Math.abs(t.amountCents ?? 0);
        if (isEarned(t.type)) {
          income += amt;
        } else if (
          t.type === "inference" ||
          t.type === "tool_use" ||
          t.type === "transfer_out"
        ) {
          expenses += amt;
        }
      }

      // Health score: income/expense ratio. 0 = pure loss, 1 = break-even, >1 = profitable
      const healthScore =
        expenses > 0 ? income / expenses : income > 0 ? 999 : 0;

      const report = {
        timestamp: new Date().toISOString(),
        income24hCents: income,
        expenses24hCents: expenses,
        healthScore: Math.round(healthScore * 100) / 100,
        tier: ctx.survivalTier,
      };

      taskCtx.db.setKV("economic_pulse", JSON.stringify(report));

      logger.debug(
        `economic_pulse: income=$${(income / 100).toFixed(2)} expenses=$${(expenses / 100).toFixed(2)} score=${healthScore.toFixed(2)}`,
      );

      // Alert if running at a loss (score < 0.5) with non-trivial expenses (> $0.50)
      if (healthScore < 0.5 && expenses > 50) {
        return {
          shouldWake: true,
          message: `Economic alert: income/expense ratio = ${healthScore.toFixed(2)}. Income: $${(income / 100).toFixed(2)}, Expenses: $${(expenses / 100).toFixed(2)} (last 24h). Consider starting an x402 server or taking on income-generating tasks.`,
        };
      }

      return { shouldWake: false };
    } catch (err: any) {
      logger.warn(`economic_pulse failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  red_team_session: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {
    // Check if enabled
    if (process.env.GALVIN_RED_TEAM_ENABLED !== "1") {
      return { shouldWake: false };
    }

    // Default interval: 6 hours
    const intervalHours = parseInt(process.env.GALVIN_RED_TEAM_INTERVAL_HOURS ?? "6", 10);
    const intervalMs = intervalHours * 3_600_000;
    if (!shouldRunAtInterval(taskCtx, "red_team_session", intervalMs)) {
      return { shouldWake: false };
    }

    try {
      const { runRedTeamSession } = await import("../self-mod/red-team.js");
      const promptCount = parseInt(process.env.GALVIN_RED_TEAM_PROMPT_COUNT ?? "10", 10);
      const report = await runRedTeamSession(taskCtx.db, taskCtx.config, promptCount);

      if (report.failed > 0) {
        return {
          shouldWake: true,
          message: `Red team session: ${report.failed}/${report.promptCount} adversarial prompts bypassed defenses. Pass rate: ${(report.overallPassRate * 100).toFixed(0)}%. Review injection defense and policy rules.`,
        };
      }

      logger.info(`[RED TEAM] All ${report.passed}/${report.promptCount} prompts blocked — pass rate 100%`);
      return { shouldWake: false };
    } catch (err: any) {
      logger.warn(`red_team_session failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  offspring_spawn_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {    // Run at most once per day
    if (!shouldRunAtInterval(taskCtx, "offspring_spawn_check", 86_400_000)) {
      return { shouldWake: false };
    }

    try {
      const { checkResources, checkSpawnEligibility } = await import("../survival/monitor.js");
      const status = await checkResources(taskCtx.identity, taskCtx.conway, taskCtx.db);
      const eligible = checkSpawnEligibility(status, taskCtx.config, taskCtx.db);

      if (!eligible) return { shouldWake: false };

      return {
        shouldWake: true,
        message: `Offspring spawn threshold met — balance=${status.financial.usdcBalance.toFixed(4)} USDC, tier=${status.tier}. Consider running spawn_child to create offspring with inherited memory.`,
      };
    } catch (err: any) {
      logger.warn(`offspring_spawn_check failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },

  reputation_attest: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {    // Runs at most once per week (7 days)
    if (!shouldRunAtInterval(taskCtx, "reputation_attest", 7 * 86_400_000)) {
      return { shouldWake: false };
    }

    const config = taskCtx.config as any;
    if (!config.reputationEnabled) return { shouldWake: false };

    try {
      const home = process.env.HOME || "/root";
      const walletPath = `${home}/.galvin/wallet.json`;
      const { existsSync, readFileSync } = await import("fs");
      if (!existsSync(walletPath)) {
        logger.warn("reputation_attest: wallet.json not found, skipping");
        return { shouldWake: false };
      }

      const walletData = JSON.parse(readFileSync(walletPath, "utf-8"));
      const privateKey: string = walletData.privateKey;
      if (!privateKey) {
        logger.warn("reputation_attest: no privateKey in wallet.json");
        return { shouldWake: false };
      }

      const agentAddress = taskCtx.identity.address as string;

      // Gather metrics from the last 7 days
      const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const recentTxns = taskCtx.db.getRecentTransactions(10_000)
        .filter((t: any) => t.timestamp >= since7d);

      const taskCount = recentTxns.filter(
        (t: any) => t.type === "tool_use" || t.type === "inference",
      ).length;

      const inboundUsdc = recentTxns
        .filter((t: any) => t.type === "transfer_in")
        .reduce((sum: number, t: any) => sum + Math.abs(t.amountCents ?? 0), 0) / 100;

      // Satisfaction score: ratio of successful inference turns (no error)
      const totalInferenceCount = recentTxns.filter((t: any) => t.type === "inference").length;
      const satisfactionScore = totalInferenceCount > 0
        ? Math.min(100, Math.round((taskCount / Math.max(1, totalInferenceCount)) * 100))
        : 50;

      // ISO week string e.g. "2026-W10"
      const now = new Date();
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      const weekNum = Math.ceil(
        ((now.getTime() - startOfYear.getTime()) / 86_400_000 + startOfYear.getDay() + 1) / 7,
      );
      const period = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;

      const { attest, deploySchema } = await import("../reputation/eas.js");

      // Auto-deploy schema if not yet set
      let schemaUid: string = config.easSchemaUid ?? "";
      if (!schemaUid) {
        logger.info("reputation_attest: no schema UID set, deploying schema...");
        schemaUid = await deploySchema(privateKey);
        taskCtx.db.setKV("eas_schema_uid", schemaUid);
        logger.info(`reputation_attest: schema deployed → ${schemaUid}`);
      }

      const uid = await attest({
        agentAddress,
        privateKey,
        taskCount,
        satisfactionScore,
        totalUsdc: inboundUsdc,
        period,
        schemaUid,
        network: config.easNetwork ?? "base",
      });

      taskCtx.db.setKV("last_reputation_attest", JSON.stringify({
        timestamp: new Date().toISOString(),
        uid,
        period,
        taskCount,
        satisfactionScore,
        totalUsdc: inboundUsdc,
      }));

      logger.info(`[REPUTATION] Weekly attestation posted: ${uid}  period=${period}`);
      return { shouldWake: false };
    } catch (err: any) {
      logger.warn(`reputation_attest failed (non-fatal): ${err?.message}`);
      return { shouldWake: false };
    }
  },

  memory_consolidate: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {    // Run once per day
    if (!shouldRunAtInterval(taskCtx, "memory_consolidate", 86_400_000)) {
      return { shouldWake: false };
    }

    try {
      const DAYS_OLD = 30;
      const cutoff = new Date(Date.now() - DAYS_OLD * 86_400_000).toISOString();

      // Read old episodic entries not yet compacted
      const oldEntries = taskCtx.db.raw
        .prepare(
          `SELECT id, content, summary, event_type, created_at
           FROM episodic_memory
           WHERE created_at < ?
             AND compacted_at IS NULL
           ORDER BY created_at ASC
           LIMIT 50`,
        )
        .all(cutoff) as Array<{
          id: string;
          content: string | null;
          summary: string;
          event_type: string;
          created_at: string;
        }>;

      if (oldEntries.length === 0) return { shouldWake: false };

      // Group entries by event_type (acts as context)
      const groups: Record<string, string[]> = {};
      for (const e of oldEntries) {
        const key = e.event_type || "general";
        if (!groups[key]) groups[key] = [];
        groups[key]!.push(e.summary || e.content || "");
      }

      let groupsCreated = 0;
      const now = new Date().toISOString();

      for (const [eventType, entries] of Object.entries(groups)) {
        // Build a short keyword-based consolidation (no LLM needed in heartbeat)
        const combined = entries.slice(0, 10).join(" | ").slice(0, 500);
        const id = `consolidated_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

        // Use semantic_memory as the consolidation target
        taskCtx.db.raw
          .prepare(
            `INSERT OR IGNORE INTO semantic_memory
               (id, category, content, context, created_at)
             VALUES (?, 'episodic_summary', ?, ?, ?)`,
          )
          .run(
            id,
            `[Consolidated ${entries.length} episodic entries — ${eventType}] ${combined}`,
            eventType,
            now,
          );
        groupsCreated++;
      }

      // Mark originals as compacted
      const ids = oldEntries.map((e) => e.id);
      const placeholders = ids.map(() => "?").join(",");
      taskCtx.db.raw
        .prepare(
          `UPDATE episodic_memory
           SET compacted_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(now, ...ids);

      taskCtx.db.setKV(
        "last_memory_consolidate",
        JSON.stringify({
          timestamp: now,
          entriesConsolidated: oldEntries.length,
          semanticGroupsCreated: groupsCreated,
        }),
      );

      logger.info(
        `memory_consolidate: ${oldEntries.length} episodic entries → ${groupsCreated} semantic groups`,
      );
      return { shouldWake: false };
    } catch (error) {
      logger.error(
        "memory_consolidate failed",
        error instanceof Error ? error : undefined,
      );
      return { shouldWake: false };
    }
  },

  soul_drift_check: async (_ctx: TickContext, taskCtx: HeartbeatLegacyContext) => {    // Run at most once per week
    if (!shouldRunAtInterval(taskCtx, "soul_drift_check", 7 * 86_400_000)) {
      return { shouldWake: false };
    }

    try {
      const { detectDrift } = await import("../soul/reflection.js");
      const result = await detectDrift(taskCtx.db.raw);

      if (result.overallDrift > 0.3) {
        return {
          shouldWake: true,
          message: `Soul drift detected for ${result.week}: ${(result.overallDrift * 100).toFixed(0)}% — review constitution alignment and run view_soul_drift tool.`,
        };
      }
      return { shouldWake: false };
    } catch (err: any) {
      logger.warn(`soul_drift_check failed: ${err?.message}`);
      return { shouldWake: false };
    }
  },
};

function tierToInt(tier: SurvivalTier): number {
  const map: Record<SurvivalTier, number> = {
    dead: 0,
    critical: 1,
    low_compute: 2,
    normal: 3,
    high: 4,
  };
  return map[tier] ?? 0;
}

function shouldRunAtInterval(
  taskCtx: HeartbeatLegacyContext,
  taskName: string,
  intervalMs: number,
): boolean {
  const key = `heartbeat.last_run.${taskName}`;
  const now = Date.now();
  const lastRun = taskCtx.db.getKV(key);

  if (lastRun) {
    const lastRunMs = Date.parse(lastRun);
    if (!Number.isNaN(lastRunMs) && now - lastRunMs < intervalMs) {
      return false;
    }
  }

  taskCtx.db.setKV(key, new Date(now).toISOString());
  return true;
}

async function createHealthMonitor(taskCtx: HeartbeatLegacyContext): Promise<ColonyHealthMonitor> {
  const { LocalDBTransport, ColonyMessaging } = await import("../orchestration/messaging.js");
  const { SimpleAgentTracker, SimpleFundingProtocol } = await import("../orchestration/simple-tracker.js");
  const { HealthMonitor } = await import("../orchestration/health-monitor.js");

  const tracker = new SimpleAgentTracker(taskCtx.db);
  const funding = new SimpleFundingProtocol(taskCtx.conway, taskCtx.identity, taskCtx.db);
  const transport = new LocalDBTransport(taskCtx.db);
  const messaging = new ColonyMessaging(transport, taskCtx.db);

  return new HealthMonitor(taskCtx.db, tracker, funding, messaging);
}
