import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildSkillIndex,
  searchSkillIndex,
  cacheMarketplaceListings,
  loadCache,
  isCacheStale,
  type SkillIndexEntry,
} from "../../skills/index-cache.js";

const files: string[] = [];
const tmp = () => {
  const f = path.join(os.tmpdir(), `skill-idx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  files.push(f);
  return f;
};
// Minimal DB stub — buildSkillIndex only reads getSkills().{name,description,tags}.
const fakeDb = (skills: Array<{ name: string; description: string; tags?: string[] }>) =>
  ({ getSkills: () => skills }) as never;

afterEach(() => {
  for (const f of files) try { fs.rmSync(f); } catch { /* ignore */ }
});

describe("skill index cache", () => {
  it("caches marketplace listings and loads them back", () => {
    const f = tmp();
    cacheMarketplaceListings(
      [{ name: "browser-qa", description: "browser testing", tags: ["browser", "qa"], listingUrl: "u", priceCentsUsdc: 100 }],
      f,
    );
    const cached = loadCache(f);
    expect(cached).toHaveLength(1);
    expect(cached[0].name).toBe("browser-qa");
    expect(cached[0].installed).toBe(false);
    expect(cached[0].source).toBe("marketplace");
  });

  it("merges listings by name on re-cache", () => {
    const f = tmp();
    cacheMarketplaceListings([{ name: "a", description: "old" }], f);
    cacheMarketplaceListings([{ name: "a", description: "new" }, { name: "b" }], f);
    const cached = loadCache(f);
    expect(cached).toHaveLength(2);
    expect(cached.find((e) => e.name === "a")?.description).toBe("new");
  });

  it("buildSkillIndex: installed skills win over cached marketplace entries", () => {
    const f = tmp();
    cacheMarketplaceListings([{ name: "shared", description: "from market" }, { name: "market-only" }], f);
    const db = fakeDb([
      { name: "shared", description: "installed", tags: ["x"] },
      { name: "local-only", description: "l", tags: [] },
    ]);
    const index = buildSkillIndex(db, f);
    const shared = index.find((e) => e.name === "shared");
    expect(shared?.installed).toBe(true);
    expect(shared?.description).toBe("installed");
    expect(index.map((e) => e.name).sort()).toEqual(["local-only", "market-only", "shared"]);
  });

  it("searchSkillIndex ranks name > tag > description", () => {
    const index: SkillIndexEntry[] = [
      { name: "browser", description: "x", tags: [], installed: false, source: "marketplace" },
      { name: "qa-tool", description: "x", tags: ["browser"], installed: false, source: "marketplace" },
      { name: "other", description: "a browser thing", tags: [], installed: false, source: "marketplace" },
    ];
    const r = searchSkillIndex(index, "browser");
    expect(r.map((e) => e.name)).toEqual(["browser", "qa-tool", "other"]);
  });

  it("isCacheStale: true when missing, false right after writing", () => {
    const f = tmp();
    expect(isCacheStale(f)).toBe(true);
    cacheMarketplaceListings([{ name: "x" }], f);
    expect(isCacheStale(f)).toBe(false);
  });
});
