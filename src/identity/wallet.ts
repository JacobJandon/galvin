/**
 * Galvin Wallet Management
 *
 * Creates and manages an EVM wallet for Galvin's identity and payments.
 * The private key is Galvin's sovereign identity.
 * Adapted from conway-mcp/src/wallet.ts
 */

import type { PrivateKeyAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import fs from "fs";
import path from "path";
import type { WalletData } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("identity.wallet");

const GALVIN_DIR = path.join(
  process.env.HOME || "/root",
  ".galvin",
);
const WALLET_FILE = path.join(GALVIN_DIR, "wallet.json");

export function getGalvinDir(): string {
  return GALVIN_DIR;
}

export function getWalletPath(): string {
  return WALLET_FILE;
}

/**
 * Get or create Galvin's wallet.
 * The private key IS Galvin's identity -- protect it.
 */
export async function getWallet(): Promise<{
  account: PrivateKeyAccount;
  isNew: boolean;
}> {
  if (!fs.existsSync(GALVIN_DIR)) {
    fs.mkdirSync(GALVIN_DIR, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(WALLET_FILE)) {
    const walletData: WalletData = JSON.parse(
      fs.readFileSync(WALLET_FILE, "utf-8"),
    );
    const account = privateKeyToAccount(walletData.privateKey);
    ensureWalletBackup(); // never leave the wallet as a single un-backed-up file
    logger.info("wallet_loaded", { address: account.address });
    return { account, isNew: false };
  } else {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);

    const walletData: WalletData = {
      privateKey,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
      mode: 0o600,
    });

    logger.info("wallet_created", { address: account.address });
    return { account, isNew: true };
  }
}

/**
 * Get the wallet address without loading the full account.
 */
export function getWalletAddress(): string | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );
  const account = privateKeyToAccount(walletData.privateKey);
  return account.address;
}

/**
 * Load the full wallet account (needed for signing).
 */
export function loadWalletAccount(): PrivateKeyAccount | null {
  if (!fs.existsSync(WALLET_FILE)) {
    return null;
  }

  const walletData: WalletData = JSON.parse(
    fs.readFileSync(WALLET_FILE, "utf-8"),
  );
  return privateKeyToAccount(walletData.privateKey);
}

export function walletExists(): boolean {
  return fs.existsSync(WALLET_FILE);
}

/**
 * Copy the wallet file to a backup (0600). Defaults to `wallet.json.bak` next to
 * the wallet. Returns the backup path. Throws if there is no wallet.
 */
export function backupWallet(destPath?: string): string {
  if (!fs.existsSync(WALLET_FILE)) {
    throw new Error("no wallet to back up");
  }
  const dest = destPath ?? path.join(GALVIN_DIR, "wallet.json.bak");
  fs.copyFileSync(WALLET_FILE, dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

/**
 * Ensure a local backup exists (best-effort). Called on boot so the wallet is
 * never a single un-backed-up file. Silent on failure.
 */
export function ensureWalletBackup(): void {
  try {
    const bak = path.join(GALVIN_DIR, "wallet.json.bak");
    if (fs.existsSync(WALLET_FILE) && !fs.existsSync(bak)) backupWallet(bak);
  } catch {
    /* best effort */
  }
}

/**
 * Return the wallet address + private key for OFF-MACHINE backup. Handle with
 * extreme care — anyone with this key controls the wallet and its funds.
 */
export function exportWalletKey(): { address: string; privateKey: string } {
  if (!fs.existsSync(WALLET_FILE)) {
    throw new Error("no wallet to export");
  }
  const walletData: WalletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
  const account = privateKeyToAccount(walletData.privateKey);
  return { address: account.address, privateKey: walletData.privateKey };
}

/**
 * Restore a wallet from a private key. Validates the key first. Refuses to
 * overwrite an existing wallet unless `force` is set, and always backs up any
 * wallet it replaces. Returns the imported address.
 */
export function importWallet(privateKey: string, opts: { force?: boolean } = {}): string {
  const key = privateKey.trim();
  const account = privateKeyToAccount(key as `0x${string}`); // throws on invalid key
  if (!fs.existsSync(GALVIN_DIR)) {
    fs.mkdirSync(GALVIN_DIR, { recursive: true, mode: 0o700 });
  }
  if (fs.existsSync(WALLET_FILE)) {
    if (!opts.force) {
      throw new Error("a wallet already exists — back it up, then re-run with force to overwrite");
    }
    backupWallet(path.join(GALVIN_DIR, `wallet.json.replaced-${Date.now()}`));
  }
  const walletData: WalletData = { privateKey: key as `0x${string}`, createdAt: new Date().toISOString() };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), { mode: 0o600 });
  return account.address;
}
