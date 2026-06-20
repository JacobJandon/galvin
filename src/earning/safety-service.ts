/**
 * Solvatron Safety Check — the first positive-margin revenue service.
 *
 * THE ECONOMICS (the whole point): a check costs ~$0 to serve (GitHub API +
 * heuristics, no inference) but a buyer pays per call via x402. So every sale is
 * almost pure margin — it can only ever earn, never lose money operating. This is
 * the architectural pivot away from "burn Conway credits + lose money".
 *
 * What it does: given a GitHub repo / bounty URL, returns a real scam/honeypot
 * risk assessment (reusing the honeypot engine). Useful to devs and crypto users
 * vetting unfamiliar repos/bounties before trusting or contributing to them.
 *
 * Runs LOCALLY (no Conway sandbox, no wallet drain). Monetized via the x402
 * server, which verifies payment on-chain and books real `transfer_in` income.
 */

import type { GalvinIdentity, GalvinConfig, GalvinDatabase } from "../types.js";
import { checkHoneypot } from "../registry/honeypot-registry.js";
import { createX402Server, type X402Server } from "./x402-server.js";

export type RiskLevel = "low" | "medium" | "high" | "unknown";

export interface SafetyResult {
  target: string;
  type: "github_repo" | "unsupported";
  safe: boolean | null; // null = could not assess
  risk: RiskLevel;
  reasons: string[];
  signals: Record<string, unknown>;
  checkedAt: string;
  disclaimer: string;
}

const DISCLAIMER = "Heuristic signal check, not a guarantee. Always do your own research.";

const looksLikeRepo = (t: string): boolean =>
  /github\.com\//i.test(t) || /^[\w.-]+\/[\w.-]+$/.test(t.trim());

/** Pure-ish: assess one target. Network only for the GitHub lookup. */
export async function assessTarget(target: string): Promise<SafetyResult> {
  const checkedAt = new Date().toISOString();
  const t = (target || "").trim();
  if (!t) {
    return { target: t, type: "unsupported", safe: null, risk: "unknown", reasons: ["empty target"], signals: {}, checkedAt, disclaimer: DISCLAIMER };
  }

  if (looksLikeRepo(t)) {
    const v = await checkHoneypot(t);
    if (v.repo === null) {
      return { target: t, type: "github_repo", safe: null, risk: "unknown", reasons: [v.reason ?? "unparseable"], signals: v.signals, checkedAt, disclaimer: DISCLAIMER };
    }
    // Couldn't fetch repo metadata (not found / rate-limited): never claim "safe".
    if (v.signals.stars === undefined) {
      return { target: t, type: "github_repo", safe: null, risk: "unknown", reasons: [v.reason ?? "repo not found or could not be assessed"], signals: v.signals, checkedAt, disclaimer: DISCLAIMER };
    }
    if (v.isHoneypot) {
      return { target: t, type: "github_repo", safe: false, risk: "high", reasons: [v.reason ?? "honeypot signals detected"], signals: v.signals, checkedAt, disclaimer: DISCLAIMER };
    }
    // Not flagged. Grade confidence by how established the repo is.
    const stars = Number(v.signals.stars ?? 0);
    const risk: RiskLevel = stars >= 500 ? "low" : stars >= 50 ? "medium" : "medium";
    const reasons = [
      stars >= 500 ? "established, popular repo — no honeypot signals" : "no honeypot signals, but low-profile repo — verify maintainers",
    ];
    if (v.signals.archived) reasons.push("repo is archived");
    return { target: t, type: "github_repo", safe: true, risk, reasons, signals: v.signals, checkedAt, disclaimer: DISCLAIMER };
  }

  return {
    target: t,
    type: "unsupported",
    safe: null,
    risk: "unknown",
    reasons: ["Only GitHub repo / bounty URLs are supported right now (e.g. github.com/owner/repo)."],
    signals: {},
    checkedAt,
    disclaimer: DISCLAIMER,
  };
}

/** The x402 request handler: parse ?target= , run the real check, return JSON. */
export function safetyHandler() {
  return async (req: { url: string; method: string }): Promise<{ body: string; contentType?: string }> => {
    let target = "";
    try {
      target = new URL(req.url, "http://localhost").searchParams.get("target") ?? "";
    } catch { /* malformed url */ }
    if (!target) {
      return { body: JSON.stringify({ error: "missing ?target= (a GitHub repo/bounty URL)" }), contentType: "application/json" };
    }
    const result = await assessTarget(target);
    return { body: JSON.stringify({ service: "solvatron-safety-check", ...result }, null, 2), contentType: "application/json" };
  };
}

export interface SafetyServiceOptions {
  port?: number;
  priceCents?: number; // default 2 ($0.02) — serving cost ≈ $0, so ~100% margin
}

/** Build the monetized safety service (runs locally; pays into Galvin's wallet). */
export function createSafetyService(
  identity: GalvinIdentity,
  config: GalvinConfig,
  db: GalvinDatabase,
  opts: SafetyServiceOptions = {},
): X402Server {
  return createX402Server(identity, config, db, {
    port: opts.port ?? 8402,
    priceCents: opts.priceCents ?? 2,
    description: "Solvatron Safety Check — is this GitHub repo/bounty a scam/honeypot? (per-call)",
    skillId: "safety-check",
    handler: safetyHandler(),
  });
}
