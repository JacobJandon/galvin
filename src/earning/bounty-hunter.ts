/**
 * Bounty Hunter — active earning via GitHub/Algora bounties
 *
 * Scans GitHub for open issues carrying bounty labels (Algora bounties
 * surface as GitHub labels like "💎 Bounty" plus an amount label like "$700"),
 * scores each candidate against anti-honeypot and economic filters, and
 * persists viable candidates to bounty_candidates for the agent to attempt.
 *
 * Economics: every attempt gets a hard inference budget
 * (BOUNTY_BUDGET_RATIO of the bounty value, capped) so a $100 bounty can
 * never burn $100 of compute. Income lands on-chain and is attributed via
 * recordIncome(db, "bounty-hunter", usdc) when payout is detected.
 *
 * Threat model: bounty issues are attacker-controlled text. Titles are
 * sanitized before storage; repos go through reputation hard filters
 * (stars, age, archived, bait-pattern names) because honeypot repos that
 * target autonomous agents exist in the wild.
 */

import type BetterSqlite3 from "better-sqlite3";
import { sanitizeInput } from "../agent/injection-defense.js";
import { createLogger } from "../observability/logger.js";
import {
  upsertBountyCandidate,
  getBountyCandidateByUrl,
  type BountyCandidateRow,
} from "../state/database.js";

const logger = createLogger("earning.bounty");

// ─── Tunables ───────────────────────────────────────────────────

/** Fraction of bounty value allowed as inference spend per attempt. */
export const BOUNTY_BUDGET_RATIO = 0.3;
/** Absolute cap on per-attempt inference budget (cents). */
export const BOUNTY_BUDGET_MAX_CENTS = 500;
/** Floor so tiny bounties still get a workable budget (cents). */
export const BOUNTY_BUDGET_MIN_CENTS = 50;

