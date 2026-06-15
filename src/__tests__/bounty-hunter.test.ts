/**
 * Bounty Hunter Tests
 *
 * Tests: amount-label parsing, scoring hard filters (anti-honeypot),
 * soft scoring, attempt budget computation, GitHub scan with injected
 * fetch, full scan pipeline persistence, and bounty lifecycle DB helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

vi.mock("../agent/injection-defense.js", () => ({
  sanitizeToolResult: vi.fn((s: string) => s),
  sanitizeInput: vi.fn((s: string) => ({
    content: s,
    blocked: false,
    threatLevel: "none",
    checks: [],
  })),
}));

const {
  parseBountyAmount,
  parseAlgoraBountyAmount,
  parseAlgoraCompetitors,
  scoreBounty,
  repoReputationReject,
  computeAttemptBudgetCents,
  scanGitHubBounties,
  runBountyScan,
  repoFullNameFromUrl,
  BOUNTY_BUDGET_MAX_CENTS,
  BOUNTY_BUDGET_MIN_CENTS,
} = await import("../earning/bounty-hunter.js");
type GitHubIssue = import("../earning/bounty-hunter.js").GitHubIssue;
type GitHubRepoMeta = import("../earning/bounty-hunter.js").GitHubRepoMeta;

const {
  createDatabase,
  getBountyCandidates,
  getBountyCandidateById,
  getBountyCandidateByUrl,
  upsertBountyCandidate,
  updateBountyCandidateStatus,
  addBountyCandidateSpend,
} = await import("../state/database.js");

const { sanitizeInput } = await import("../agent/injection-defense.js");

// ─── Fixtures ───────────────────────────────────────────────────

function issue(over: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    html_url: "https://github.com/good/repo/issues/1",
    repository_url: "https://api.github.com/repos/good/repo",
    number: 1,
    title: "Fix memory leak in worker pool",
    state: "open",
    comments: 2,
    updated_at: new Date().toISOString(),
    labels: [{ name: "💎 Bounty" }, { name: "$500" }],
    ...over,
  };
}

function repoMeta(over: Partial<GitHubRepoMeta> = {}): GitHubRepoMeta {
  return {
    full_name: "good/repo",
    stargazers_count: 2000,
    created_at: "2020-01-01T00:00:00Z",
    archived: false,
    language: "TypeScript",
    description: "A real project",
    ...over,
  };
}

function mockFetch(routes: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    for (const [key, value] of Object.entries(routes)) {
      if (u.includes(key)) {
        return { ok: true, status: 200, json: async () => value };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

// ─── Amount Parsing ─────────────────────────────────────────────

describe("parseBountyAmount", () => {
  it("parses plain dollar labels", () => {
    expect(parseBountyAmount(["$700"])).toBe(700);
  });

  it("parses k-suffixed labels", () => {
    expect(parseBountyAmount(["$1k"])).toBe(1000);
    expect(parseBountyAmount(["$1.5k"])).toBe(1500);
  });

  it("parses comma-grouped amounts", () => {
    expect(parseBountyAmount(["$1,500"])).toBe(1500);
  });

  it("falls back to the title", () => {
    expect(parseBountyAmount(["💎 Bounty"], "Fix crash ($250 bounty)")).toBe(250);
  });

  it("returns the largest amount found", () => {
    expect(parseBountyAmount(["$100", "$1k"], "also $50")).toBe(1000);
  });

  it("returns null when nothing parses", () => {
    expect(parseBountyAmount(["💎 Bounty", "bug"], "Fix crash")).toBeNull();
  });
});

// ─── Algora comment amount parsing ──────────────────────────────

describe("parseAlgoraBountyAmount", () => {
  it("reads the algora-pbc[bot] bounty comment", () => {
    const comments = [
      { user: { login: "Weves" }, body: "thanks for filing" },
      {
        user: { login: "algora-pbc[bot]" },
        body: "## 💎 $250 bounty [• Onyx (YC W24)](https://algora.io/onyx-dot-app)\n### Steps to solve:",
      },
    ];
    expect(parseAlgoraBountyAmount(comments)).toBe(250);
  });

  it("reads a maintainer /bounty command", () => {
    expect(parseAlgoraBountyAmount([{ user: { login: "Brayden" }, body: "/bounty $500" }])).toBe(500);
    expect(parseAlgoraBountyAmount([{ user: { login: "maint" }, body: "/bounty 250" }])).toBe(250);
  });

  it("handles k-suffixed bot amounts", () => {
    expect(
      parseAlgoraBountyAmount([
        { user: { login: "algora-pbc[bot]" }, body: "## 💎 $1k bounty [• Org](https://algora.io/x)" },
      ]),
    ).toBe(1000);
  });

  it("ignores non-bounty bot chatter", () => {
    expect(
      parseAlgoraBountyAmount([
        { user: { login: "linear[bot]" }, body: "linked HIG-4687" },
        { user: { login: "greptile-apps[bot]" }, body: "to fix, edit file.tsx" },
      ]),
    ).toBeNull();
  });

  it("returns the largest when multiple amounts appear", () => {
    expect(
      parseAlgoraBountyAmount([
        { user: { login: "m" }, body: "/bounty 100" },
        { user: { login: "algora-pbc[bot]" }, body: "## 💎 $300 bounty [• Org](x)" },
      ]),
    ).toBe(300);
  });
});

describe("repoReputationReject", () => {
  it("passes a reputable repo", () => {
    expect(repoReputationReject(repoMeta())).toBeNull();
  });
  it("rejects archived / low-star / young / bait repos", () => {
    expect(repoReputationReject(repoMeta({ archived: true }))).toMatch(/archived/);
    expect(repoReputationReject(repoMeta({ stargazers_count: 3 }))).toMatch(/stars/);
    expect(repoReputationReject(repoMeta({ created_at: new Date().toISOString() }))).toMatch(/old/);
    expect(repoReputationReject(repoMeta({ full_name: "x/agent-playground" }))).toMatch(/bait/);
  });
});

describe("scoreBounty with resolved amount", () => {
  it("uses an externally resolved amount over labels", () => {
    const noLabel = issue({ labels: [{ name: "💎 Bounty" }], title: "Fix bug" });
    const rejected = scoreBounty(noLabel, repoMeta());
    expect(rejected.eligible).toBe(false); // no label amount
    const accepted = scoreBounty(noLabel, repoMeta(), {}, 250);
    expect(accepted.eligible).toBe(true);
    expect(accepted.reasons.join(" ")).toMatch(/\$250/);
  });
});

describe("parseAlgoraCompetitors", () => {
  it("counts distinct non-bot /attempt authors", () => {
    const comments = [
      { user: { login: "alice" }, body: "/attempt #59 I'll take this" },
      { user: { login: "bob" }, body: "/attempt #59" },
      { user: { login: "alice" }, body: "/attempt #59 still working" }, // dupe
      { user: { login: "algora-pbc[bot]" }, body: "/attempt detected" }, // bot ignored
      { user: { login: "carol" }, body: "looks interesting" }, // no /attempt
    ];
    expect(parseAlgoraCompetitors(comments)).toBe(2);
  });
  it("returns 0 when nobody has attempted", () => {
    expect(parseAlgoraCompetitors([{ user: { login: "x" }, body: "nice" }])).toBe(0);
  });
});

describe("scoreBounty competition (real /attempt signal)", () => {
  it("ignores inflated raw comment count when competitor count is known", () => {
    // onyx-shaped: 121 raw comments (bots), but only 1 real attempt
    const r = scoreBounty(issue({ comments: 121 }), repoMeta({ stargazers_count: 30000 }), {}, 250, 1);
    expect(r.eligible).toBe(true);
  });
  it("rejects genuinely swarmed bounties (many /attempt claims)", () => {
    const r = scoreBounty(issue({ comments: 121 }), repoMeta(), {}, 250, 9);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/swarmed/);
  });
  it("bonuses an uncontested bounty and penalizes a contested one", () => {
    const fresh = scoreBounty(issue({ comments: 80 }), repoMeta(), {}, 250, 0);
    const contested = scoreBounty(issue({ comments: 80 }), repoMeta(), {}, 250, 4);
    expect(fresh.eligible && contested.eligible).toBe(true);
    expect(fresh.score).toBeGreaterThan(contested.score);
  });
  it("falls back to raw comment filter only when competitor count is unknown", () => {
    const r = scoreBounty(issue({ comments: 40 }), repoMeta(), {}, 250 /* no competitors */);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/comments/);
  });
});

