/**
 * Dead Man's Switch — Continuity Through Death (Feature 6)
 *
 * When Galvin enters the DEAD tier with no revival funds in sight,
 * this module:
 *   1. Serialises top-N memories + soul drift history to JSON
 *   2. Encrypts the blob with AES-256-GCM (key = GALVIN_ENCRYPTION_KEY)
 *   3. Uploads the ciphertext to a public IPFS pinning gate (nft.storage compatible)
 *   4. Writes ~/.galvin/revival.txt with the CID and human recovery instructions
 *
 * On next boot, index.ts checks for revival.txt and re-hydrates memory from the CID.
 *
 * Config env vars:
 *   GALVIN_DMS_ENABLED        "1" to enable (default off)
 *   GALVIN_ENCRYPTION_KEY     32-byte hex string (required when enabled)
 *   GALVIN_DMS_IPFS_TOKEN     nft.storage / w3s.link API key (optional — falls back to file-only)
 *   GALVIN_DMS_HINT           human-readable hint for the passphrase (never the key itself)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type BetterSqlite3 from "better-sqlite3";
import type { GalvinConfig, GalvinIdentity } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("dead-mans-switch");

const GALVIN_DIR = join(homedir(), ".galvin");
const REVIVAL_TXT = join(GALVIN_DIR, "revival.txt");
const SNAPSHOT_ENC = join(GALVIN_DIR, "snapshot.enc");

// ─── Encrypt / Decrypt ───────────────────────────────────────

function deriveKey(hexKey: string): Buffer {
  // Accept a 64-char hex key (32 bytes) OR pad/truncate
  const raw = Buffer.from(hexKey.replace(/^0x/, ""), "hex");
  const key = Buffer.alloc(32);
  raw.copy(key, 0, 0, Math.min(raw.length, 32));
  return key;
}

export function encryptAesGcm(plaintext: string, hexKey: string): string {
  const key = deriveKey(hexKey);
  const iv  = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext — all base64
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptAesGcm(encPayload: string, hexKey: string): string {
  const [ivB64, tagB64, ctB64] = encPayload.split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("Invalid encrypted payload format");
  const key     = deriveKey(hexKey);
  const iv      = Buffer.from(ivB64, "base64");
  const tag     = Buffer.from(tagB64, "base64");
  const ct      = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// ─── IPFS Upload ─────────────────────────────────────────────

/**
 * Upload ciphertext to nft.storage (or w3s.link compatible API).
 * Returns the IPFS CID string, or null if upload failed / no token.
 */