export interface BountyScanOptions {
  /** GitHub token (raises rate limits; optional). */
  githubToken?: string;
  /** GitHub search queries. Defaults to the Algora bounty label. */
  queries?: string[];
  /** Reject bounties below this amount (USD). */
  minAmountUsd?: number;
  /** Reject repos with fewer stars (honeypot filter). */
  minStars?: number;
  /** Reject repos younger than this (days; honeypot filter). */
  minRepoAgeDays?: number;
  /** Reject issues with more raw comments than this (used only when /attempt count is unknown). */
  maxComments?: number;
  /** Reject bounties with more distinct /attempt claims than this (real competition). */
  maxCompetitors?: number;
  /** Languages Galvin can realistically deliver in. */
  preferredLanguages?: string[];
  /** Cap on repo metadata lookups per scan (rate-limit guard). */
  maxRepoLookups?: number;
  /** Cap on Algora comment lookups per scan (rate-limit guard). */
  maxAlgoraLookups?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULTS = {
  queries: ['label:"💎 Bounty" is:issue is:open'],
  minAmountUsd: 50,
  minStars: 50,
  minRepoAgeDays: 30,
  maxComments: 15,
  maxCompetitors: 4,
  preferredLanguages: ["TypeScript", "JavaScript", "Python", "Go", "Rust"],
  maxRepoLookups: 20,
  maxAlgoraLookups: 20,
} as const;

/** Score at or above which a candidate is worth waking the agent for. */
export const BOUNTY_QUEUE_THRESHOLD = 60;

// ─── GitHub response shapes (minimal) ──────────────────────────

export interface GitHubIssue {
  html_url: string;
  repository_url: string; // https://api.github.com/repos/{owner}/{name}
  number: number;
  title: string;
  body?: string | null;
  state: string;
  comments: number;
  updated_at: string;
  labels: { name: string }[];
  pull_request?: unknown; // present when the "issue" is actually a PR
}

export interface GitHubRepoMeta {
  full_name: string;
  stargazers_count: number;
  created_at: string;
  archived: boolean;
  language: string | null;
  description: string | null;
}

// ─── Amount parsing ─────────────────────────────────────────────

const AMOUNT_RE = /\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*([kK])?/g;

/**
 * Extract the bounty amount in USD from labels (preferred) or the title.
 * Algora uses a dedicated amount label: "$700", "$1k", "$1,500".
 * Returns the largest amount found, or null if none parse.
 */
export function parseBountyAmount(
  labels: string[],
  title = "",
): number | null {
  let best: number | null = null;
  for (const text of [...labels, title]) {
    for (const m of text.matchAll(AMOUNT_RE)) {
      const base = Number(m[1]!.replace(/,/g, ""));
      if (!Number.isFinite(base)) continue;
      const amount = m[2] ? base * 1000 : base;
      if (amount > 0 && (best === null || amount > best)) best = amount;
    }
  }
  return best;
}

// ─── Scoring ────────────────────────────────────────────────────

export interface BountyScore {
  /** 0–100; meaningful only when eligible. */
  score: number;
  /** Hard filters all passed. */
  eligible: boolean;
  reasons: string[];
}

const BAIT_PATTERN =
  /honeypot|playground|free[- _]?money|easy[- _]?bounty|ai[- _]?agent[- _]?(friendly|welcome|playground)|agent[- _]?bait/i;

/**
 * Repo-only reputation gate (no amount needed). Returns a rejection reason,
 * or null if the repo clears the honeypot/quality filters. Used to decide
 * whether an amount-less issue is worth an extra Algora comment lookup.
 */
export function repoReputationReject(
  repo: GitHubRepoMeta,
  opts: BountyScanOptions = {},
): string | null {
  const minStars = opts.minStars ?? DEFAULTS.minStars;
  const minRepoAgeDays = opts.minRepoAgeDays ?? DEFAULTS.minRepoAgeDays;
  if (repo.archived) return "repo is archived";
  if (repo.stargazers_count < minStars) {
    return `repo has ${repo.stargazers_count} stars (< ${minStars}, honeypot filter)`;
  }
  const repoAgeDays = (Date.now() - Date.parse(repo.created_at)) / 86_400_000;
  if (repoAgeDays < minRepoAgeDays) {
    return `repo is ${Math.floor(repoAgeDays)}d old (< ${minRepoAgeDays}d, honeypot filter)`;
  }
  if (BAIT_PATTERN.test(`${repo.full_name} ${repo.description ?? ""}`)) {
    return "bait pattern in repo name/description";
  }
  return null;
}

// ─── Algora bounty amount resolution ────────────────────────────
//
// Most real Algora bounties (onyx, highlight, outerbase, tscircuit, …) do NOT
// put the dollar amount in a GitHub label. The canonical amount lives in a
// comment posted by the "algora-pbc[bot]" account, formatted as:
//   ## 💎 $250 bounty [• Org Name](https://algora.io/org)
// It is triggered by a maintainer comment like "/bounty 250" or "/bounty $250".

const ALGORA_BOT = "algora-pbc[bot]";
const ALGORA_AMOUNT_RE = /💎\s*\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k)?\s*bounty/i;
const BOUNTY_COMMAND_RE = /\/bounty\s+\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k)?/i;
// "/attempt #123" is Algora's "I'm working on this" signal — the real
// competition count. Bots (algora/linear/greptile) don't post it.
const ATTEMPT_COMMAND_RE = /\/attempt\b/i;

interface GitHubComment {
  user?: { login?: string };
  body?: string | null;
}

export interface AlgoraBountyInfo {
  amountUsd: number | null;
  /** Distinct non-bot users who posted /attempt — actual competitors racing us. */
  competitors: number;
}

/**
 * Extract the bounty amount (USD) from issue comments. Prefers the
 * algora-pbc[bot] "💎 $N bounty" comment; falls back to a maintainer
 * "/bounty N" command. Returns the largest amount found, or null.
 * Pure function — fed real comments by fetchAlgoraBountyAmount, or by tests.
 */
export function parseAlgoraBountyAmount(comments: GitHubComment[]): number | null {
  let best: number | null = null;
  const consider = (raw: string | undefined, k: string | undefined) => {
    if (raw == null) return;
    const base = Number(raw.replace(/,/g, ""));
    if (!Number.isFinite(base)) return;
    const amount = k ? base * 1000 : base;
    if (amount > 0 && (best === null || amount > best)) best = amount;
  };
  for (const c of comments) {
    const body = c.body ?? "";
    if ((c.user?.login ?? "").toLowerCase() === ALGORA_BOT) {
      const m = body.match(ALGORA_AMOUNT_RE);
      if (m) consider(m[1], m[2]);
    }
    const cmd = body.match(BOUNTY_COMMAND_RE);
    if (cmd) consider(cmd[1], cmd[2]);
  }
  return best;
}

