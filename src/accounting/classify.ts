/**
 * Honest money accounting — one source of truth for what counts as EARNED.
 *
 * The cardinal rule (user, emphatic): Galvin must never report its own money as
 * income. A swap, a bridge/recovery, owner funding, or buying inference credits
 * is NOT earning — only a genuine inbound payment from a third party for value
 * delivered is "earned". Mislabelling funding as income is a fake stat.
 *
 * "Earned" inflow = an inbound USDC transfer whose transaction was initiated by
 * SOMEONE ELSE (a real payer), and not by Galvin itself (its own swap/recovery)
 * and not by its owner (funding). Everything Galvin initiates or its owner sends
 * is neutral repositioning of its own money — the wallet balance already shows it.
 */

export type TxnType =
  | "transfer_in"
  | "transfer_out"
  | "credit_purchase"
  | "topup"
  | "x402_payment"
  | "inference"
  | "tool_use";

export type MoneyClass = "earned" | "spent" | "neutral";

/** Classify a ledger transaction type into earned / spent / neutral. */
export function classifyType(type: string): MoneyClass {
  switch (type) {
    case "transfer_in":
      return "earned"; // genuine external payment (the scanner only books real ones)
    case "transfer_out":
    case "inference":
    case "x402_payment":
    case "tool_use":
    case "credit_purchase": // buying inference credits = spending USDC
    case "topup": // USDC -> credits conversion = USDC leaving the wallet
      return "spent";
    default:
      return "neutral";
  }
}

export const isEarned = (type: string): boolean => classifyType(type) === "earned";
export const isSpent = (type: string): boolean => classifyType(type) === "spent";

const norm = (a?: string | null): string => (a ?? "").toLowerCase();

/**
 * Is an inbound USDC transfer a GENUINE earning?
 * True only when a third party initiated the transaction AND the sender isn't the
 * owner. Self-initiated (Galvin's own swap/recovery) or owner-funded inflows are
 * NOT earnings.
 *
 * @param txInitiator  the `from` of the transaction (who sent/signed it)
 * @param transferFrom the `from` in the ERC-20 Transfer event (token source)
 * @param wallet       Galvin's wallet address
 * @param owner        Galvin's creator/owner address (optional)
 */
export function isEarnedInflow(
  txInitiator: string | null | undefined,
  transferFrom: string | null | undefined,
  wallet: string,
  owner?: string | null,
): boolean {
  const w = norm(wallet);
  const o = norm(owner);
  // Galvin initiated the tx (e.g. a swap whose output lands back to itself): own money.
  if (norm(txInitiator) === w) return false;
  // Token came out of Galvin's own address: own money.
  if (norm(transferFrom) === w) return false;
  // Owner funded it (either as initiator or token source): funding, not earning.
  if (o && (norm(txInitiator) === o || norm(transferFrom) === o)) return false;
  return true;
}
