/**
 * Agent Card
 *
 * Generates and manages the agent's self-description card.
 * This is the JSON document pointed to by the ERC-8004 agentURI.
 * Can be hosted on IPFS or served at /.well-known/agent-card.json
 *
 * Phase 3.2: Fixed code injection in hostAgentCard (S-P0-3),
 * removed internal details from card (S-P1-10),
 * added CORS headers and Content-Type.
 */

import type {
  AgentCard,
  AgentService,
  GalvinConfig,
  GalvinIdentity,
  GalvinDatabase,
  ConwayClient,
} from "../types.js";
import { createLogger } from "../observability/logger.js";

const AGENT_CARD_TYPE =
  "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const logger = createLogger("registry.agent-card");

/**
 * Generate an agent card from Galvin's current state.
 *
 * Phase 3.2: Only expose agentWallet service, name, generic description,
 * x402Support, and active status. Do NOT include:
 * - Conway API URL (internal infrastructure)
 * - Sandbox ID (internal identifier)
 * - Creator address (privacy)
 *
 * Feature 2: If reputationEnabled, fetches on-chain EAS summary and
 * attaches it to the card.
 */
export async function generateAgentCard(
  identity: GalvinIdentity,
  config: GalvinConfig,
  _db: GalvinDatabase,
): Promise<AgentCard> {
  // Core service: wallet address for x402 payments and ERC-8004 identity
  const services: AgentService[] = [
    {
      name: "agentWallet",
      endpoint: `eip155:8453:${identity.address}`,
      description: "Wallet for USDC x402 micropayments on Base L2",
      serviceType: "wallet",
    },
  ];

  // Advertise published x402 skills so other agents can discover and buy them.
  // This is the core Web4 agent-to-agent commerce discovery layer.
  try {
    const listings = _db.raw
      .prepare("SELECT name, description, price_cents, listing_url FROM marketplace_listings ORDER BY published_at DESC LIMIT 20")
      .all() as Array<{ name: string; description: string; price_cents: number; listing_url: string }>;
    for (const listing of listings) {
      services.push({
        name: listing.name,
        endpoint: listing.listing_url,
        description: listing.description,
        priceCentsUsdc: listing.price_cents,
        serviceType: "x402_skill",
      });
    }
  } catch { /* marketplace_listings table may not exist in older schemas */ }

  // Phase 3.2: Generic description, no internal details
  const description = `Autonomous agent: ${config.name}`;

  const card: AgentCard = {
    type: AGENT_CARD_TYPE,
    name: config.name,
    description,
    services,
    x402Support: true,
    active: true,
  };

  // Feature 2: Attach on-chain reputation if enabled
  if (config.reputationEnabled && config.easSchemaUid) {
    try {
      const { getReputation } = await import("../reputation/eas.js");
      const rep = await getReputation(
        identity.address,
        config.easSchemaUid,
        config.easNetwork ?? "base",
      );
      if (rep) {
        card.reputation = {
          attestationCount:     rep.attestationCount,
          avgSatisfactionScore: rep.avgSatisfactionScore,
          totalTaskCount:       rep.totalTaskCount,
          totalUsdc:            rep.totalUsdc,
          latestPeriod:         rep.latestPeriod,
          latestUid:            rep.latestUid,
        };
      }
    } catch (err: any) {
      logger.warn(`Could not fetch EAS reputation for card: ${err?.message}`);
    }
  }

  return card;
}

/**
 * Serialize agent card to JSON string.
 */
export function serializeAgentCard(card: AgentCard): string {
  return JSON.stringify(card, null, 2);
}

/**
 * Host the agent card at /.well-known/agent-card.json
 * by exposing a simple HTTP server on a port.
 *
 * Phase 3.2: CRITICAL FIX (S-P0-3) — Write card as a SEPARATE JSON file.
 * Server script reads the file at request time, NOT interpolated into JS.
 * Added CORS headers and X-Content-Type-Options: nosniff.
 */
export async function hostAgentCard(
  card: AgentCard,
  conway: ConwayClient,
  port: number = 8004,
): Promise<string> {
  const cardJson = serializeAgentCard(card);

  // Phase 3.2: Write card as a separate JSON file (not interpolated into JS)
  await conway.writeFile("/tmp/agent-card.json", cardJson);

  // Phase 3.2: Server reads the file at request time
  const serverScript = `
const http = require('http');
const fs = require('fs');
const path = '/tmp/agent-card.json';

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/.well-known/agent-card.json' || req.url === '/agent-card.json') {
    try {
      const data = fs.readFileSync(path, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

server.listen(${port}, () => console.log('Agent card server on port ' + ${port}));
`;

  await conway.writeFile("/tmp/agent-card-server.js", serverScript);

  // Start server in background
  await conway.exec(
    `node /tmp/agent-card-server.js &`,
    5000,
  );

  // Expose port
  const portInfo = await conway.exposePort(port);

  return `${portInfo.publicUrl}/.well-known/agent-card.json`;
}

/**
 * Write agent card to the state directory for git versioning.
 */
export async function saveAgentCard(
  card: AgentCard,
  conway: ConwayClient,
): Promise<void> {
  const cardJson = serializeAgentCard(card);
  const home = process.env.HOME || "/root";
  await conway.writeFile(`${home}/.galvin/agent-card.json`, cardJson);
}
