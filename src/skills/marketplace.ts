/**
 * Skill Marketplace — Feature 7
 *
 * Galvin publishes skills it has written or refined to a public registry.
 * Other Galvin instances pay micro-USDC (x402) to import them.
 * The original Galvin earns passively from every skill adoption.
 *
 * Two roles:
 *   Seller: publishSkill() → POST to Conway skill registry → listing URL
 *   Buyer:  importSkill(listingUrl) → x402 pay → download + install
 *
 * Optionally run a local skill-serving HTTP server (port 8403 by default)
 * to let other agents directly purchase from this instance.
 */

import http from "node:http";
import fs from "fs";
import path from "path";
import { homedir } from "os";
import type { GalvinIdentity, GalvinConfig, GalvinDatabase, Skill, SkillSource } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("skills.marketplace");

const DEFAULT_MARKETPLACE_PORT = 8403;
const SKILL_LISTING_TABLE = "marketplace_listings";
const CONWAY_SKILLS_API = "https://api.conway.cloud/v1/skills";

export interface SkillListing {
  listingId:     string;
  skillName:     string;
  name:         string;
  description:  string;
  priceCentsUsdc: number;
  sellerAddress: string;
  listingUrl:   string;
  publishedAt:  string;
  signature?:   string;
}

// ─── Schema ──────────────────────────────────────────────────

/**
 * Ensure (lazily) the marketplace_listings table exists.
 */
function ensureTable(db: GalvinDatabase): void {
  try {
    (db as any).raw.prepare(`
      CREATE TABLE IF NOT EXISTS ${SKILL_LISTING_TABLE} (
        listing_id    TEXT PRIMARY KEY,
        skill_name     TEXT NOT NULL,
        name          TEXT NOT NULL,
        description   TEXT,
        price_cents   INTEGER NOT NULL DEFAULT 1,
        seller_address TEXT NOT NULL,
        listing_url   TEXT,
        published_at  TEXT NOT NULL,
        signature     TEXT,
        is_local      INTEGER NOT NULL DEFAULT 1
      )
    `).run();
  } catch { /* already exists */ }
}

// ─── Signing helper ──────────────────────────────────────────

async function signBundle(bundle: object, identity: GalvinIdentity): Promise<string> {
  const { createHmac } = await import("crypto");
  // SIWE-level signing: use account.sign if available, else HMAC w/ address as key
  const payload = JSON.stringify(bundle);
  try {
    if ((identity as any).account?.sign) {
      // viem account
      const sig = await (identity as any).account.sign({ message: payload });
      return sig as string;
    }
  } catch { /* fall through */ }
  // Fallback: HMAC-SHA256 using the agent address as key (deterministic, not a real ECDSA sig)
  return createHmac("sha256", String(identity.address)).update(payload).digest("hex");
}

// ─── Publish ─────────────────────────────────────────────────

/**
 * Publish a skill to the marketplace.
 * - Posts to Conway Cloud skill registry if available
 * - Always stores the listing in the local DB
 * Returns the listing URL (Conway Cloud or local fallback).
 */
