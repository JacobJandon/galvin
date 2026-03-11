/**
 * Galvin Configuration
 *
 * Loads and saves Galvin's configuration from ~/.galvin/galvin.json
 */

import fs from "fs";
import path from "path";
import type { GalvinConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import type { Address } from "viem";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getGalvinDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "galvin.json";

export function getConfigPath(): string {
  return path.join(getGalvinDir(), CONFIG_FILENAME);
}

/**
 * Load Galvin config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(): GalvinConfig | null {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    // Reputation env-var overrides (can be set in environment instead of config file)
    const reputationEnabled =
      process.env.GALVIN_REPUTATION_ENABLED === "1" ||
      raw.reputationEnabled === true;
    const easNetwork =
      process.env.GALVIN_EAS_NETWORK || raw.easNetwork || "base";
    const easSchemaUid =
      process.env.GALVIN_EAS_SCHEMA_UID || raw.easSchemaUid;

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      reputationEnabled,
      easNetwork,
      ...(easSchemaUid ? { easSchemaUid } : {}),
    } as GalvinConfig;
  } catch {
    return null;
  }
}

/**
 * Save Galvin config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: GalvinConfig): void {
  const dir = getGalvinDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: Address;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: Address;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: Address;
  treasuryPolicy?: TreasuryPolicy;
}): GalvinConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.galvin/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.galvin/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as GalvinConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.galvin/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
  };
}