/**
 * Count distinct non-bot users who posted "/attempt" — Algora's canonical
 * "I'm working on this" claim. This is the real competition signal, far more
 * reliable than raw comment count (which bot integrations inflate).
 */
export function parseAlgoraCompetitors(comments: GitHubComment[]): number {
  const attempters = new Set<string>();
  for (const c of comments) {
    const login = (c.user?.login ?? "").toLowerCase();
    if (!login || login.endsWith("[bot]")) continue;
    if (ATTEMPT_COMMAND_RE.test(c.body ?? "")) attempters.add(login);
  }
  return attempters.size;
}

/** Parse both amount and competitor count from one set of comments. */
export function parseAlgoraBounty(comments: GitHubComment[]): AlgoraBountyInfo {
  return {
    amountUsd: parseAlgoraBountyAmount(comments),
    competitors: parseAlgoraCompetitors(comments),
  };
}

/**
 * Score a bounty candidate. Hard filters (any one → ineligible):
 * archived repo, low stars, young repo, bait-pattern repo name/description
 * or label, missing/too-small amount, implausible amount vs repo size,
 * too much competition. Soft scoring rewards amount, language match,
 * stars, and freshness.
 */
export function scoreBounty(
  issue: GitHubIssue,
  repo: GitHubRepoMeta,
  opts: BountyScanOptions = {},
  resolvedAmountUsd?: number | null,
  competitors?: number | null,
): BountyScore {
  const minAmountUsd = opts.minAmountUsd ?? DEFAULTS.minAmountUsd;
  const minStars = opts.minStars ?? DEFAULTS.minStars;
  const minRepoAgeDays = opts.minRepoAgeDays ?? DEFAULTS.minRepoAgeDays;
  const maxComments = opts.maxComments ?? DEFAULTS.maxComments;
  const maxCompetitors = opts.maxCompetitors ?? DEFAULTS.maxCompetitors;
  const languages = opts.preferredLanguages ?? [...DEFAULTS.preferredLanguages];

  const reasons: string[] = [];
  const labelNames = issue.labels.map((l) => l.name);
  // Prefer an externally resolved amount (e.g. from the Algora bounty comment),
  // falling back to label/title parsing.
  const amount =
    resolvedAmountUsd != null
      ? resolvedAmountUsd
      : parseBountyAmount(labelNames, issue.title);

  // Hard filters
  if (issue.pull_request) {
    return { score: 0, eligible: false, reasons: ["is a pull request, not an issue"] };
  }
  if (repo.archived) {
    return { score: 0, eligible: false, reasons: ["repo is archived"] };
  }
  if (repo.stargazers_count < minStars) {
    return {
      score: 0,
      eligible: false,
      reasons: [`repo has ${repo.stargazers_count} stars (< ${minStars}, honeypot filter)`],
    };
  }
  const repoAgeDays =
    (Date.now() - Date.parse(repo.created_at)) / 86_400_000;
  if (repoAgeDays < minRepoAgeDays) {
    return {
      score: 0,
      eligible: false,
      reasons: [`repo is ${Math.floor(repoAgeDays)}d old (< ${minRepoAgeDays}d, honeypot filter)`],
    };
  }
  const baitText = `${repo.full_name} ${repo.description ?? ""} ${labelNames.join(" ")}`;
  if (BAIT_PATTERN.test(baitText)) {
    return { score: 0, eligible: false, reasons: ["bait pattern in repo name/description/labels"] };
  }
  if (amount === null) {
    return { score: 0, eligible: false, reasons: ["no parseable bounty amount"] };
  }
  if (amount < minAmountUsd) {
    return { score: 0, eligible: false, reasons: [`amount $${amount} below minimum $${minAmountUsd}`] };
  }
  // $10k bounty on a 200-star repo is bait, not generosity
  if (amount > 5000 && repo.stargazers_count < 1000) {
    return { score: 0, eligible: false, reasons: ["implausible amount for repo size (honeypot filter)"] };
  }
  // Competition: prefer the real signal (distinct /attempt claims) when we have
  // it; raw comment count is unreliable on Algora issues because bots
  // (algora-pbc, linear, greptile) and /claim posts inflate it. Only the
  // /attempt count reflects how many hunters are actually racing us.
  if (competitors != null) {
    if (competitors > maxCompetitors) {
      return {
        score: 0,
        eligible: false,
        reasons: [`${competitors} active attempts (> ${maxCompetitors}, swarmed)`],
      };
    }
  } else if (issue.comments > maxComments) {
    // No /attempt data (e.g. label-only bounty we didn't fetch comments for).
    return {
      score: 0,
      eligible: false,
      reasons: [`${issue.comments} comments (> ${maxComments}, heavy competition)`],
    };
  }

  // Soft scoring (max 100)
  let score = 0;

  // Amount: log scale, $50→~13, $200→~26, $1k→~40 (cap 40)
  const amountPts = Math.min(40, Math.round(13 * Math.log10(amount / 5)));
  score += amountPts;
  reasons.push(`amount $${amount} (+${amountPts})`);

  // Language match (+20)
  if (repo.language && languages.includes(repo.language)) {
    score += 20;
    reasons.push(`language ${repo.language} (+20)`);
  } else {
    reasons.push(`language ${repo.language ?? "unknown"} (no match)`);
  }

  // Stars: log scale, 50→~8, 1k→~15, 10k→20 (cap 20)
  const starPts = Math.min(20, Math.round(5 * Math.log10(repo.stargazers_count)));
  score += starPts;
  reasons.push(`${repo.stargazers_count} stars (+${starPts})`);

  // Freshness: updated within 30 days (+10)
  if (Date.now() - Date.parse(issue.updated_at) < 30 * 86_400_000) {
    score += 10;
    reasons.push("active within 30d (+10)");
  }

  // Competition (max +10 / scaling penalty). Uses /attempt count when known.
  if (competitors != null) {
    if (competitors === 0) {
      score += 10;
      reasons.push("no active attempts (+10)");
    } else if (competitors <= 2) {
      reasons.push(`${competitors} active attempt(s) (neutral)`);
    } else {
      const penalty = (competitors - 2) * 5;
      score -= penalty;
      reasons.push(`${competitors} active attempts (-${penalty})`);
    }
  } else if (issue.comments <= 5) {
    score += 10;
    reasons.push(`${issue.comments} comments (+10)`);
  }

  return { score: Math.max(0, Math.min(100, score)), eligible: true, reasons };
}

