/**
 * Bounty rejection diagnostic — read-only.
 *
 * For every real GitHub bounty issue, fetch its repo metadata and print the
 * scoring verdict + reason. Tells us whether the ~98% rejection rate is
 * "correctly rejecting honeypots" (good) or "wrongly rejecting real money"
 * (false negatives to fix). No DB, no money, GitHub GETs only.
 *
 * Run: GALVIN_GITHUB_TOKEN=... npx tsx scripts/bounty-diagnose.ts
 */

import {
  scanGitHubBounties,
  scoreBounty,
  parseBountyAmount,
  repoFullNameFromUrl,
  repoReputationReject,
  fetchAlgoraBountyInfo,
  type GitHubRepoMeta,
} from "../src/earning/bounty-hunter.js";

async function repoMeta(fullName: string, token?: string): Promise<GitHubRepoMeta | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "galvin-diagnose",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (!res.ok) return null;
  return (await res.json()) as GitHubRepoMeta;
}

async function main() {
  const token = process.env.GALVIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const issues = await scanGitHubBounties({ githubToken: token });
  console.log(`\n${issues.length} real bounty issues. Per-issue verdict:\n`);

  const buckets: Record<string, number> = {};
  const cache = new Map<string, GitHubRepoMeta | null>();

  for (const it of issues) {
    const fullName = repoFullNameFromUrl(it.repository_url);
    if (!fullName) { buckets["bad repo url"] = (buckets["bad repo url"] || 0) + 1; continue; }
    if (!cache.has(fullName)) cache.set(fullName, await repoMeta(fullName, token));
    const repo = cache.get(fullName);
    if (!repo) { buckets["repo lookup failed"] = (buckets["repo lookup failed"] || 0) + 1; continue; }

    let amt = parseBountyAmount(it.labels.map((l) => l.name), it.title);
    let competitors: number | null = null;
    let via = "label";
    if (amt === null && repoReputationReject(repo, {}) === null) {
      const info = await fetchAlgoraBountyInfo(fullName, it.number, { githubToken: token });
      amt = info.amountUsd;
      if (amt !== null) { via = "algora"; competitors = info.competitors; }
    }
    const v = scoreBounty(it, repo, {}, amt, competitors);
    const reasonKey = v.eligible ? "ELIGIBLE" : v.reasons[0]!.replace(/\d+/g, "N");
    buckets[reasonKey] = (buckets[reasonKey] || 0) + 1;

    const compStr = competitors != null ? ` ${competitors}🏃` : "";
    const verdict = v.eligible
      ? `ELIGIBLE score=${v.score} (via ${via}${compStr})`
      : `reject: ${v.reasons[0]}${compStr}`;
    console.log(
      `  $${String(amt ?? "?").padStart(5)} ★${String(repo.stargazers_count).padStart(6)} ${(repo.language ?? "-").padEnd(12)} ${fullName}#${it.number}\n        → ${verdict}`,
    );
  }

  console.log("\n── Rejection breakdown ──");
  for (const [k, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)} × ${k}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
