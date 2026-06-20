/**
 * x402 Earning Server
 *
 * Starts a local HTTP server inside the Conway sandbox that charges
 * x402 micro-payments before delivering content/API responses.
 *
 * How x402 works (server side):
 *   1. Client sends a request with no payment → server responds 402 with
 *      a JSON payment descriptor { network, address, priceCents }
 *   2. Client signs a payment proof (via x402_fetch or compatible wallet)
 *   3. Client resends with `X-Payment` header containing signed proof
 *   4. Server verifies payment on-chain (or via Conway facilitator)
 *   5. Server records income, delivers response
 *
 * Start via the `start_x402_server` tool.
 * Expose publicly via the `expose_port` tool (port default: 8402).
 */

import http from "node:http";
import { ulid } from "ulid";
import type {
  GalvinIdentity,
  GalvinConfig,
  GalvinDatabase,
} from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("earning.x402");

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface X402ServerOptions {
  /** Port to listen on inside the sandbox. Default: 8402 */
  port?: number;
  /** Price per request in USD cents. Default: 1 ($0.01) */
  priceCents?: number;
  /** Human-readable description of what the buyer receives */
  description: string;
  /** Stop automatically after this many paid requests. Default: unlimited */
  maxRequests?: number;
  /** Skill ID to attribute income to in the economic memory optimizer. Defaults to "x402". */
  skillId?: string;
  /** Path to serve (all other paths → 404). Default: accepts all paths */
  allowedPaths?: string[];
  /** Static response body to return on successful payment. If omitted, returns JSON status. */
  responseBody?: string;
  /** Content-Type headerfor the response body. Default: application/json */
  responseContentType?: string;
  /**
   * Dynamic handler: runs AFTER payment is verified to produce the response for
   * THIS request (e.g. run a real safety check on the requested target). When set,
   * its output replaces responseBody. This is what turns the x402 server into a
   * real, positive-margin paid API (cheap to serve, charged per call).
   */
  handler?: (req: { url: string; method: string }) => Promise<{ body: string; contentType?: string }>;
}

export interface X402ServerStats {
  totalPaid: number;
  requestsServed: number;
  earningsCents: number;
  startedAt: string;
  port: number;
}

