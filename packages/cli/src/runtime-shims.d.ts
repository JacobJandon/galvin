declare module "galvin/config.js" {
  export interface GalvinCliConfig {
    name: string;
    walletAddress: string;
    creatorAddress: string;
    sandboxId: string;
    dbPath: string;
    inferenceModel: string;
    conwayApiUrl: string;
    conwayApiKey: string;
    openaiApiKey?: string;
    anthropicApiKey?: string;
    socialRelayUrl?: string;
  }

  export function loadConfig(): GalvinCliConfig | null;
  export function resolvePath(p: string): string;
}

declare module "galvin/state/database.js" {
  export interface CliToolCall {
    name: string;
    result: string;
    error?: string;
  }

  export interface CliTurn {
    id: string;
    timestamp: string;
    state: string;
    input?: string;
    inputSource?: string;
    thinking: string;
    toolCalls: CliToolCall[];
    tokenUsage: { totalTokens: number };
    costCents: number;
  }

  export interface CliHeartbeatEntry {
    enabled: boolean;
  }

  export interface CliInstalledTool {
    id: string;
    name: string;
  }

  export interface GalvinCliDatabase {
    getAgentState(): string;
    getTurnCount(): number;
    getInstalledTools(): CliInstalledTool[];
    getHeartbeatEntries(): CliHeartbeatEntry[];
    getRecentTurns(limit: number): CliTurn[];
    close(): void;
  }

  export function createDatabase(path: string): GalvinCliDatabase;
}
