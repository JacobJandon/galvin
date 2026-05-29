/**
 * Galvin Gateway — Lightweight HTTP Server
 *
 * Starts alongside `galvin --run` and provides:
 *   GET  /health            → Quick liveness check
 *   GET  /status            → Full agent status (state, turns, goals, etc.)
 *   POST /chat              → Send a chat message to the agent
 *   GET  /chat/messages     → Poll for new agent messages (?since=<id>)
 *
 * Inspired by OpenClaw's gateway but deliberately minimal:
 * no WebSocket, no JSON-RPC — just plain REST for CLI consumption.
 */

import http from "http";
import { createLogger } from "../observability/logger.js";
import { writeLock, removeLock } from "./lock.js";
import type { GalvinDatabase, GalvinConfig } from "../types.js";

const logger = createLogger("gateway");

// ─── Types ────────────────────────────────────────────────────

export interface GatewayOptions {
  db: GalvinDatabase;
  config: GalvinConfig;
  address: string;
  port?: number; // 0 = auto-select
}

export interface GatewayServer {
  port: number;
  close: () => Promise<void>;
}

// ─── Route helpers ────────────────────────────────────────────

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res: http.ServerResponse): void {
  json(res, { error: "not found" }, 404);
}

function badRequest(res: http.ServerResponse, msg: string): void {
  json(res, { error: msg }, 400);
}

// ─── Start gateway ───────────────────────────────────────────

export async function startGateway(opts: GatewayOptions): Promise<GatewayServer> {
  const { db, config, address } = opts;
  const startedAt = new Date().toISOString();
  const requestedPort = opts.port ?? 0; // 0 = OS picks a free port

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    // ── CORS (if anyone ever curls from a browser) ──
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // ── GET /health ───────────────────────────────────
      if (method === "GET" && pathname === "/health") {
        const state = db.getAgentState();
        const uptime = Date.now() - new Date(startedAt).getTime();
        json(res, {
          status: "ok",
          pid: process.pid,
          state,
          uptime,
          uptimeHuman: formatUptime(uptime),
          startedAt,
          version: config.version || "0.3.0",
          name: config.name,
        });
        return;
      }

      // ── GET /status ───────────────────────────────────
      if (method === "GET" && pathname === "/status") {
        const state = db.getAgentState();
        const turnCount = db.getTurnCount();
        const tools = db.getInstalledTools();
        const heartbeats = db.getHeartbeatEntries();
        const skills = db.getSkills(true);
        const children = db.getChildren();
        const registry = db.getRegistryEntry();
        const aliveChildren = children.filter((c: { status: string }) => c.status !== "dead").length;

        // Orchestrator phase
        let orchPhase = "unknown";
        try {
          const raw = db.getKV("orchestrator.last_tick");
          if (raw) orchPhase = JSON.parse(raw).phase ?? "unknown";
        } catch { /* */ }

        // Active goals
        let activeGoals = 0;
        try {
          const row = db.raw.prepare(
            "SELECT COUNT(*) as c FROM goals WHERE status = 'active'"
          ).get() as { c: number } | undefined;
          activeGoals = row?.c ?? 0;
        } catch { /* */ }

        json(res, {
          name: config.name,
          address,
          creator: config.creatorAddress,
          sandbox: config.sandboxId || "(local)",
          model: config.inferenceModel,
          state,
          turnCount,
          activeGoals,
          orchestratorPhase: orchPhase,
          tools: tools.length,
          skills: skills.length,
          heartbeats: heartbeats.filter((h: { enabled: boolean }) => h.enabled).length,
          children: { alive: aliveChildren, total: children.length },
          agentId: registry?.agentId || null,
          startedAt,
          pid: process.pid,
          uptime: Date.now() - new Date(startedAt).getTime(),
        });
        return;
      }

      // ── POST /chat ────────────────────────────────────
      if (method === "POST" && pathname === "/chat") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
            if (!message) {
              badRequest(res, "missing 'message' field");
              return;
            }
            const creatorAddr = config.creatorAddress || "creator";
            const now = new Date().toISOString();
            const msgId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

            // Insert into chat_messages + inbox_messages + wake event
            try {
              db.raw.prepare(
                "INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)"
              ).run("user", message, now);
              db.raw.prepare(
                `INSERT INTO inbox_messages (id, from_address, content, received_at, status, retry_count, max_retries)
                 VALUES (?, ?, ?, ?, 'received', 0, 3)`
              ).run(msgId, creatorAddr, message, now);
              db.raw.prepare(
                "INSERT INTO wake_events (source, reason, created_at) VALUES (?, ?, ?)"
              ).run("gateway", `Chat: ${message.slice(0, 50)}`, now);
            } catch (err: any) {
              json(res, { error: `db error: ${err.message}` }, 500);
              return;
            }

            json(res, { ok: true, id: msgId });
          } catch {
            badRequest(res, "invalid JSON body");
          }
        });
        return;
      }

      // ── GET /chat/messages ────────────────────────────
      if (method === "GET" && pathname === "/chat/messages") {
        const sinceId = parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 200);
        try {
          const rows = db.raw.prepare(
            "SELECT id, role, content, created_at FROM chat_messages WHERE id > ? ORDER BY id ASC LIMIT ?"
          ).all(sinceId, limit) as Array<{ id: number; role: string; content: string; created_at: string }>;
          json(res, { messages: rows });
        } catch (err: any) {
          json(res, { error: `db error: ${err.message}` }, 500);
        }
        return;
      }

      // ── GET /chat/unread ──────────────────────────────
      if (method === "GET" && pathname === "/chat/unread") {
        try {
          const rows = db.raw.prepare(
            "SELECT id, content, created_at FROM chat_messages WHERE role = 'agent' AND read = 0 ORDER BY id ASC"
          ).all() as Array<{ id: number; content: string; created_at: string }>;
          // Mark as read
          for (const row of rows) {
            db.raw.prepare("UPDATE chat_messages SET read = 1 WHERE id = ?").run(row.id);
          }
          json(res, { messages: rows });
        } catch (err: any) {
          json(res, { error: `db error: ${err.message}` }, 500);
        }
        return;
      }

      notFound(res);
    } catch (err: any) {
      logger.error(`Gateway request error: ${err.message}`);
      json(res, { error: "internal server error" }, 500);
    }
  });

  // Listen on 127.0.0.1 only (not exposed to network)
  return new Promise<GatewayServer>((resolve, reject) => {
    server.on("error", (err) => {
      logger.error(`Gateway server error: ${err.message}`);
      reject(err);
    });

    server.listen(requestedPort, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : requestedPort;

      // Write lock file
      writeLock({
        pid: process.pid,
        port: actualPort,
        startedAt,
      });

      logger.info(`Gateway listening on http://127.0.0.1:${actualPort}`);

      resolve({
        port: actualPort,
        close: async () => {
          removeLock();
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}

// ─── Helpers ──────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
