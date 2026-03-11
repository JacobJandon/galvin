/**
 * EAS Schema Definition
 *
 * Galvin's on-chain reputation schema deployed to Base mainnet via
 * Ethereum Attestation Service (EAS).
 *
 * Schema fields:
 *   agentAddress  — the attesting agent's wallet address
 *   taskCount     — number of tasks completed in the period
 *   satisfactionScore — 0–100 self-reported success rate
 *   totalUsdc100ths   — total USDC earned × 100 (integer, avoid floats)
 *   period        — ISO-8601 week string (e.g. "2026-W10")
 *
 * Deploy once to Base mainnet:
 *   import { SchemaRegistry } from "@ethereum-attestation-service/eas-sdk";
 *   const registry = new SchemaRegistry(SCHEMA_REGISTRY_BASE);
 *   registry.connect(signer);
 *   const tx = await registry.register({
 *     schema: GALVIN_SCHEMA_DEFINITION,
 *     resolverAddress: "0x0000000000000000000000000000000000000000",
 *     revocable: false,
 *   });
 *   const schemaUid = await tx.wait();
 *
 * Then set GALVIN_EAS_SCHEMA_UID=<uid> in your .galvin config.
 */

// Base mainnet EAS contract address (canonical)
export const EAS_CONTRACT_BASE = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

// Base mainnet SchemaRegistry contract address
export const SCHEMA_REGISTRY_BASE = "0xA7b39296258348C78294F95B872b282326A97BDF";

// Optimism EAS contract (fallback network)
export const EAS_CONTRACT_OPTIMISM = "0x4200000000000000000000000000000000000021";

// EAS GraphQL indexer for Base
export const EAS_GRAPHQL_BASE = "https://base.easscan.org/graphql";

// EAS GraphQL indexer for Optimism
export const EAS_GRAPHQL_OPTIMISM = "https://optimism.easscan.org/optimism/graphql";

// Public Base RPC
export const BASE_RPC = "https://mainnet.base.org";

// Galvin's attestation schema definition string (EAS encoding spec)
export const GALVIN_SCHEMA_DEFINITION =
  "address agentAddress,uint32 taskCount,uint8 satisfactionScore,uint64 totalUsdc100ths,string period";

/**
 * Get the EAS contract address for a given network name.
 */
export function getEasContract(network: string): string {
  if (network === "optimism") return EAS_CONTRACT_OPTIMISM;
  return EAS_CONTRACT_BASE; // default: base
}

/**
 * Get the EAS GraphQL endpoint for a given network name.
 */
export function getEasGraphql(network: string): string {
  if (network === "optimism") return EAS_GRAPHQL_OPTIMISM;
  return EAS_GRAPHQL_BASE;
}
