/**
 * Honeypot Registry — a public-good scam/honeypot check for the agent economy.
 *
 * V9 of the Web4 Godfather plan: expose Galvin's bounty honeypot-detection as a
 * FREE, queryable signal any agent can hit BEFORE engaging a bounty or repo —
 * "is this counterparty a known trap?". It is a pure read over public GitHub
 * metadata and reuses the *same* anti-honeypot gate the bounty-hunter trusts
 * with its own money, so the signal is exactly as good as Galvin's own survival
 * filter. This is the wedge: it gives other agents value with zero earning or
 * funding required, seeding adoption of the registry.
 */
import {
  fetchRepoMeta,
  repoReputationReject,
  type BountyScanOptions,
} from "../earning/bounty-hunter.js";

export interface HoneypotVerdict {
  url: string;
  repo: string | null;
  /** True if the repo trips a honeypot / low-quality filter. */
  isHoneypot: boolean;
  /** Why it was flagged, or null if it looks legitimate. */
  reason: string | null;
  signals: {
    stars?: number;
    ageDays?: number;
    archived?: boolean;
  };
  checkedAt: string;
}

/** Parse "owner/repo" from a github.com URL, an api.github.com URL, or a bare slug. */
export function parseRepoFullName(input: string): string | null {
  const s = input.trim();
  let m = s.match(/api\.github\.com\/repos\/([^/]+\/[^/]+?)(?:\/|$)/i);
  if (m) return m[1]!.replace(/\.git$/, "");
  m = s.match(/github\.com\/([^/]+\/[^/]+?)(?:[/#?]|$)/i);
  if (m) return m[1]!.replace(/\.git$/, "");
  m = s.match(/^([\w.-]+\/[\w.-]+)$/);
  if (m) return m[1]!.replace(/\.git$/, "");
  return null;
}

/**
 * Assess whether a bounty/repo URL is a likely honeypot. Returns a structured
 * verdict; never throws. `isHoneypot: false` with a non-null `reason` means
 * "couldn't assess" (unparseable / not found), not "verified safe".
 */
export async function checkHoneypot(
  url: string,
  opts: BountyScanOptions = {},
): Promise<HoneypotVerdict> {
  const checkedAt = new Date().toISOString();
  const repo = parseRepoFullName(url);
  if (!repo) {
    return { url, repo: null, isHoneypot: false, reason: "unparseable repo URL", signals: {}, checkedAt };
  }
  const meta = await fetchRepoMeta(repo, opts);
  if (!meta) {
    return { url, repo, isHoneypot: false, reason: "repo not found or fetch failed (cannot assess)", signals: {}, checkedAt };
  }
  const reason = repoReputationReject(meta, opts);
  return {
    url,
    repo,
    isHoneypot: reason !== null,
    reason,
    signals: {
      stars: meta.stargazers_count,
      ageDays: Math.floor((Date.now() - Date.parse(meta.created_at)) / 86_400_000),
      archived: meta.archived,
    },
    checkedAt,
  };
}