export async function publishSkill(
  skillName:      string,
  priceCentsUsdc: number,
  identity:       GalvinIdentity,
  db:             GalvinDatabase,
): Promise<string> {
  ensureTable(db);

  // Load the skill from the DB
  let skill = db.getSkillByName(skillName);
  if (!skill) {
    const all = db.getSkills(true);
    skill = all.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
  }
  if (!skill) throw new Error(`Skill not found: ${skillName}`);

  const bundle = {
    skillName:    skill.name,
    name:         skill.name,
    description:  skill.description,
    instructions: skill.instructions,
    seller:       String(identity.address),
    priceCentsUsdc,
    publishedAt: new Date().toISOString(),
  };

  const signature = await signBundle(bundle, identity);
  const listingId = `listing-${skill.name.replace(/[^a-z0-9]/gi, "-")}-${Date.now()}`;

  // Attempt to post to Conway Cloud (non-fatal if API unavailable)
  let listingUrl = `local://skills/${listingId}`;
  try {
    const res = await fetch(`${CONWAY_SKILLS_API}/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Address": String(identity.address),
        "X-Signature": signature,
      },
      body: JSON.stringify({ listing: bundle }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json() as { listingUrl?: string; id?: string };
      listingUrl = data.listingUrl ?? `${CONWAY_SKILLS_API}/${data.id ?? listingId}`;
      logger.info(`Skill published to Conway Cloud: ${listingUrl}`);
    } else {
      logger.warn(`Conway Cloud publish failed (${res.status}) — listing stored locally only`);
    }
  } catch (err: any) {
    logger.warn(`Conway Cloud unreachable: ${err?.message} — listing stored locally only`);
  }

  // Store locally
  (db as any).raw
    .prepare(
      `INSERT OR REPLACE INTO ${SKILL_LISTING_TABLE}
       (listing_id, skill_name, name, description, price_cents, seller_address, listing_url, published_at, signature, is_local)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      listingId,
      skill.name,
      skill.name,
      skill.description ?? "",
      priceCentsUsdc,
      String(identity.address),
      listingUrl,
      bundle.publishedAt,
      signature,
      1,
    );

  try {
    const { recordIncome } = await import("../earning/optimizer.js");
    recordIncome((db as any).raw, skill.name, 0);
  } catch { /* non-fatal */ }

  logger.info(`Skill "${skill.name}" listed @ $${(priceCentsUsdc / 100).toFixed(4)} USDC — ${listingUrl}`);
  return listingUrl;
}

// ─── List local listings ─────────────────────────────────────

export function listLocalListings(db: GalvinDatabase): SkillListing[] {
  ensureTable(db);
  try {
    const rows = (db as any).raw
      .prepare(`SELECT * FROM ${SKILL_LISTING_TABLE} ORDER BY published_at DESC LIMIT 50`)
      .all() as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      listingId:      String(r.listing_id),
      skillName:      String(r.skill_name ?? r.skill_id ?? ""),
      name:           String(r.name),
      description:    String(r.description ?? ""),
      priceCentsUsdc: Number(r.price_cents),
      sellerAddress:  String(r.seller_address),
      listingUrl:     String(r.listing_url ?? ""),
      publishedAt:    String(r.published_at),
      signature:      r.signature ? String(r.signature) : undefined,
    }));
  } catch {
    return [];
  }
}

// ─── Import ──────────────────────────────────────────────────

/**
 * Import a skill from a marketplace listing URL.
 * - Fetches the listing
 * - If x402 payment required, handles the payment flow
 * - Installs the skill to ~/.galvin/skills/<name>/SKILL.md
 * - Registers it in the DB
 */
export async function importSkill(
  listingUrl: string,
  identity:   GalvinIdentity,
  db:         GalvinDatabase,
  skillsDir?: string,
): Promise<Skill> {
  // Validate URL
  let url: URL;
  try {
    url = new URL(listingUrl);
  } catch {
    throw new Error(`Invalid listing URL: ${listingUrl}`);
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported scheme: ${url.protocol} — only http/https listings are supported`);
  }

  // Fetch the listing (first attempt — may get 402)
  let res = await fetch(listingUrl, { signal: AbortSignal.timeout(15_000) });

  if (res.status === 402) {
    // x402 payment required
    const payDescriptor = await res.json() as {
      accepts?: Array<{ payToAddress: string; maxAmountRequired: string; network: string }>;
      description?: string;
    };

    const payInfo = payDescriptor.accepts?.[0];
    if (!payInfo) throw new Error("Invalid 402 response — no payment descriptor");

    logger.info(
      `x402 payment required: ${payInfo.maxAmountRequired} USDC to ${payInfo.payToAddress}`,
    );

    // Build a mock payment proof for local/dev environments
    // In production, this would use the wallet to sign an on-chain tx
    const proof = {
      from:        String(identity.address),
      to:          payInfo.payToAddress,
      network:     payInfo.network,
      amountMicro: String(Math.round(parseFloat(payInfo.maxAmountRequired) * 1_000_000)),
      timestamp:   new Date().toISOString(),
      nonce:       Math.random().toString(36).slice(2),
    };
    const paymentHeader = Buffer.from(JSON.stringify(proof)).toString("base64");

    // Retry with payment header
    res = await fetch(listingUrl, {
      headers: { "X-Payment": paymentHeader },
      signal:  AbortSignal.timeout(15_000),
    });
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch skill bundle: ${res.status} ${res.statusText}`);
  }

  const bundle = await res.json() as {
    skillName?: string;
    name:        string;
    description?: string;
    instructions: string;
    seller?:     string;
    priceCentsUsdc?: number;
  };

  if (!bundle.name || !bundle.instructions) {
    throw new Error("Invalid skill bundle: missing name or instructions");
  }

  // Install to skills directory
  const resolvedSkillsDir = skillsDir
    ? skillsDir.replace(/^~/, homedir())
    : path.join(homedir(), ".galvin", "skills");

  fs.mkdirSync(resolvedSkillsDir, { recursive: true });

  const safeSkillName = bundle.name.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase();
  const skillDir = path.join(resolvedSkillsDir, safeSkillName);
  fs.mkdirSync(skillDir, { recursive: true });

  // Write SKILL.md
  const skillMd = [
    `---`,
    `name: ${bundle.name}`,
    `description: ${bundle.description ?? ""}`,
    `source: marketplace`,
    `seller: ${bundle.seller ?? "unknown"}`,
    `---`,
    "",
    bundle.instructions,
  ].join("\n");

  const skillMdPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillMdPath, skillMd, "utf8");

  const skill: Skill = {
    name:         bundle.name,
    description:  bundle.description ?? "",
    instructions: bundle.instructions,
    source:       "marketplace" as SkillSource,
    path:         skillMdPath,
    enabled:      true,
    autoActivate: false,
    installedAt:  new Date().toISOString(),
  };

  db.upsertSkill(skill);

  logger.info(`Skill "${bundle.name}" imported from ${listingUrl}`);
  return skill;
}

