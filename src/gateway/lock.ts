/**
 * Gateway Lock File — Process lifecycle management
 *
 * A lock file at ~/.galvin/galvin.lock tracks whether the Galvin agent
 * is running.  Contains JSON: { pid, port, startedAt }.
 *
 * CLI commands (--chat, --status, etc.) read this file to detect
 * a live agent and connect to the gateway HTTP server.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "fs";
import path from "path";
import { getGalvinDir } from "../identity/wallet.js";

// ─── Types ────────────────────────────────────────────────────

export interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

// ─── Paths ────────────────────────────────────────────────────

function lockPath(): string {
  return path.join(getGalvinDir(), "galvin.lock");
}

// ─── Write / Remove ───────────────────────────────────────────

/** Write the lock file when the gateway starts. */
export function writeLock(info: LockInfo): void {
  writeFileSync(lockPath(), JSON.stringify(info, null, 2) + "\n", "utf-8");
}

/** Remove the lock file on shutdown. */
export function removeLock(): void {
  try {
    unlinkSync(lockPath());
  } catch {
    /* already gone — fine */
  }
}

// ─── Read / Probe ─────────────────────────────────────────────

/** Read the lock file, or null if it doesn't exist or is invalid. */
export function readLock(): LockInfo | null {
  const p = lockPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data.pid === "number" && typeof data.port === "number") {
      return data as LockInfo;
    }
    return null;
  } catch {
    return null;
  }
}

/** Check if the PID in the lock file is still alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = just check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the agent is running.
 * Returns the lock info if the lock file exists AND the PID is alive.
 * Cleans up stale lock files automatically.
 */
export function getRunningAgent(): LockInfo | null {
  const lock = readLock();
  if (!lock) return null;

  if (isPidAlive(lock.pid)) {
    return lock;
  }

  // Stale lock — PID is dead.  Clean it up.
  removeLock();
  return null;
}

/**
 * Probe the gateway HTTP server to verify it's actually responding.
 * Returns the health response or null on failure.
 */
export async function probeGateway(port: number): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      return (await res.json()) as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Full liveness check: lock file + PID alive + gateway HTTP probe.
 * Returns { running: true, lock, health } or { running: false }.
 */
export async function checkAgentLive(): Promise<
  | { running: true; lock: LockInfo; health: Record<string, unknown> }
  | { running: false; reason: string }
> {
  const lock = readLock();
  if (!lock) return { running: false, reason: "no lock file" };
  if (!isPidAlive(lock.pid)) {
    removeLock();
    return { running: false, reason: "stale lock (PID dead)" };
  }
  const health = await probeGateway(lock.port);
  if (!health) {
    return { running: false, reason: "gateway not responding" };
  }
  return { running: true, lock, health };
}