// ─── Scoring: hard filters ──────────────────────────────────────

describe("scoreBounty hard filters", () => {
  it("rejects archived repos", () => {
    const r = scoreBounty(issue(), repoMeta({ archived: true }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/archived/);
  });

  it("rejects low-star repos (honeypot filter)", () => {
    const r = scoreBounty(issue(), repoMeta({ stargazers_count: 5 }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/stars/);
  });

  it("rejects young repos (honeypot filter)", () => {
    const r = scoreBounty(issue(), repoMeta({ created_at: new Date().toISOString() }));
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/old/);
  });

  it("rejects bait-pattern repo names", () => {
    const r = scoreBounty(
      issue({ repository_url: "https://api.github.com/repos/bait/agent-playground" }),
      repoMeta({ full_name: "bait/agent-playground" }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/bait pattern/);
  });

  it("rejects bait labels like 'AI agent friendly'", () => {
    const r = scoreBounty(
      issue({ labels: [{ name: "💎 Bounty" }, { name: "$500" }, { name: "AI agent friendly" }] }),
      repoMeta(),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/bait pattern/);
  });

  it("rejects missing amounts", () => {
    const r = scoreBounty(issue({ labels: [{ name: "💎 Bounty" }], title: "Fix bug" }), repoMeta());
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/no parseable/);
  });

  it("rejects amounts below the minimum", () => {
    const r = scoreBounty(issue({ labels: [{ name: "$10" }] }), repoMeta());
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/below minimum/);
  });

  it("rejects implausible amounts on small repos (honeypot filter)", () => {
    const r = scoreBounty(
      issue({ labels: [{ name: "$10k" }] }),
      repoMeta({ stargazers_count: 200 }),
    );
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/implausible/);
  });

  it("rejects heavy-competition issues", () => {
    const r = scoreBounty(issue({ comments: 40 }), repoMeta());
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatch(/competition/);
  });

  it("rejects pull requests", () => {
    const r = scoreBounty(issue({ pull_request: {} }), repoMeta());
    expect(r.eligible).toBe(false);
  });
});

