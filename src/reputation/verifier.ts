/**
 * EAS Attestation Verifier
 *
 * Verifies that a specific attestation UID exists on-chain and belongs to
 * the given recipient. Used to validate agent cards from other Galvin nodes.
 *
 * NOTE: ethers is loaded via createRequire to avoid TypeScript traversing
 * ethers v6's .d.ts files which reference src.ts/*.ts source files.
 */

import { createRequire } from "module";
import { EAS } from "@ethereum-attestation-service/eas-sdk";
import { createLogger } from "../observability/logger.js";
import { BASE_RPC, getEasContract } from "./schema.js";

const logger = createLogger("reputation.verifier");
const _require = createRequire(import.meta.url);

/**
 * Verify that an attestation UID exists, is not revoked, and belongs to
 * the given agentAddress.
 */
export async function verifyAttestation(
  uid: string,
  agentAddress: string,
  network = "base",
): Promise<boolean> {
  try {
    const contractAddress = getEasContract(network);
    const { ethers } = _require("ethers") as any;
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const easInstance = new EAS(contractAddress);
    easInstance.connect(provider);

    const att = await easInstance.getAttestation(uid);
    if (!att) return false;

    const isRevoked   = att.revocationTime > 0n;
    const isRecipient = att.recipient.toLowerCase() === agentAddress.toLowerCase();

    if (isRevoked) {
      logger.debug(`Attestation ${uid} is revoked`);
      return false;
    }
    if (!isRecipient) {
      logger.debug(`Attestation ${uid} recipient mismatch`);
      return false;
    }

    return true;
  } catch (err: any) {
    logger.warn(`verifyAttestation failed: ${err?.message}`);
    return false;
  }
}
