/**
 * Error classifier — distinguishes *why* a turn failed so the loop reacts
 * intelligently instead of treating every failure as imminent death.
 *
 * Adapted in Galvin's style from the hermes-agent error-classifier pattern.
 * The agent loop previously incremented a single "consecutive errors" counter
 * for ANY exception and slept after 5 — so a network blip or an unfunded
 * provider looked identical to a real bug. This separates them.
 */

export type ErrorCategory = "funding" | "rate_limit" | "transient" | "fatal";

export interface ClassifiedError {
  category: ErrorCategory;
  /** True if simply retrying later is reasonable. */
  retryable: boolean;
  /** Suggested backoff before the loop should try again, in ms. */
  backoffMs: number;
  /** Short human-readable explanation for logs. */
  reason: string;
}

// Provider/credit exhaustion — the agent is broke, not broken. Don't busy-spin
// and don't count it as a fatal bug; back off and let funding/heartbeat revive.
const FUNDING_RE =
  /insufficient_quota|exceeded your current quota|payment required|\b402\b|no credits|insufficient (funds|balance|credits)|billing|out of credits/i;

// Provider throttling — retryable after a cooldown.
const RATE_LIMIT_RE = /rate.?limit|\b429\b|too many requests|quota.*per (minute|second)|overloaded/i;

// Network / infra hiccups — retryable after a short backoff.
const TRANSIENT_RE =
  /circuit breaker|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang ?up|network|fetch failed|\b5\d\d\b|temporarily|unavailable|connection (closed|reset)/i;

/**
 * Classify a thrown error into one of four categories with a recommended
 * backoff. Unknown errors are treated as `fatal` (they count toward the
 * loop's death guard) — the conservative default.
 */
export function classifyError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err ?? "");

  if (FUNDING_RE.test(msg)) {
    return {
      category: "funding",
      retryable: false,
      backoffMs: 120_000,
      reason: "no funded inference provider (quota/credits exhausted)",
    };
  }
  if (RATE_LIMIT_RE.test(msg)) {
    return {
      category: "rate_limit",
      retryable: true,
      backoffMs: 30_000,
      reason: "provider rate-limited",
    };
  }
  if (TRANSIENT_RE.test(msg)) {
    return {
      category: "transient",
      retryable: true,
      backoffMs: 8_000,
      reason: "transient network/provider error",
    };
  }
  return {
    category: "fatal",
    retryable: false,
    backoffMs: 0,
    reason: "unclassified error (treated as fatal)",
  };
}