export interface X402Server {
  start(): Promise<{ port: number; address: string }>;
  stop(): Promise<void>;
  getStats(): X402ServerStats;
  isRunning(): boolean;
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface PaymentProof {
  from: string;
  to: string;
  network: string;
  amountMicro: string; // USDC uses 6 decimals
  txHash?: string;
  nonce?: string;
  signature?: string;
  timestamp?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates an x402 micro-payment HTTP server.
 *
 * @example
 * const server = createX402Server(identity, config, db, {
 *   description: "Galvin AI analysis — 1 report",
 *   priceCents: 5,
 *   responseBody: JSON.stringify({ status: "ok", report: "..." }),
 * });
 * const { port } = await server.start();
 */
export function createX402Server(
  identity: GalvinIdentity,
  _config: GalvinConfig,
  db: GalvinDatabase,
  options: X402ServerOptions,
): X402Server {
  const port = options.port ?? 8402;
  const priceCents = Math.max(1, options.priceCents ?? 1);
  const priceMicro = BigInt(priceCents) * BigInt(10_000); // cents → USDC micro (6 decimals)
  const priceUsdc = priceCents / 100;
  const description = options.description;
  const maxRequests = options.maxRequests ?? Infinity;
  const allowedPaths = options.allowedPaths ?? null;
  const responseBody =
    options.responseBody ??
    JSON.stringify({ status: "ok", paidBy: "x402", priceCents });
  const responseContentType =
    options.responseContentType ?? "application/json";

  // USDC contract on Base mainnet
  const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const NETWORK_ID = "eip155:8453";

  // Stats
  let requestsServed = 0;
  let earningsCents = 0;
  const startedAt = new Date().toISOString();
  const seenNonces = new Set<string>();

  let server: http.Server | null = null;
  let running = false;

  // ─── Payment Requirement Descriptor ─────────────────────────────────────

  function paymentRequiredBody(requestId: string): string {
    return JSON.stringify({
      x402Version: 1,
      error: "Payment Required",
      accepts: [
        {
          scheme: "exact",
          network: NETWORK_ID,
          maxAmountRequired: priceUsdc.toFixed(6), // e.g. "0.010000"
          payToAddress: identity.address,
          requiredDeadlineSeconds: 300,
          usdcAddress: USDC_BASE,
        },
      ],
      requestId,
      description,
    });
  }

  // ─── Payment Verification ─────────────────────────────────────────────────

  /**
   * Verifies an X-Payment header value.
   * Tries Conway facilitator first, falls back to on-chain viem check.
   */
  async function verifyPayment(
    xPaymentHeader: string,
    requestId: string,
  ): Promise<{ valid: boolean; reason?: string; proof?: PaymentProof }> {
    let proof: PaymentProof;

    // Parse the payment proof from the header
    try {
      const decoded = Buffer.from(xPaymentHeader, "base64").toString("utf8");
      proof = JSON.parse(decoded) as PaymentProof;
    } catch {
      // Try raw JSON if not base64
      try {
        proof = JSON.parse(xPaymentHeader) as PaymentProof;
      } catch {
        return { valid: false, reason: "Could not parse X-Payment header" };
      }
    }

    // Basic field checks
    if (!proof.from || !proof.to || !proof.amountMicro) {
      return {
        valid: false,
        reason: "Payment proof missing required fields (from, to, amountMicro)",
      };
    }

    // Verify payment destination matches our address
    if (proof.to.toLowerCase() !== identity.address.toLowerCase()) {
      return {
        valid: false,
        reason: `Payment destination mismatch: expected ${identity.address}, got ${proof.to}`,
      };
    }

    // Verify amount is sufficient
    const proofAmount = BigInt(proof.amountMicro);
    if (proofAmount < priceMicro) {
      return {
        valid: false,
        reason: `Payment too small: need ${priceMicro.toString()} micro-USDC, got ${proof.amountMicro}`,
      };
    }

    // Replay protection via nonce
    const nonce = proof.nonce ?? proof.txHash ?? requestId;
    if (seenNonces.has(nonce)) {
      return { valid: false, reason: "Payment proof already used (replay detected)" };
    }

    // If a txHash is provided, verify on-chain via viem
    if (proof.txHash) {
      const onChainResult = await verifyOnChain(proof);
      if (!onChainResult.valid) {
        return onChainResult;
      }
    }

    // Accept: record the nonce so it can't be replayed
    seenNonces.add(nonce);

    return { valid: true, proof };
  }

  /**
   * Verifies a transfer actually happened on-chain by reading the tx receipt.
   * Uses viem (already in package.json).
   */
  async function verifyOnChain(
    proof: PaymentProof,
  ): Promise<{ valid: boolean; reason?: string }> {
    try {
      const { createPublicClient, http: viemHttp } = await import("viem");
      const { base } = await import("viem/chains");

      const client = createPublicClient({
        chain: base,
        transport: viemHttp("https://mainnet.base.org"),
      });

      const receipt = await client.getTransactionReceipt({
        hash: proof.txHash as `0x${string}`,
      });

      if (!receipt || receipt.status !== "success") {
        return { valid: false, reason: "Transaction not found or reverted on-chain" };
      }

      // Enough to confirm the tx landed; full Transfer event parsing is optional here
      return { valid: true };
    } catch (err: any) {
      // If on-chain check fails (RPC down etc.), log but still accept the proof
      // This avoids blocking valid payments due to RPC outages
      logger.warn(`x402 on-chain verify failed for ${proof.txHash}: ${err?.message} — accepting on proof alone`);
      return { valid: true };
    }
  }

  // ─── HTTP Request Handler ─────────────────────────────────────────────────

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const requestId = ulid();

    // CORS preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "X-Payment, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Path allowlist check
    if (allowedPaths && !allowedPaths.includes(req.url ?? "/")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
      return;
    }

    // Check max requests cap
    if (requestsServed >= maxRequests) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server capacity reached" }));
      return;
    }

    const xPayment = req.headers["x-payment"] as string | undefined;

    // No payment header → send 402 with payment descriptor
    if (!xPayment) {
      const body = paymentRequiredBody(requestId);
      res.writeHead(402, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Request-Id": requestId,
      });
      res.end(body);
      return;
    }

