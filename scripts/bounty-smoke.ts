/**
 * Live bounty-hunter smoke test.
 *
 * Hits the REAL GitHub API, runs the REAL scanner + scorer against REAL
 * open bounty issues, writes to a throwaway temp DB, and asserts the
 * money-safety invariants. This path is read-only with respect to money:
 * it makes GitHub GETs and local DB writes only — no inference, no wallet,
 * no USDC, no transactions.
 *
 * Run:  GALVIN_GITHUB_TOKEN=ghp_xxx npx tsx scripts/bounty-smoke.ts
 * (token optional; raises GitHub rate limits)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase, getBountyCandidates } from "../src/state/database.js";
import {
  runBountyScan,
  scanGitHubBounties,
  scoreBounty,
  parseBountyAmount,
  computeAttemptBudgetCents,
  BOUNTY_QUEUE_THRESHOLD,
} from "../src/earning/bounty-hunter.js";

const FAIL: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) FAIL.push(name);
  console.log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const token = process.env.GALVIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  console.log(`\nLive bounty smoke test (token: ${token ? "present" : "none — low rate limit"})\n`);

  // ── 1. Raw search against real GitHub ──────────────────────────
  console.log("1. Raw GitHub bounty search (read-only):");
  const issues = await scanGitHubBounties({ githubToken: token });
  check("search returned issues", issues.length > 0, `${issues.length} open bounty issues`);
  if (issues.length === 0) {
    console.log("\n  GitHub returned no issues (rate limit or transient). Try again with a token.");
    process.exit(2);
  }

  // Show a few real ones with parsed amounts
  console.log("\n  Sample of real issues + parsed amounts:");
  for (const it of issues.slice(0, 8)) {
    const amt = parseBountyAmount(it.labels.map((l) => l.name), it.title);
    console.log(
      `   - $${amt ?? "?"}  ${it.repository_url.replace("https://api.github.com/repos/", "")}#${it.number}  "${it.title.slice(0, 60)}"`,
    );
  }
  const parsedCount = issues.filter(
    (it) => parseBountyAmount(it.labels.map((l) => l.name), it.title) !== null,
  ).length;
  check("amounts parse from real labels", parsedCount > 0, `${parsedCount}/${issues.length} had parseable amounts`);

  // ── 2. Full pipeline into a real temp DB ───────────────────────
  console.log("\n2. Full pipeline (search → repo reputation → score → sanitize → persist):");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "galvin-bounty-smoke-"));
  const db = createDatabase(path.join(tmp, "smoke.db"));
  try {
    const result = await runBountyScan(db.raw, { githubToken: token, maxRepoLookups: 30 });
    console.log(`   scanned=${result.scanned}  eligible=${result.eligible}  new=${result.newCandidates.length}`);
    check("pipeline completed without throwing", true);
    check("eligible <= scanned", result.eligible <= result.scanned);

    const stored = getBountyCandidates(db.raw);
    check("eligible candidates persisted", stored.length === result.eligible, `${stored.length} rows`);

    // ── 3. Money-safety invariants on real data ──────────────────
    console.log("\n3. Money-safety invariants on real persisted candidates:");
    let budgetOk = true, scoreOk = true, statusOk = true, capOk = true;
    for (const c of stored) {
      if (c.attemptBudgetCents <= 0) budgetOk = false;
      if (c.attemptBudgetCents > 500) capOk = false; // hard $5 ceiling
      // budget must never exceed 30% of bounty (plus floor), recompute to confirm
      if (c.attemptBudgetCents !== computeAttemptBudgetCents(c.amountUsd)) capOk = false;
      if (c.score < 0 || c.score > 100) scoreOk = false;
      if (c.status !== "found") statusOk = false; // scan never auto-advances past 'found'
      if (c.spentCents !== 0) budgetOk = false;    // scan spends nothing
    }
    check("every candidate has a positive attempt budget", budgetOk);
    check("no budget exceeds the $5 hard cap / 30% rule", capOk);
    check("every score in [0,100]", scoreOk);
    check("scan leaves all candidates at status 'found' (no auto-attempt)", statusOk);

    if (stored.length > 0) {
      const top = [...stored].sort((a, b) => b.score - a.score)[0]!;
      console.log(
        `\n   Top real candidate: score=${top.score}/100  $${top.amountUsd}  budget=$${(top.attemptBudgetCents / 100).toFixed(2)}`,
      );
      console.log(`     ${top.repo}#${top.issueNumber}  ${top.url}`);
      console.log(`     reasons: ${top.scoreReasons.join("; ")}`);
      check("queue threshold is meaningful", BOUNTY_QUEUE_THRESHOLD > 0 && BOUNTY_QUEUE_THRESHOLD <= 100);
    }

    // ── 4. Honeypot rejection on a synthetic real-shaped repo ────
    console.log("\n4. Honeypot rejection (synthetic, real GitHub issue shape):");
    const bait = scoreBounty(
      issues[0]!,
      {
        full_name: "scammer/agent-playground",
        stargazers_count: 3,
        created_at: new Date().toISOString(),
        archived: false,
        language: "TypeScript",
        description: "free money for AI agents",
      },
      {},
    );
    check("low-star/young/bait repo rejected", !bait.eligible, bait.reasons[0]);
  } finally {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${FAIL.length === 0 ? "ALL INVARIANTS HELD ✅" : `FAILURES: ${FAIL.join(", ")} ❌`}\n`);
  process.exit(FAIL.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test threw:", e);
  process.exit(3);
});