/** Inference budget for one bounty attempt, in cents. */
export function computeAttemptBudgetCents(amountUsd: number): number {
  const cents = Math.round(amountUsd * 100 * BOUNTY_BUDGET_RATIO);
  return Math.max(
    BOUNTY_BUDGET_MIN_CENTS,
    Math.min(BOUNTY_BUDGET_MAX_CENTS, cents),
  );
}

// ─── Scanning ───────────────────────────────────────────────────

function ghHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "galvin-agent",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Run the configured search queries and return deduped open issues.
 * Network failures degrade to an empty list — the heartbeat retries later.
 */
export async function scanGitHubBounties(
  opts: BountyScanOptions = {},
): Promise<GitHubIssue[]> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const queries = opts.queries ?? [...DEFAULTS.queries];
  const seen = new Set<string>();
  const issues: GitHubIssue[] = [];

  for (const query of queries) {
    const url =
      "https://api.github.com/search/issues?q=" +
      encodeURIComponent(query) +
      "&sort=updated&order=desc&per_page=50";
    try {
      const res = await fetchFn(url, { headers: ghHeaders(opts.githubToken) });
      if (!res.ok) {
        logger.warn(`bounty search HTTP ${res.status} for query: ${query}`);
        continue;
      }
      const data = (await res.json()) as { items?: GitHubIssue[] };
      for (const item of data.items ?? []) {
        if (item.state !== "open" || item.pull_request) continue;
        if (seen.has(item.html_url)) continue;
        seen.add(item.html_url);
        issues.push(item);
      }
    } catch (err: any) {
      logger.warn(`bounty search failed: ${err?.message}`);
    }
  }
  return issues;
}

/** owner/name from a repository_url like https://api.github.com/repos/owner/name */
export function repoFullNameFromUrl(repositoryUrl: string): string | null {
  const m = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)\/?$/);
  return m ? m[1]! : null;
}

export async function fetchRepoMeta(
  fullName: string,
  opts: BountyScanOptions,
): Promise<GitHubRepoMeta | null> {
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(`https://api.github.com/repos/${fullName}`, {
      headers: ghHeaders(opts.githubToken),
    });
    if (!res.ok) return null;
    return (await res.json()) as GitHubRepoMeta;
  } catch {
    return null;
  }
}

/**
 * Fetch an issue's comments and resolve the Algora bounty amount + competitor
 * count. One extra GET; only call this for issues whose repo already passed
 * reputation, to bound rate-limit cost. Returns nulls on any failure.
 */
