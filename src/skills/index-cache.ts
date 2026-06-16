/**
 * Skill Index Cache
 *
 * A fast, offline-searchable index of every skill Galvin knows about:
 *  - installed skills (from the DB), and
 *  - marketplace listings discovered by previous `search_skills` calls, cached
 *    locally so repeat discovery is instant and works without the network.
 *
 * This is the caching layer over the live Conway marketplace (`queryMarketplace`):
 * a live search populates the cache; subsequent discovery can read it offline.
 * No fabricated catalog — the index only ever contains real installed skills and
 * real listings that were actually fetched.
 */
import fs from "fs";
import path from "path";
import type { GalvinDatabase, Skill } from "../types.js";

export interface SkillIndexEntry {
  name: string;
  description: string;
  tags: string[];
  installed: boolean;
  source: "installed" | "marketplace";
  listingUrl?: string;
  priceCentsUsdc?: number;
}

interface CacheFile {
  fetchedAt: string;
  entries: SkillIndexEntry[];
}

/** Marketplace listings go stale after 6h — re-query the network past that. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function defaultCachePath(): string {
  return path.join(process.env.HOME ?? "", ".galvin", "skill-index-cache.json");
}

/** A marketplace listing as returned by `queryMarketplace`. */
export interface MarketListing {
  name: string;
  description?: string;
  tags?: string[];
  listingUrl?: string;
  priceCentsUsdc?: number;
}

/** Merge freshly-fetched marketplace listings into the cache (by name). */
export function cacheMarketplaceListings(listings: MarketListing[], file = defaultCachePath()): void {
  const byName = new Map(loadCache(file).map((e) => [e.name, e]));
  for (const l of listings) {
    if (!l?.name) continue;
    byName.set(l.name, {
      name: l.name,
      description: l.description ?? "",
      tags: Array.isArray(l.tags) ? l.tags : [],
      installed: false,
      source: "marketplace",
      listingUrl: l.listingUrl,
      priceCentsUsdc: l.priceCentsUsdc,
    });
  }
  const payload: CacheFile = { fetchedAt: new Date().toISOString(), entries: [...byName.values()] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

export function loadCache(file = defaultCachePath()): SkillIndexEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile;
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

export function isCacheStale(file = defaultCachePath(), ttlMs = CACHE_TTL_MS): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as CacheFile;
    return Date.now() - Date.parse(raw.fetchedAt) > ttlMs;
  } catch {
    return true; // missing/unreadable cache is "stale" → refresh
  }
}

/** Build the full index: installed skills (DB) win over cached marketplace entries. */
export function buildSkillIndex(db: GalvinDatabase, file = defaultCachePath()): SkillIndexEntry[] {
  const installed: SkillIndexEntry[] = db.getSkills().map((s: Skill) => ({
    name: s.name,
    description: s.description,
    tags: s.tags ?? [],
    installed: true,
    source: "installed" as const,
  }));
  const installedNames = new Set(installed.map((e) => e.name));
  const cached = loadCache(file).filter((e) => !installedNames.has(e.name));
  return [...installed, ...cached];
}

/** Fast offline search over the index, ranked name > tag > description. */
export function searchSkillIndex(index: SkillIndexEntry[], query: string, limit = 10): SkillIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return index.slice(0, limit);
  const scored = index
    .map((e) => {
      const name = e.name.toLowerCase();
      const desc = e.description.toLowerCase();
      const tags = e.tags.map((t) => t.toLowerCase());
      let score = 0;
      if (name === q) score += 100;
      else if (name.includes(q)) score += 50;
      if (tags.some((t) => t === q)) score += 30;
      else if (tags.some((t) => t.includes(q))) score += 15;
      if (desc.includes(q)) score += 10;
      if (e.installed) score += 2; // small boost: already usable
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.e);
}