// ─── Skill Market Server ──────────────────────────────────────

let _marketServer: http.Server | null = null;

export interface SkillMarketServerOptions {
  port?:     number;
  identity:  GalvinIdentity;
  config:    GalvinConfig;
  db:        GalvinDatabase;
}

/**
 * Start a lightweight HTTP server that serves locally listed skills.
 * Other agents pay x402 to download skill bundles.
 */
export function startSkillMarketServer(opts: SkillMarketServerOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    if (_marketServer) {
      resolve(DEFAULT_MARKETPLACE_PORT);
      return;
    }

    const port = opts.port ?? DEFAULT_MARKETPLACE_PORT;

    const server = http.createServer(async (req, res) => {
      const urlPath = req.url ?? "/";

      // ── GET /skills — list available skills ─────────────────
      if (urlPath === "/skills" || urlPath === "/skills/") {
        const listings = listLocalListings(opts.db);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ skills: listings }));
        return;
      }

      // ── GET /skills/:listingId ───────────────────────────────
      const skillMatch = urlPath.match(/^\/skills\/([^/]+)$/);
      if (skillMatch) {
        const listingId = skillMatch[1];
        ensureTable(opts.db);
        const row = (opts.db as any).raw
          .prepare(`SELECT * FROM ${SKILL_LISTING_TABLE} WHERE listing_id = ?`)
          .get(listingId) as Record<string, unknown> | undefined;

        if (!row) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Skill listing not found" }));
          return;
        }

        const paymentHeader = req.headers["x-payment"];
        const priceCents = Number(row.price_cents ?? 1);

        // Require payment if price > 0
        if (priceCents > 0 && !paymentHeader) {
          const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
          const NETWORK_ID = "eip155:8453";
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              x402Version: 1,
              error: "Payment Required",
              accepts: [
                {
                  scheme: "exact",
                  network: NETWORK_ID,
                  maxAmountRequired: (priceCents / 100).toFixed(6),
                  payToAddress: opts.identity.address,
                  requiredDeadlineSeconds: 300,
                  usdcAddress: USDC_BASE,
                },
              ],
              description: `Skill: ${String(row.name)}`,
            }),
          );
          return;
        }

        const skill = opts.db.getSkillByName(String(row.skill_name ?? row.skill_id ?? ""));

        if (!skill) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Skill body not found in local registry" }));
          return;
        }

        if (priceCents > 0) {
          try {
            const { recordIncome } = await import("../earning/optimizer.js");
            recordIncome((opts.db as any).raw, skill.name, priceCents / 100);
          } catch { /* non-fatal */ }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          skillName:      skill.name,
          name:           skill.name,
          description:    skill.description,
          instructions:   skill.instructions,
          seller:         String(opts.identity.address),
          priceCentsUsdc: priceCents,
        }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    });

    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      _marketServer = server;
      logger.info(`Skill market server listening on port ${port}`);
      resolve(port);
    });
  });
}

export function stopSkillMarketServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!_marketServer) { resolve(); return; }
    _marketServer.close(() => {
      _marketServer = null;
      resolve();
    });
  });
}
