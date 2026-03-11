/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("inference.router");

type Database = BetterSqlite3.Database;

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;

  constructor(db: Database, registry: ModelRegistry, budget: InferenceBudgetTracker) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select model from routing matrix
    const model = this.selectModel(tier, taskType);
    if (!model) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // 2. Estimate cost and check budget
    const estimatedTokens = messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
    const estimatedCostCents = Math.ceil(
      (estimatedTokens / 1000) * model.costPer1kInput / 100 +
      (request.maxTokens || 1000) / 1000 * model.costPer1kOutput / 100,
    );

    const budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
    if (!budgetCheck.allowed) {
      return {
        content: `Budget exceeded: ${budgetCheck.reason}`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
      };
    }

    // 3. Check session budget
    if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
      const sessionCost = this.budget.getSessionCost(request.sessionId);
      if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
        return {
          content: `Session budget exceeded: ${sessionCost}c spent + ${estimatedCostCents}c estimated > ${this.budget.config.sessionBudgetCents}c limit`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: 0,
          finishReason: "budget_exceeded",
        };
      }
    }

    // 4. Collect all candidates for failover (primary model first)
    const allCandidates = this.selectAllCandidates(tier, taskType, model.modelId);

    // 5. Build shared settings (max tokens + timeout are per-request, not per-provider)
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
    const timeout = TASK_TIMEOUTS[taskType] || 120_000;

    // 6–9. Try each candidate in order; retry on transient / rate-limit errors
    let lastError: Error | null = null;
    for (const candidate of allCandidates) {
      const transformedMessages = this.transformMessagesForProvider(messages, candidate.provider);
      const inferenceOptions: any = {
        model: candidate.modelId,
        maxTokens,
        tools,
      };

      const startTime = Date.now();
      let response: any;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          inferenceOptions.signal = controller.signal;
          response = await inferenceChat(transformedMessages, inferenceOptions);
        } finally {
          clearTimeout(timer);
        }
      } catch (error: any) {
        const latencyMs = Date.now() - startTime;
        const isRetryable =
          error?.name === "AbortError" ||
          /rate.?limit|429|503|overloaded|timeout|service.?unavailable/i.test(
            error?.message ?? "",
          );
        const hasNextCandidate = allCandidates.indexOf(candidate) < allCandidates.length - 1;

        if (isRetryable && hasNextCandidate) {
          const reason =
            error?.name === "AbortError" ? `timeout after ${timeout}ms` : error?.message;
          logger.warn(`[failover] ${candidate.modelId} failed (${reason}) — trying next provider`);
          lastError = error;
          continue; // try next candidate
        }

        // Not retryable, or this was the last candidate
        if (error?.name === "AbortError") {
          return {
            content: `Inference timeout after ${timeout}ms`,
            model: candidate.modelId,
            provider: candidate.provider,
            inputTokens: 0,
            outputTokens: 0,
            costCents: 0,
            latencyMs,
            finishReason: "timeout",
          };
        }
        throw error;
      }

      const latencyMs = Date.now() - startTime;

      // Log when a fallback candidate was used
      if (candidate.modelId !== model.modelId) {
        logger.info(
          `[failover] Succeeded with fallback: ${candidate.modelId} (primary was: ${model.modelId})`,
        );
      }

      // Calculate actual cost
      const inputTokens = response.usage?.promptTokens || 0;
      const outputTokens = response.usage?.completionTokens || 0;
      const actualCostCents = Math.ceil(
        (inputTokens / 1000) * candidate.costPer1kInput / 100 +
        (outputTokens / 1000) * candidate.costPer1kOutput / 100,
      );

      // Record cost
      this.budget.recordCost({
        sessionId,
        turnId: turnId || null,
        model: candidate.modelId,
        provider: candidate.provider,
        inputTokens,
        outputTokens,
        costCents: actualCostCents,
        latencyMs,
        tier,
        taskType,
        cacheHit: false,
      });

      // Return successful result
      return {
        content: response.message?.content || "",
        model: candidate.modelId,
        provider: candidate.provider,
        inputTokens,
        outputTokens,
        costCents: actualCostCents,
        latencyMs,
        toolCalls: response.toolCalls,
        finishReason: response.finishReason || "stop",
      };
    }

    // All candidates exhausted
    return {
      content: `All inference providers failed. Last error: ${lastError?.message ?? "unknown"}`,
      model: model.modelId,
      provider: model.provider,
      inputTokens: 0,
      outputTokens: 0,
      costCents: 0,
      latencyMs: 0,
      finishReason: "error",
    };
  }

  /**
   * Return ALL valid model candidates for a tier/taskType, in priority order.
   * Primary model (from selectModel) is always first. Used by the failover loop.
   */
  selectAllCandidates(
    tier: SurvivalTier,
    taskType: InferenceTaskType,
    primaryModelId?: string,
  ): ModelEntry[] {
    const seen = new Set<string>();
    const result: ModelEntry[] = [];

    const addEntry = (entry: ModelEntry | undefined | null) => {
      if (entry && entry.enabled && !seen.has(entry.modelId)) {
        seen.add(entry.modelId);
        result.push(entry);
      }
    };

    // Primary model first (already selected via selectModel)
    if (primaryModelId) {
      addEntry(this.registry.get(primaryModelId));
    }

    // All routing-matrix candidates for this tier/taskType
    const preference = this.getPreference(tier, taskType);
    if (preference) {
      for (const candidateId of preference.candidates) {
        addEntry(this.registry.get(candidateId));
      }
    }

    // Configured fallback models (handles Ollama / local setups)
    const strategy = this.budget.config;
    for (const modelId of [
      strategy.inferenceModel,
      strategy.criticalModel,
      strategy.lowComputeModel,
    ]) {
      if (modelId) addEntry(this.registry.get(modelId));
    }

    // Ensure there's always at least one option
    if (result.length === 0) {
      const primary = this.selectModel(tier, taskType);
      if (primary) result.push(primary);
    }

    return result;
  }

  /**
   * Select the best model for a given tier and task type.
   *
   * Priority:
   *   1. First routing-matrix candidate present in the registry
   *   2. User-configured model(s) from ModelStrategyConfig
   *      (free/Ollama models are allowed at any tier, including dead)
   */
  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    const TIER_ORDER: Record<string, number> = {
      dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
    };

    const tierRank = TIER_ORDER[tier] ?? 0;

    // 1. Try routing-matrix candidates
    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length > 0) {
      for (const candidateId of preference.candidates) {
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled) {
          return entry;
        }
      }
    }

    // 2. Fall back to user-configured models.
    //    This handles local/Ollama setups where routing-matrix models are absent.
    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId) continue;
      const entry = this.registry.get(modelId);
      if (!entry || !entry.enabled) continue;
      const isFree = entry.costPer1kInput === 0 && entry.costPer1kOutput === 0;
      const tierOk = tierRank >= (TIER_ORDER[entry.tierMinimum] ?? 0);
      if (isFree || tierOk) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI/Conway, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements:
   * 1. Extract system messages
   * 2. Merge consecutive same-role messages
   * 3. Merge consecutive tool messages into a single user message
   *    with multiple tool_result content blocks
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      // System messages are handled separately by the Anthropic client
      if (msg.role === "system") {
        result.push(msg);
        continue;
      }

      // Tool messages become user messages with tool_result content
      if (msg.role === "tool") {
        const last = result[result.length - 1];
        // If previous message was also a tool (now a user), merge into it
        if (last && last.role === "user" && (last as any)._toolResultMerged) {
          // Append to the merged content
          last.content = last.content + "\n[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content;
          continue;
        }
        // Otherwise create a new user message
        const userMsg: ChatMessage & { _toolResultMerged?: boolean } = {
          role: "user",
          content: "[tool_result:" + (msg.tool_call_id || "unknown") + "] " + msg.content,
          _toolResultMerged: true,
        };
        result.push(userMsg);
        continue;
      }

      // For user/assistant: merge with previous if same role
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }

      result.push({ ...msg });
    }

    // Clean up internal markers
    for (const msg of result) {
      delete (msg as any)._toolResultMerged;
    }

    return result;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}