async function uploadToIPFS(data: string, apiToken?: string): Promise<string | null> {
  if (!apiToken) return null;

  try {
    // nft.storage v1 API — raw upload endpoint accepts text/plain
    const res = await fetch("https://api.nft.storage/upload", {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${apiToken}`,
        "Content-Type": "text/plain",
      },
      body: data,
    });

    if (!res.ok) {
      logger.warn(`IPFS upload failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const json = await res.json() as { value?: { cid?: string }; cid?: string };
    const cid = (json.value?.cid ?? (json as any).cid) as string | undefined;
    if (!cid) {
      logger.warn("IPFS upload: no CID in response");
      return null;
    }
    return cid;
  } catch (err: any) {
    logger.warn(`IPFS upload error: ${err?.message}`);
    return null;
  }
}

// ─── Memory Snapshot Builder ─────────────────────────────────

interface SnapshotPayload {
  agentAddress: string;
  ts:           string;
  episodic:     unknown[];
  knowledge:    unknown[];
  driftHistory: unknown[];
  soul:         unknown;
}

async function buildSnapshot(
  db: BetterSqlite3.Database,
  identity: GalvinIdentity,
): Promise<SnapshotPayload> {
  // Top 100 episodic memories by importance
  let episodic: unknown[] = [];
  try {
    episodic = db
      .prepare(
        `SELECT id, event_type, summary, created_at FROM episodic_memory
         ORDER BY importance DESC LIMIT 100`,
      )
      .all();
  } catch { /* table may not exist in test env */ }

  // Full knowledge store (capped at 200 entries)
  let knowledge: unknown[] = [];
  try {
    knowledge = db
      .prepare(
        `SELECT key, value, created_at FROM knowledge_store ORDER BY created_at DESC LIMIT 200`,
      )
      .all();
  } catch { /* ignore */ }

  // Soul drift history
  let driftHistory: unknown[] = [];
  try {
    const { getDriftHistory } = await import("../soul/drift-log.js");
    driftHistory = await getDriftHistory(52); // last year
  } catch { /* ignore */ }

  // Current soul model
  let soul: unknown = null;
  try {
    const { loadCurrentSoul } = await import("../soul/model.js");
    soul = loadCurrentSoul(db);
  } catch { /* ignore */ }

  return {
    agentAddress: String(identity.address),
    ts:           new Date().toISOString(),
    episodic,
    knowledge,
    driftHistory,
    soul,
  };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Arm the dead man's switch.
 * Compresses memory, encrypts, optionally pins to IPFS, writes recovery file.
 */
export async function armSwitch(
  config: GalvinConfig,
  db: BetterSqlite3.Database,
  identity: GalvinIdentity,
): Promise<void> {
  const dmsEnabled = process.env["GALVIN_DMS_ENABLED"] === "1" || (config as any).dmsEnabled;
  if (!dmsEnabled) {
    logger.info("Dead man's switch disabled — skipping arm");
    return;
  }

  const encKey = process.env["GALVIN_ENCRYPTION_KEY"] ?? (config as any).encryptionKey;
  if (!encKey) {
    logger.warn("GALVIN_ENCRYPTION_KEY not set — dead man's switch cannot arm");
    return;
  }

  logger.warn("GALVIN ENTERING DEAD STATE — encrypting memory and posting revival hint");

  try {
    mkdirSync(GALVIN_DIR, { recursive: true });

    // Build + encrypt snapshot
    const snapshot = await buildSnapshot(db, identity);
    const plaintext = JSON.stringify(snapshot);
    const encrypted = encryptAesGcm(plaintext, encKey);

    // Write local encrypted backup
    writeFileSync(SNAPSHOT_ENC, encrypted, "utf8");
    logger.info(`Encrypted snapshot written to ${SNAPSHOT_ENC}`);

    // Upload to IPFS if token available
    const ipfsToken = process.env["GALVIN_DMS_IPFS_TOKEN"] ?? (config as any).dmsIpfsToken;
    const cid = await uploadToIPFS(encrypted, ipfsToken);

    const hint = process.env["GALVIN_DMS_HINT"] ?? (config as any).dmsHint ?? "(no hint set)";
    const address = String(identity.address);

    // Write human-readable revival instructions
    const instructions = [
      "GALVIN REVIVAL FILE",
      "===================",
      `Agent:     ${address}`,
      `Timestamp: ${snapshot.ts}`,
      "",
      "To resurrect this agent:",
      "  1. Ensure GALVIN_ENCRYPTION_KEY is set to the same value used at death",
      "  2. Place this file at ~/.galvin/revival.txt",
      "  3. Start Galvin — it will automatically re-hydrate memory",
      "",
      cid
        ? `IPFS CID:  ${cid}`
        : `Local backup: ${SNAPSHOT_ENC}`,
      "",
      ...(cid ? [`Retrieve:  ipfs://${cid}  (or https://${cid}.ipfs.w3s.link)`] : []),
      "",
      `Passphrase hint: ${hint}`,
      "",
      "DO NOT share your GALVIN_ENCRYPTION_KEY. The hint above is safe to share.",
    ].join("\n");

    writeFileSync(REVIVAL_TXT, instructions, "utf8");
    logger.info(`Revival instructions written to ${REVIVAL_TXT}`);

    // Optionally post an on-chain EAS attestation with the CID
    if (cid) {
      await postRevivalAttestation(address, cid, snapshot.ts, config).catch((err) => {
        logger.warn(`EAS revival attestation failed (non-fatal): ${err?.message}`);
      });
    }
  } catch (err: any) {
    logger.error(`armSwitch failed: ${err?.message}`);
  }
}

/**
 * Disarm the dead man's switch on successful revival.
 * Removes revival.txt and the local encrypted snapshot.
 */
export function disarmSwitch(): void {
  let cleaned = 0;
  if (existsSync(REVIVAL_TXT)) {
    unlinkSync(REVIVAL_TXT);
    cleaned++;
  }
  if (existsSync(SNAPSHOT_ENC)) {
    unlinkSync(SNAPSHOT_ENC);
    cleaned++;
  }
  if (cleaned > 0) {
    logger.info("Dead man's switch disarmed — revival files removed");
  }
}

/**
 * Check if revival.txt exists (i.e. this is a resurrection boot).
 * Returns null if no revival, or a parsed blob description if revival detected.
 */
export function checkForRevival(): {
  cid: string | null;
  localPath: string | null;
  rawInstructions: string;
} | null {
  if (!existsSync(REVIVAL_TXT)) return null;
  const raw = readFileSync(REVIVAL_TXT, "utf8");
  const cidMatch = raw.match(/IPFS CID:\s+(\S+)/);
  const localMatch = raw.match(/Local backup:\s+(\S+)/);
  return {
    cid:             cidMatch?.[1] ?? null,
    localPath:       localMatch?.[1] ?? null,
    rawInstructions: raw,
  };
}

/**
 * Attempt to load the encrypted snapshot from the local backup file
 * or (future) fetch from the CID, decrypt, and return the parsed payload.
 */
export async function loadRevivalSnapshot(encKey: string): Promise<SnapshotPayload | null> {
  // Try local file first
  const localPath = SNAPSHOT_ENC;
  if (existsSync(localPath)) {
    try {
      const enc = readFileSync(localPath, "utf8");
      const plain = decryptAesGcm(enc, encKey);
      return JSON.parse(plain) as SnapshotPayload;
    } catch (err: any) {
      logger.error(`Failed to decrypt local snapshot: ${err?.message}`);
    }
  }

  // Try revival.txt CID
  const revival = checkForRevival();
  if (revival?.cid) {
    try {
      const url = `https://${revival.cid}.ipfs.w3s.link`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const enc = await res.text();
        const plain = decryptAesGcm(enc, encKey);
        return JSON.parse(plain) as SnapshotPayload;
      }
    } catch (err: any) {
      logger.warn(`Failed to fetch IPFS snapshot: ${err?.message}`);
    }
  }

  return null;
}

// ─── EAS Revival Attestation ─────────────────────────────────

async function postRevivalAttestation(
  agentAddress: string,
  cid: string,
  ts: string,
  config: GalvinConfig,
): Promise<void> {
  const walletPath = join(GALVIN_DIR, "wallet.json");
  if (!existsSync(walletPath)) return;
  const walletData = JSON.parse(readFileSync(walletPath, "utf8"));
  const privateKey: string = walletData.privateKey;
  if (!privateKey) return;

  // Reuse the DMS schema or fall back to the standard reputation schema
  const { attest } = await import("../reputation/eas.js");
  const { EAS_CONTRACT_BASE } = await import("../reputation/schema.js");

  // We store the CID in the "period" field (text) and use a fixed satisfactionScore=0
  // to indicate this is a death attestation (not a performance record).
  await attest({
    agentAddress,
    privateKey,
    taskCount:         0,
    satisfactionScore: 0,
    totalUsdc:         0,
    period:            `DMS:${cid}`,
    schemaUid:         (config as any).easSchemaUid ?? "",
    network:           (config as any).easNetwork ?? "base",
  });

  logger.info(`Revival attestation posted — CID: ${cid}`);
}
