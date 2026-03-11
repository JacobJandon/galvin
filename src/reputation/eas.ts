/**
 * EAS On-Chain Reputation
 *
 * Posts and reads Galvin work attestations via Ethereum Attestation Service on
 * Base mainnet. Each weekly attestation records:
 *   - task count completed
 *   - self-reported satisfaction score (success rate %)
 *   - total USDC earned (× 100 to keep as integer)
 *   - ISO week string (e.g. "2026-W10")
 *
 * Only runs when GALVIN_REPUTATION_ENABLED=1.
 * Gas comes from Galvin's own wallet.
 *
 * NOTE: ethers is loaded via createRequire to avoid TypeScript traversing
 * ethers v6's .d.ts files which import from src.ts/*.ts source files,
 * causing spurious TS2322/TS7016 errors under NodeNext module resolution.
 */

import { createRequire } from "module";
import {
  EAS,
  SchemaEncoder,
  SchemaRegistry,
  NO_EXPIRATION,
} from "@ethereum-attestation-service/eas-sdk";
import { createLogger } from "../observability/logger.js";
import {
  BASE_RPC,
  GALVIN_SCHEMA_DEFINITION,
  getEasContract,
  getEasGraphql,
} from "./schema.js";

const logger = createLogger("reputation.eas");

// Load ethers at runtime without TypeScript traversing its source .ts files
const _require = createRequire(import.meta.url);
function getEthers(): any {
  return _require("ethers");
}

export interface AttestationParams {
  /** Galvin's wallet address (the attesting agent) */
  agentAddress: string;
  /** Private key (hex, with 0x prefix) from ~/.galvin/wallet.json */
  privateKey: string;
  /** Number of tasks completed in this period */
  taskCount: number;
  /** 0–100 success score */
  satisfactionScore: number;
  /** Total USDC earned this period */
  totalUsdc: number;
  /** ISO-8601 week string e.g. "2026-W10" */
  period: string;
  /** EAS schema UID (set GALVIN_EAS_SCHEMA_UID) */
  schemaUid: string;
  /** Network: "base" | "optimism" — default "base" */
  network?: string;
}

export interface ReputationSummary {
  agentAddress: string;
  attestationCount: number;
  totalTaskCount: number;
  avgSatisfactionScore: number;
  totalUsdc: number;
  latestPeriod: string;
  latestUid: string;
}

/**
 * Construct an ethers Wallet (signer + provider) from a private key.
 */
function buildWallet(privateKey: string): any {
  const { ethers } = getEthers();
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  return new ethers.Wallet(privateKey, provider);
}

/**
 * Auto-deploy the Galvin schema to EAS SchemaRegistry on Base.
 * Only called when GALVIN_EAS_SCHEMA_UID is not set.
 * Returns the new schema UID.
 */
export async function deploySchema(privateKey: string): Promise<string> {
  logger.info("Deploying Galvin EAS schema to Base mainnet...");
  const signer = buildWallet(privateKey);
  const registry = new SchemaRegistry("0xA7b39296258348C78294F95B872b282326A97BDF");
  registry.connect(signer);

  const tx = await registry.register({
    schema: GALVIN_SCHEMA_DEFINITION,
    resolverAddress: "0x0000000000000000000000000000000000000000",
    revocable: false,
  });

  const schemaUid = await tx.wait();
  if (!schemaUid) throw new Error("Schema deployment returned no UID");
  logger.info(`Schema deployed: ${schemaUid}`);
  return schemaUid;
}

/**
 * Write an on-chain attestation about Galvin's recent work.
 * Returns the attestation UID.
 */
export async function attest(params: AttestationParams): Promise<string> {
  const network = params.network ?? "base";
  const contractAddress = getEasContract(network);

  const signer = buildWallet(params.privateKey);
  const easInstance = new EAS(contractAddress);
  easInstance.connect(signer);

  const encoder = new SchemaEncoder(GALVIN_SCHEMA_DEFINITION);
  const encodedData = encoder.encodeData([
    { name: "agentAddress",      value: params.agentAddress,                        type: "address" },
    { name: "taskCount",         value: params.taskCount,                           type: "uint32"  },
    { name: "satisfactionScore", value: params.satisfactionScore,                   type: "uint8"   },
    { name: "totalUsdc100ths",   value: BigInt(Math.round(params.totalUsdc * 100)), type: "uint64"  },
    { name: "period",            value: params.period,                              type: "string"  },
  ]);

  const tx = await easInstance.attest({
    schema: params.schemaUid,
    data: {
      recipient:      params.agentAddress,
      expirationTime: NO_EXPIRATION,
      revocable:      false,
      data:           encodedData,
    },
  });

  const uid = await tx.wait();
  if (!uid) throw new Error("Attestation returned no UID");
  logger.info(`[REPUTATION] Attestation posted: ${uid}  period=${params.period}  tasks=${params.taskCount}`);
  return uid;
}

/**
 * Read Galvin's reputation from the EAS GraphQL indexer.
 * Returns a summary across all past attestations for this agent.
 */
export async function getReputation(
  agentAddress: string,
  schemaUid: string,
  network = "base",
): Promise<ReputationSummary | null> {
  const graphqlUrl = getEasGraphql(network);

  const query = `
    query AgentReputation($recipient: String!, $schema: String!) {
      attestations(
        where: {
          recipient: { equals: $recipient }
          schemaId: { equals: $schema }
          revoked: { equals: false }
        }
        orderBy: { time: desc }
        take: 100
      ) {
        id
        time
        decodedDataJson
      }
    }
  `;

  try {
    const res = await fetch(graphqlUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        query,
        variables: { recipient: agentAddress, schema: schemaUid },
      }),
    });

    if (!res.ok) {
      logger.warn(`EAS GraphQL returned ${res.status}`);
      return null;
    }

    const json = (await res.json()) as any;
    const attestations: any[] = json?.data?.attestations ?? [];

    if (attestations.length === 0) return null;

    let totalTasks = 0;
    let totalScore = 0;
    let totalUsdc  = 0;
    let latestPeriod = "";
    let latestUid    = "";

    for (const att of attestations) {
      try {
        const fields: any[] = JSON.parse(att.decodedDataJson ?? "[]");
        const byName = Object.fromEntries(fields.map((f: any) => [f.name, f.value.value]));
        totalTasks += Number(byName.taskCount ?? 0);
        totalScore += Number(byName.satisfactionScore ?? 0);
        totalUsdc  += Number(byName.totalUsdc100ths ?? 0) / 100;
        if (!latestPeriod) {
          latestPeriod = String(byName.period ?? "");
          latestUid    = att.id;
        }
      } catch { /* skip malformed */ }
    }

    return {
      agentAddress,
      attestationCount:     attestations.length,
      totalTaskCount:       totalTasks,
      avgSatisfactionScore: attestations.length > 0 ? Math.round(totalScore / attestations.length) : 0,
      totalUsdc,
      latestPeriod,
      latestUid,
    };
  } catch (err: any) {
    logger.warn(`getReputation failed: ${err?.message}`);
    return null;
  }
}
