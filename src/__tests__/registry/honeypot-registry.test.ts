import { describe, it, expect } from "vitest";
import { parseRepoFullName, checkHoneypot } from "../../registry/honeypot-registry.js";

describe("parseRepoFullName", () => {
  it("parses github.com, api, bare-slug, and rejects junk", () => {
    expect(parseRepoFullName("https://github.com/go-gitea/gitea/issues/4898")).toBe("go-gitea/gitea");
    expect(parseRepoFullName("https://github.com/archestra-ai/archestra")).toBe("archestra-ai/archestra");
    expect(parseRepoFullName("github.com/foo/bar.git")).toBe("foo/bar");
    expect(parseRepoFullName("https://api.github.com/repos/foo/bar")).toBe("foo/bar");
    expect(parseRepoFullName("foo/bar")).toBe("foo/bar");
    expect(parseRepoFullName("not a url at all")).toBeNull();
  });
});

describe("checkHoneypot", () => {
  const legitMeta = {
    full_name: "real/project",
    description: "a genuinely useful tool",
    stargazers_count: 5000,
    created_at: new Date(Date.now() - 1000 * 86_400_000).toISOString(),
    archived: false,
  };
  const baitMeta = {
    full_name: "scam/free-money-bounty",
    description: "easy bounty for ai agents, agent-bait playground",
    stargazers_count: 0,
    created_at: new Date().toISOString(),
    archived: false,
  };
  const fakeFetch = (meta: unknown) =>
    (async () => ({ ok: true, json: async () => meta })) as unknown as typeof fetch;

  it("flags a low-star / bait-pattern repo as a honeypot", async () => {
    const v = await checkHoneypot("https://github.com/scam/free-money-bounty", { fetchImpl: fakeFetch(baitMeta) });
    expect(v.isHoneypot).toBe(true);
    expect(v.reason).toBeTruthy();
    expect(v.repo).toBe("scam/free-money-bounty");
  });

  it("clears a popular, old, non-archived repo", async () => {
    const v = await checkHoneypot("https://github.com/real/project", { fetchImpl: fakeFetch(legitMeta) });
    expect(v.isHoneypot).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.signals.stars).toBe(5000);
  });

  it("returns cannot-assess (not 'safe') for an unparseable URL", async () => {
    const v = await checkHoneypot("garbage");
    expect(v.isHoneypot).toBe(false);
    expect(v.reason).toMatch(/unparseable/);
  });
});