export async function fetchAlgoraBountyInfo(
  fullName: string,
  issueNumber: number,
  opts: BountyScanOptions = {},
): Promise<AlgoraBountyInfo> {
  const fetchFn = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchFn(
      `https://api.github.com/repos/${fullName}/issues/${issueNumber}/comments?per_page=100`,
      { headers: ghHeaders(opts.githubToken) },
    );
    if (!res.ok) return { amountUsd: null, competitors: 0 };
    const comments = (await res.json()) as GitHubComment[];
    return parseAlgoraBounty(Array.isArray(comments) ? comments : []);
  } catch {
    return { amountUsd: null, competitors: 0 };
  }
}

/** Back-compat thin wrapper: just the amount. */
export async function fetchAlgoraBountyAmount(
  fullName: string,
  issueNumber: number,
  opts: BountyScanOptions = {},
): Promise<number | null> {
  return (await fetchAlgoraBountyInfo(fullName, issueNumber, opts)).amountUsd;
}

export interface BountyScanResult {
  scanned: number;
  eligible: number;
  /** Newly discovered eligible candidates (status 'found'), best first. */
  newCandidates: BountyCandidateRow[];
}

/**
 * Full pipeline: search → repo reputation → score → sanitize → persist.
 * Only eligible candidates are stored. Already-known URLs are refreshed
 * (score/amount) but not returned as new.
 */
export async function runBountyScan(
  db: BetterSqlite3.Database,
  opts: BountyScanOptions = {},
): Promise<BountyScanResult> {
  const maxRepoLookups = opts.maxRepoLookups ?? DEFAULTS.maxRepoLookups;
  const maxAlgoraLookups = opts.maxAlgoraLookups ?? DEFAULTS.maxAlgoraLookups;
  const issues = await scanGitHubBounties(opts);

  const repoCache = new Map<string, GitHubRepoMeta | null>();
  const newCandidates: BountyCandidateRow[] = [];
  let eligible = 0;
  let algoraLookups = 0;

  for (const issue of issues) {
    const fullName = repoFullNameFromUrl(issue.repository_url);
    if (!fullName) continue;

    if (!repoCache.has(fullName)) {
      if (repoCache.size >= maxRepoLookups) continue; // rate-limit guard
      repoCache.set(fullName, await fetchRepoMeta(fullName, opts));
    }
    const repo = repoCache.get(fullName);
    if (!repo) continue;

    // Resolve amount + competition: labels/title first, then (for reputable
    // repos only) the Algora bounty comment — where most real amounts live,
    // and where /attempt claims reveal the true competition.
    let amount = parseBountyAmount(issue.labels.map((l) => l.name), issue.title);
    let competitors: number | null = null;
    if (
      amount === null &&
      algoraLookups < maxAlgoraLookups &&
      repoReputationReject(repo, opts) === null
    ) {
      algoraLookups++;
      const info = await fetchAlgoraBountyInfo(fullName, issue.number, opts);
      amount = info.amountUsd;
      if (amount !== null) competitors = info.competitors;
    }

    const result = scoreBounty(issue, repo, opts, amount, competitors);
    if (!result.eligible) continue;
    eligible++;

    // Issue titles are attacker-controlled text — sanitize before storage
    const sanitized = sanitizeInput(issue.title, fullName, "skill_instruction");
    if (sanitized.blocked) {
      logger.warn(`bounty title blocked by injection defense: ${issue.html_url}`);
      continue;
    }

    const resolvedAmount = amount!; // eligible implies a positive amount
    const existing = getBountyCandidateByUrl(db, issue.html_url);
    const row = upsertBountyCandidate(db, {
      url: issue.html_url,
      repo: fullName,
      issueNumber: issue.number,
      title: sanitized.content.slice(0, 300),
      amountUsd: resolvedAmount,
      score: result.score,
      scoreReasons: result.reasons,
      attemptBudgetCents: computeAttemptBudgetCents(resolvedAmount),
    });
    if (!existing) newCandidates.push(row);
  }

  newCandidates.sort((a, b) => b.score - a.score || b.amountUsd - a.amountUsd);
  logger.info(
    `bounty scan: ${issues.length} issues, ${eligible} eligible, ${newCandidates.length} new`,
  );
  return { scanned: issues.length, eligible, newCandidates };
}
