/**
 * Hash-chain + Merkle blocks — the tamper-evidence method everything confirms on.
 *
 * Signatures (credential.ts) prove *who said it*. This proves *the history wasn't
 * altered*: each record hashes the previous one, so changing any past entry breaks
 * every hash after it — the blockchain property, without needing a chain. Batches
 * seal into **blocks** with a Merkle root that can be anchored on-chain (EAS / a tx)
 * as an immutable checkpoint, and a Merkle proof confirms one record is in a block
 * without revealing the rest.
 *
 * The passport, trust attestations, the flight-recorder log, and the spend ledger
 * all become tamper-evident by appending to a chain and confirming the head.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./credential.js";

export const GENESIS = "0".repeat(64);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ─── Hash chain ───────────────────────────────────────────────

export interface ChainEntry {
  seq: number;
  timestamp: string;
  type: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

function entryHash(seq: number, timestamp: string, type: string, data: unknown, prevHash: string): string {
  return sha256(`${seq}|${timestamp}|${type}|${canonicalize(data)}|${prevHash}`);
}

/** Append a record. Pass the previous entry (or null for genesis). */
export function append(prev: ChainEntry | null, type: string, data: unknown, now = new Date().toISOString()): ChainEntry {
  const seq = prev ? prev.seq + 1 : 0;
  const prevHash = prev ? prev.hash : GENESIS;
  return { seq, timestamp: now, type, data, prevHash, hash: entryHash(seq, now, type, data, prevHash) };
}

/** Build a chain from raw records in order. */
export function buildChain(records: Array<{ type: string; data: unknown; timestamp?: string }>): ChainEntry[] {
  const out: ChainEntry[] = [];
  let prev: ChainEntry | null = null;
  for (const r of records) {
    prev = append(prev, r.type, r.data, r.timestamp ?? new Date().toISOString());
    out.push(prev);
  }
  return out;
}

export interface ChainVerifyResult {
  valid: boolean;
  length: number;
  brokenAt: number | null;
  reason: string;
  head: string;
}

/** Recompute every hash + check the prevHash links. Any tamper is caught. */
export function verifyChain(entries: ChainEntry[]): ChainVerifyResult {
  let prevHash = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (e.seq !== i) return { valid: false, length: entries.length, brokenAt: i, reason: `seq ${e.seq} ≠ ${i}`, head: GENESIS };
    if (e.prevHash !== prevHash) return { valid: false, length: entries.length, brokenAt: i, reason: "prevHash link broken", head: GENESIS };
    if (entryHash(e.seq, e.timestamp, e.type, e.data, e.prevHash) !== e.hash) {
      return { valid: false, length: entries.length, brokenAt: i, reason: "hash mismatch (record tampered)", head: GENESIS };
    }
    prevHash = e.hash;
  }
  return { valid: true, length: entries.length, brokenAt: null, reason: "ok", head: prevHash };
}

// ─── Merkle blocks ────────────────────────────────────────────

function pairHash(a: string, b: string): string {
  return sha256(a + b);
}

/** Merkle root of a batch of leaf hashes (odd nodes duplicate the last). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return GENESIS;
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i]!, level[i + 1] ?? level[i]!));
    level = next;
  }
  return level[0]!;
}

/** Inclusion proof: the sibling hashes needed to recompute the root from one leaf. */
export function merkleProof(leaves: string[], index: number): string[] {
  if (index < 0 || index >= leaves.length) return [];
  const proof: string[] = [];
  let idx = index;
  let level = leaves.slice();
  while (level.length > 1) {
    const sibling = idx % 2 === 1 ? level[idx - 1]! : (level[idx + 1] ?? level[idx]!);
    proof.push(sibling);
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i]!, level[i + 1] ?? level[i]!));
    level = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Confirm a leaf is in `root` using its proof — without seeing the other records. */
export function verifyMerkleProof(leaf: string, index: number, proof: string[], root: string): boolean {
  let hash = leaf;
  let idx = index;
  for (const sib of proof) {
    hash = idx % 2 === 1 ? pairHash(sib, hash) : pairHash(hash, sib);
    idx = Math.floor(idx / 2);
  }
  return hash === root;
}

export interface Block {
  index: number;
  prevRoot: string;
  root: string; // Merkle root over the entries' hashes
  count: number;
  sealedAt: string;
  blockHash: string; // chains blocks together (like a block header)
}

/** Seal a batch of chain entries into a block (root anchorable on-chain). */
export function sealBlock(index: number, prevRoot: string, entries: ChainEntry[], now = new Date().toISOString()): Block {
  const root = merkleRoot(entries.map((e) => e.hash));
  const count = entries.length;
  return { index, prevRoot, root, count, sealedAt: now, blockHash: sha256(`${index}|${prevRoot}|${root}|${count}|${now}`) };
}