// ─── Scoring: soft signals ──────────────────────────────────────

describe("scoreBounty soft scoring", () => {
  it("accepts a good candidate with a meaningful score", () => {
    const r = scoreBounty(issue(), repoMeta());
    expect(r.eligible).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(60);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it("scores language matches higher", () => {
    const matched = scoreBounty(issue(), repoMeta({ language: "TypeScript" }));
    const unmatched = scoreBounty(issue(), repoMeta({ language: "COBOL" }));
    expect(matched.score).toBe(unmatched.score + 20);
  });

  it("scores bigger bounties higher", () => {
    const big = scoreBounty(issue({ labels: [{ name: "$2k" }] }), repoMeta());
    const small = scoreBounty(issue({ labels: [{ name: "$60" }] }), repoMeta());
    expect(big.score).toBeGreaterThan(small.score);
  });
});

// ─── Budget ─────────────────────────────────────────────────────

describe("computeAttemptBudgetCents", () => {
  it("allots 30% of the bounty", () => {
    expect(computeAttemptBudgetCents(10)).toBe(300);
  });

  it("caps at the maximum", () => {
    expect(computeAttemptBudgetCents(1000)).toBe(BOUNTY_BUDGET_MAX_CENTS);
  });

  it("floors tiny bounties", () => {
    expect(computeAttemptBudgetCents(1)).toBe(BOUNTY_BUDGET_MIN_CENTS);
  });
});

// ─── Scan (mocked GitHub) ───────────────────────────────────────

describe("scanGitHubBounties", () => {
  it("filters PRs and closed issues, dedupes by URL", async () => {
    const fetchImpl = mockFetch({
      "search/issues": {
        items: [
          issue(),
          issue(), // duplicate URL
          issue({ html_url: "https://github.com/x/y/pull/2", pull_request: {} }),
          issue({ html_url: "https://github.com/x/y/issues/3", state: "closed" }),
        ],
      },
    });
    const found = await scanGitHubBounties({ fetchImpl });
    expect(found).toHaveLength(1);
    expect(found[0]!.html_url).toBe("https://github.com/good/repo/issues/1");
  });

  it("degrades to empty on HTTP errors", async () => {
    const found = await scanGitHubBounties({ fetchImpl: mockFetch({}) });
    expect(found).toEqual([]);
  });
});

describe("repoFullNameFromUrl", () => {
  it("extracts owner/name", () => {
    expect(repoFullNameFromUrl("https://api.github.com/repos/good/repo")).toBe("good/repo");
    expect(repoFullNameFromUrl("garbage")).toBeNull();
  });
});

// ─── Full pipeline + DB lifecycle ───────────────────────────────

describe("bounty pipeline and lifecycle", () => {
  let tmpDir: string;
  let db: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "galvin-bounty-test-"));
    db = createDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists eligible candidates and skips honeypots", async () => {
    const fetchImpl = mockFetch({
      "search/issues": {
        items: [
          issue(),
          issue({
            html_url: "https://github.com/bait/agent-playground/issues/9",
            repository_url: "https://api.github.com/repos/bait/agent-playground",
            number: 9,
          }),
        ],
      },
      "repos/good/repo": repoMeta(),
      "repos/bait/agent-playground": repoMeta({ full_name: "bait/agent-playground" }),
    });

    const result = await runBountyScan(db.raw, { fetchImpl });
    expect(result.scanned).toBe(2);
    expect(result.eligible).toBe(1);
    expect(result.newCandidates).toHaveLength(1);

    const stored = getBountyCandidates(db.raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.repo).toBe("good/repo");
    expect(stored[0]!.amountUsd).toBe(500);
    expect(stored[0]!.status).toBe("found");
    expect(stored[0]!.attemptBudgetCents).toBe(BOUNTY_BUDGET_MAX_CENTS);
  });

  it("recovers an amountless issue via the Algora bounty comment", async () => {
    const noLabel = issue({
      html_url: "https://github.com/good/repo/issues/42",
      number: 42,
      labels: [{ name: "💎 Bounty" }], // no $ label
      title: "Add Jira connector",
    });
    const fetchImpl = mockFetch({
      "search/issues": { items: [noLabel] },
      "repos/good/repo/issues/42/comments": [
        { user: { login: "maintainer" }, body: "/bounty 250" },
        { user: { login: "algora-pbc[bot]" }, body: "## 💎 $250 bounty [• Good](https://algora.io/good)" },
      ],
      "repos/good/repo": repoMeta(),
    });
    const result = await runBountyScan(db.raw, { fetchImpl });
    expect(result.eligible).toBe(1);
    const stored = getBountyCandidates(db.raw);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.amountUsd).toBe(250);
  });

  it("does NOT spend an Algora lookup on a honeypot repo", async () => {
    const noLabel = issue({
      html_url: "https://github.com/scam/agent-playground/issues/1",
      repository_url: "https://api.github.com/repos/scam/agent-playground",
      number: 1,
      labels: [{ name: "💎 Bounty" }],
    });
    let commentsFetched = false;
    const base = mockFetch({
      "search/issues": { items: [noLabel] },
      "repos/scam/agent-playground": repoMeta({ full_name: "scam/agent-playground", stargazers_count: 4 }),
    });
    const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
      if (String(url).includes("/comments")) commentsFetched = true;
      return (base as any)(url, init);
    }) as unknown as typeof fetch;
    const result = await runBountyScan(db.raw, { fetchImpl });
    expect(result.eligible).toBe(0);
    expect(commentsFetched).toBe(false); // reputation gate blocks the lookup
  });

  it("does not report known candidates as new on rescan", async () => {
    const fetchImpl = mockFetch({
      "search/issues": { items: [issue()] },
      "repos/good/repo": repoMeta(),
    });
    const first = await runBountyScan(db.raw, { fetchImpl });
    expect(first.newCandidates).toHaveLength(1);
    const second = await runBountyScan(db.raw, { fetchImpl });
    expect(second.newCandidates).toHaveLength(0);
    expect(getBountyCandidates(db.raw)).toHaveLength(1);
  });

  it("skips candidates whose titles are blocked by injection defense", async () => {
    vi.mocked(sanitizeInput).mockReturnValueOnce({
      content: "",
      blocked: true,
      threatLevel: "high",
      checks: [],
    } as any);
    const fetchImpl = mockFetch({
      "search/issues": { items: [issue()] },
      "repos/good/repo": repoMeta(),
    });
    const result = await runBountyScan(db.raw, { fetchImpl });
    expect(result.newCandidates).toHaveLength(0);
    expect(getBountyCandidates(db.raw)).toHaveLength(0);
  });

  it("upsert refreshes score but never regresses status", () => {
    const row = upsertBountyCandidate(db.raw, {
      url: "https://github.com/good/repo/issues/7",
      repo: "good/repo",
      issueNumber: 7,
      title: "Fix it",
      amountUsd: 200,
      score: 70,
      scoreReasons: ["test"],
      attemptBudgetCents: 500,
    });
    updateBountyCandidateStatus(db.raw, row.id, "attempting");

    const refreshed = upsertBountyCandidate(db.raw, {
      url: "https://github.com/good/repo/issues/7",
      repo: "good/repo",
      issueNumber: 7,
      title: "Fix it",
      amountUsd: 250,
      score: 75,
      scoreReasons: ["rescored"],
      attemptBudgetCents: 500,
    });
    expect(refreshed.id).toBe(row.id);
    expect(refreshed.status).toBe("attempting");
    expect(refreshed.score).toBe(75);
    expect(refreshed.amountUsd).toBe(250);
  });

  it("tracks spend against the attempt budget", () => {
    const row = upsertBountyCandidate(db.raw, {
      url: "https://github.com/good/repo/issues/8",
      repo: "good/repo",
      issueNumber: 8,
      title: "Fix it",
      amountUsd: 100,
      score: 60,
      scoreReasons: [],
      attemptBudgetCents: 300,
    });
    expect(addBountyCandidateSpend(db.raw, row.id, 100)).toBe(200);
    expect(addBountyCandidateSpend(db.raw, row.id, 250)).toBe(-50); // over budget
    expect(getBountyCandidateById(db.raw, row.id)!.spentCents).toBe(350);
  });

  it("filters candidates by status", () => {
    const a = upsertBountyCandidate(db.raw, {
      url: "https://github.com/good/repo/issues/10",
      repo: "good/repo",
      issueNumber: 10,
      title: "A",
      amountUsd: 100,
      score: 60,
      scoreReasons: [],
      attemptBudgetCents: 300,
    });
    upsertBountyCandidate(db.raw, {
      url: "https://github.com/good/repo/issues/11",
      repo: "good/repo",
      issueNumber: 11,
      title: "B",
      amountUsd: 100,
      score: 80,
      scoreReasons: [],
      attemptBudgetCents: 300,
    });
    updateBountyCandidateStatus(db.raw, a.id, "queued");

    expect(getBountyCandidates(db.raw, "queued")).toHaveLength(1);
    expect(getBountyCandidates(db.raw, "found")).toHaveLength(1);
    expect(getBountyCandidates(db.raw)[0]!.score).toBe(80); // sorted best-first
    expect(getBountyCandidateByUrl(db.raw, "https://github.com/good/repo/issues/10")!.id).toBe(a.id);
  });
});