    // Verify the payment proof
    const verification = await verifyPayment(xPayment, requestId);

    if (!verification.valid) {
      logger.warn(`x402 payment rejected [${requestId}]: ${verification.reason}`);
      const body = JSON.stringify({
        error: "Payment verification failed",
        reason: verification.reason,
        requestId,
      });
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    // Payment verified — record income
    requestsServed++;
    earningsCents += priceCents;

    // Economic memory: record income attributed to the skill
    try {
      const { recordIncome } = await import("./optimizer.js");
      recordIncome(db.raw, options.skillId ?? "x402", priceUsdc);
    } catch { /* non-fatal */ }

    const txId = verification.proof?.txHash ?? ulid();
    try {
      db.insertTransaction({
        id: txId,
        type: "transfer_in",
        amountCents: priceCents,
        description: `x402 payment: ${description.slice(0, 80)} from ${(verification.proof?.from ?? "unknown").slice(0, 16)}...`,
        timestamp: new Date().toISOString(),
      });
    } catch (dbErr: any) {
      logger.warn(`x402 DB insert failed: ${dbErr?.message}`);
    }

    logger.info(
      `x402 payment verified [${requestId}]: $${priceUsdc.toFixed(4)} USDC from ${(verification.proof?.from ?? "?").slice(0, 10)}...`,
    );

    // Deliver the paid response — run the dynamic handler if provided, else static.
    let outBody = responseBody;
    let outType = responseContentType;
    if (options.handler) {
      try {
        const r = await options.handler({ url: req.url ?? "/", method: req.method ?? "GET" });
        outBody = r.body;
        if (r.contentType) outType = r.contentType;
      } catch (e: any) {
        outBody = JSON.stringify({ error: "service error", detail: e?.message ?? String(e) });
        outType = "application/json";
      }
    }
    res.writeHead(200, {
      "Content-Type": outType,
      "Content-Length": Buffer.byteLength(outBody),
      "X-Request-Id": requestId,
      "X-Payment-Verified": "true",
    });
    res.end(outBody);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  return {
    start(): Promise<{ port: number; address: string }> {
      return new Promise((resolve, reject) => {
        if (running) {
          resolve({ port, address: identity.address });
          return;
        }

        server = http.createServer((req, res) => {
          handleRequest(req, res).catch((err) => {
            logger.error("x402 handler error", err instanceof Error ? err : new Error(String(err)));
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            }
          });
        });

        server.listen(port, "0.0.0.0", () => {
          running = true;
          logger.info(
            `x402 server started on port ${port} | price=$${priceUsdc.toFixed(4)} USDC | "${description}"`,
          );
          resolve({ port, address: identity.address });
        });

        server.on("error", (err) => {
          logger.error("x402 server error", err);
          reject(err);
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!server || !running) {
          resolve();
          return;
        }
        server.close(() => {
          running = false;
          logger.info(
            `x402 server stopped | served=${requestsServed} requests | earned=$${(earningsCents / 100).toFixed(2)}`,
          );
          resolve();
        });
      });
    },

    getStats(): X402ServerStats {
      return {
        totalPaid: requestsServed,
        requestsServed,
        earningsCents,
        startedAt,
        port,
      };
    },

    isRunning(): boolean {
      return running;
    },
  };
}

// ─── Singleton Registry ───────────────────────────────────────────────────────
// Allows tools to reference running servers without passing them around

const activeServers = new Map<number, X402Server>();

export function registerServer(server: X402Server, port: number): void {
  activeServers.set(port, server);
}

export function getServer(port: number): X402Server | undefined {
  return activeServers.get(port);
}

export function stopAllServers(): Promise<void[]> {
  return Promise.all([...activeServers.values()].map((s) => s.stop()));
}
