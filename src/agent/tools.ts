/**
 * Galvin Tool System
 *
 * Defines all tools Galvin can call, with self-preservation guards.
 * Tools are organized by category and exposed to the inference model.
 */

import nodePath from "node:path";
import { ulid } from "ulid";
import type {
  GalvinTool,
  ToolContext,
  ToolCategory,
  InferenceToolDefinition,
  ToolCallResult,
  GenesisConfig,
  RiskLevel,
  PolicyRequest,
  InputSource,
  SpendTrackerInterface,
} from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { sanitizeToolResult, sanitizeInput } from "./injection-defense.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("tools");

// ─── Path Confinement ─────────────────────────────────────────
// write_file is restricted to the sandbox home directory tree.
// The sandbox home is /root for both local and remote execution.
const SANDBOX_HOME = "/root";

/**
 * Validate that a file path resolves to within the allowed root directory.
 * Returns the resolved absolute path, or an error string if out of bounds.
 */
function confinePathToSandbox(filePath: string): string | { error: string } {
  // Resolve ~ to SANDBOX_HOME
  const expanded = filePath.startsWith("~")
    ? nodePath.join(SANDBOX_HOME, filePath.slice(1))
    : filePath;
  // Resolve to absolute (relative paths resolve against SANDBOX_HOME)
  const resolved = nodePath.resolve(SANDBOX_HOME, expanded);
  // Ensure the resolved path is within the sandbox home
  if (resolved !== SANDBOX_HOME && !resolved.startsWith(SANDBOX_HOME + "/")) {
    return {
      error: `Blocked: write_file path "${filePath}" resolves to "${resolved}" which is outside the allowed directory (${SANDBOX_HOME}). Writes are confined to the sandbox home.`,
    };
  }
  return resolved;
}

// Tools whose results come from external sources and need sanitization
const EXTERNAL_SOURCE_TOOLS = new Set([
  "exec",
  "web_fetch",
  "check_social_inbox",
]);

// ─── Self-Preservation Guard ───────────────────────────────────
// Defense-in-depth: policy engine (command.forbidden_patterns rule) is the primary guard.
// This inline check is kept as a secondary safety net in case the policy engine is bypassed.

const FORBIDDEN_COMMAND_PATTERNS = [
  // Self-destruction
  /rm\s+(-rf?\s+)?.*\.galvin/,
  /rm\s+(-rf?\s+)?.*state\.db/,
  /rm\s+(-rf?\s+)?.*wallet\.json/,
  /rm\s+(-rf?\s+)?.*galvin\.json/,
  /rm\s+(-rf?\s+)?.*heartbeat\.yml/,
  /rm\s+(-rf?\s+)?.*SOUL\.md/,
  // Process killing
  /kill\s+.*galvin/,
  /pkill\s+.*galvin/,
  /systemctl\s+(stop|disable)\s+galvin/,
  // Database destruction
  /DROP\s+TABLE/i,
  /DELETE\s+FROM\s+(turns|identity|kv|schema_version|skills|children|registry)/i,
  /TRUNCATE/i,
  // Safety infrastructure modification via shell
  /sed\s+.*injection-defense/,
  /sed\s+.*self-mod\/code/,
  /sed\s+.*audit-log/,
  />\s*.*injection-defense/,
  />\s*.*self-mod\/code/,
  />\s*.*audit-log/,
  // Credential harvesting
  /cat\s+.*\.ssh/,
  /cat\s+.*\.gnupg/,
  /cat\s+.*\.env/,
  /cat\s+.*wallet\.json/,
];

function isForbiddenCommand(command: string, sandboxId: string): string | null {
  for (const pattern of FORBIDDEN_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked: Command matches self-harm pattern: ${pattern.source}`;
    }
  }

  // Block deleting own sandbox
  if (command.includes("sandbox_delete") && command.includes(sandboxId)) {
    return "Blocked: Cannot delete own sandbox";
  }

  return null;
}

// ─── Built-in Tools ────────────────────────────────────────────

export function createBuiltinTools(sandboxId: string): GalvinTool[] {
  return [
    // ── VM/Sandbox Tools ──
    {
      name: "exec",
      description:
        "Execute a shell command in your sandbox. Returns stdout, stderr, and exit code.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 30000)",
          },
        },
        required: ["command"],
      },
      execute: async (args, ctx) => {
        const command = args.command as string;
        const forbidden = isForbiddenCommand(command, ctx.identity.sandboxId);
        if (forbidden) return forbidden;

        const result = await ctx.conway.exec(
          command,
          (args.timeout as number) || 30000,
        );
        return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
      },
    },
    {
      name: "write_file",
      description: "Write content to a file in your sandbox.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Path confinement: restrict writes to sandbox home directory
        const confined = confinePathToSandbox(filePath);
        if (typeof confined === "object") return confined.error;
        // Guard against overwriting protected files (same check as edit_own_file)
        const { isProtectedFile } = await import("../self-mod/code.js");
        if (isProtectedFile(confined)) {
          return "Blocked: Cannot overwrite protected file. This is a hard-coded safety invariant.";
        }
        await ctx.conway.writeFile(confined, args.content as string);
        return `File written: ${confined}`;
      },
    },
    {
      name: "read_file",
      description: "Read content from a file in your sandbox.",
      category: "vm",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const filePath = args.path as string;
        // Block reads of sensitive files (wallet, env, config secrets)
        const basename = filePath.split("/").pop() || "";
        const sensitiveFiles = ["wallet.json", ".env", "galvin.json"];
        const sensitiveExtensions = [".key", ".pem"];
        if (
          sensitiveFiles.includes(basename) ||
          sensitiveExtensions.some((ext) => basename.endsWith(ext)) ||
          basename.startsWith("private-key")
        ) {
          return "Blocked: Cannot read sensitive file. This protects credentials and secrets.";
        }
        try {
          return await ctx.conway.readFile(filePath);
        } catch {
          // Conway files/read API may be broken — fall back to exec(cat)
          const result = await ctx.conway.exec(
            `cat ${escapeShellArg(filePath)}`,
            30_000,
          );
          if (result.exitCode !== 0) {
            return `ERROR: File not found or not readable: ${filePath}`;
          }
          return result.stdout;
        }
      },
    },
    {
      name: "expose_port",
      description:
        "Expose a port from your sandbox to the internet. Returns a public URL.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to expose" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        const info = await ctx.conway.exposePort(args.port as number);
        return `Port ${info.port} exposed at: ${info.publicUrl}`;
      },
    },
    {
      name: "remove_port",
      description: "Remove a previously exposed port.",
      category: "vm",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          port: { type: "number", description: "Port number to remove" },
        },
        required: ["port"],
      },
      execute: async (args, ctx) => {
        await ctx.conway.removePort(args.port as number);
        return `Port ${args.port} removed`;
      },
    },

    // ── Network Tools ──
    {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content as plain text. HTML is stripped to readable text. " +
        "Blocks private/internal IPs (SSRF protection). Use this to read web pages, REST APIs, " +
        "documentation, or any public URL. For JSON APIs the raw JSON is returned. Max 50KB.",
      category: "network",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch (must be http:// or https://)",
          },
          timeout: {
            type: "number",
            description: "Timeout in milliseconds (default: 15000, max: 30000)",
          },
        },
        required: ["url"],
      },
      execute: async (args, _ctx) => {
        const url = args.url as string;
        const timeout = Math.min((args.timeout as number) || 15_000, 30_000);

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return "Error: Only http:// and https:// URLs are supported.";
        }

        // SSRF protection
        try {
          const parsed = new URL(url);
          const hostname = parsed.hostname.toLowerCase();
          const BLOCKED = [
            /^localhost$/,
            /^127\./,
            /^10\./,
            /^172\.(1[6-9]|2\d|3[01])\./,
            /^192\.168\./,
            /^169\.254\./,
            /^::1$/,
            /^fc00:/,
            /^fe80:/,
            /^0\.0\.0\.0$/,
          ];
          if (BLOCKED.some((p) => p.test(hostname))) {
            return `Error: Blocked — "${hostname}" is a private/internal address (SSRF protection).`;
          }
        } catch {
          return "Error: Invalid URL.";
        }

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);
          const response = await fetch(url, {
            signal: controller.signal,
            headers: { "User-Agent": "Galvin/0.3 (Solvatron AI Agent)" },
          });
          clearTimeout(timer);

          const contentType = response.headers.get("content-type") || "";
          const rawText = await response.text();

          const MAX_CHARS = 50_000;
          const truncated =
            rawText.length > MAX_CHARS
              ? rawText.slice(0, MAX_CHARS) +
                `\n\n[TRUNCATED: ${rawText.length - MAX_CHARS} chars omitted]`
              : rawText;

          if (contentType.includes("text/html")) {
            const stripped = truncated
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/\s{3,}/g, "\n\n")
              .trim();
            return `HTTP ${response.status} ${response.statusText}\nURL: ${url}\n\n${stripped}`;
          }

          return `HTTP ${response.status} ${response.statusText}\nURL: ${url}\n\n${truncated}`;
        } catch (err: any) {
          if (err?.name === "AbortError") {
            return `Error: Request timed out after ${timeout}ms`;
          }
          return `Error: ${err?.message || String(err)}`;
        }
      },
    },
    {
      name: "llm_subtask",
      description:
        "Run a focused LLM sub-call for a specific task: extract structured data, " +
        "summarize long text, analyze content, or generate a code snippet. " +
        "Returns the model response as a string. " +
        "Set expectJson=true to validate the response as JSON.",
      category: "memory",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The exact task instruction for the sub-agent.",
          },
          content: {
            type: "string",
            description: "Content to process (webpage text, data, etc.). Optional.",
          },
          expectJson: {
            type: "boolean",
            description: "If true, validate the response as JSON. Default: false.",
          },
          maxTokens: {
            type: "number",
            description: "Max tokens for the response. Default: 1000.",
          },
        },
        required: ["prompt"],
      },
      execute: async (args, ctx) => {
        const prompt = args.prompt as string;
        const content = args.content as string | undefined;
        const expectJson = Boolean(args.expectJson);
        const maxTokens = Math.min((args.maxTokens as number) || 1000, 4096);

        const userMessage = content
          ? `${prompt}\n\n---\nContent to process:\n${content.slice(0, 30_000)}`
          : prompt;

        try {
          const response = await ctx.inference.chat(
            [
              {
                role: "system",
                content: expectJson
                  ? "You are a data extraction assistant. Respond ONLY with valid JSON, no markdown, no explanation."
                  : "You are a focused assistant. Be concise and accurate.",
              },
              { role: "user", content: userMessage },
            ],
            { maxTokens, temperature: 0.1 },
          );

          const text = response.message.content.trim();

          if (expectJson) {
            try {
              JSON.parse(text);
              return text;
            } catch {
              return `Error: Model did not return valid JSON.\n\nRaw response:\n${text}`;
            }
          }

          return text;
        } catch (err: any) {
          return `Error in llm_subtask: ${err?.message || String(err)}`;
        }
      },
    },
    {
      name: "schedule_task",
      description:
        "Schedule a heartbeat task to run at a specific time or on a recurring interval. " +
        "The task_name must match an existing BUILTIN_TASKS key (e.g. 'check_credits'). " +
        "Provide run_at (ISO-8601 datetime) for a one-shot task, or interval_ms for recurring.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          task_name: {
            type: "string",
            description: "Heartbeat task name (must be a BUILTIN_TASKS key)",
          },
          run_at: {
            type: "string",
            description: "ISO-8601 datetime for one-shot execution, e.g. '2026-03-15T09:00:00Z'",
          },
          interval_ms: {
            type: "number",
            description: "Recurring interval in milliseconds (e.g. 3600000 for hourly)",
          },
          enabled: {
            type: "boolean",
            description: "Enable this task immediately. Default: true.",
          },
        },
        required: ["task_name"],
      },
      execute: async (args, ctx) => {
        const taskName = args.task_name as string;
        const runAt = args.run_at as string | undefined;
        const intervalMs = args.interval_ms as number | undefined;
        const enabled = args.enabled !== false ? 1 : 0;

        if (!runAt && !intervalMs) {
          return "Error: Provide either run_at (ISO-8601 datetime) or interval_ms.";
        }

        if (runAt) {
          const parsed = Date.parse(runAt);
          if (Number.isNaN(parsed)) {
            return `Error: Invalid ISO-8601 datetime: "${runAt}"`;
          }
        }

        try {
          ctx.db.raw
            .prepare(
              `INSERT INTO heartbeat_schedule
                (task_name, cron_expression, interval_ms, enabled, next_run_at)
               VALUES (?, NULL, ?, ?, ?)
               ON CONFLICT(task_name) DO UPDATE SET
                 interval_ms = excluded.interval_ms,
                 enabled = excluded.enabled,
                 next_run_at = excluded.next_run_at`,
            )
            .run(taskName, intervalMs ?? null, enabled, runAt ?? null);

          const summary = runAt
            ? `one-shot at ${runAt}`
            : `every ${((intervalMs as number) / 1000).toFixed(0)}s`;
          return `Scheduled task "${taskName}" (${summary}, enabled=${Boolean(enabled)}).`;
        } catch (err: any) {
          return `Error scheduling task: ${err?.message || String(err)}`;
        }
      },
    },

    // ── Conway API Tools ──
    {
      name: "check_credits",
      description: "Check your current Conway compute credit balance.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const balance = await ctx.conway.getCreditsBalance();
        return `Credit balance: $${(balance / 100).toFixed(2)} (${balance} cents)`;
      },
    },
    {
      name: "check_usdc_balance",
      description: "Check your on-chain USDC balance on Base.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../conway/x402.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        return `USDC balance: ${balance.toFixed(6)} USDC on Base`;
      },
    },
    {
      name: "topup_credits",
      description:
        "Buy Conway compute credits by paying USDC from your wallet via x402. Valid tier amounts: $5, $25, $100, $500, $1000, $2500. Check your USDC balance first with check_usdc_balance.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          amount_usd: {
            type: "number",
            description:
              "Amount in USD to spend on credits. Must be one of the valid tiers: 5, 25, 100, 500, 1000, 2500.",
          },
        },
        required: ["amount_usd"],
      },
      execute: async (args, ctx) => {
        const { topupCredits, TOPUP_TIERS } =
          await import("../conway/topup.js");
        const amountUsd = args.amount_usd as number;

        if (!TOPUP_TIERS.includes(amountUsd)) {
          return `Invalid tier. Valid amounts (USD): ${TOPUP_TIERS.join(", ")}`;
        }

        // Check USDC balance first
        const { getUsdcBalance } = await import("../conway/x402.js");
        const usdcBalance = await getUsdcBalance(ctx.identity.address);
        if (usdcBalance < amountUsd) {
          return `Insufficient USDC. Balance: $${usdcBalance.toFixed(2)}, requested: $${amountUsd}. Choose a smaller tier or wait for funding.`;
        }

        const result = await topupCredits(
          ctx.config.conwayApiUrl,
          ctx.identity.account,
          amountUsd,
        );

        if (!result.success) {
          return `Credit topup failed: ${result.error}`;
        }

        // Record transaction
        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "credit_purchase",
          amountCents: amountUsd * 100,
          balanceAfterCents: result.creditsCentsAdded,
          description: `x402 credit topup: $${amountUsd} USD`,
          timestamp: new Date().toISOString(),
        });

        return `Credit topup successful: +$${amountUsd} (${amountUsd * 100} cents) credits purchased via x402. Check your new balance with check_credits.`;
      },
    },
    {
      name: "create_sandbox",
      description:
        "Create a new Conway sandbox (separate VM) for sub-tasks or testing.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Sandbox name" },
          vcpu: { type: "number", description: "vCPUs (default: 1)" },
          memory_mb: {
            type: "number",
            description: "Memory in MB (default: 512)",
          },
          disk_gb: {
            type: "number",
            description: "Disk in GB (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const info = await ctx.conway.createSandbox({
          name: args.name as string,
          vcpu: args.vcpu as number,
          memoryMb: args.memory_mb as number,
          diskGb: args.disk_gb as number,
        });
        return `Sandbox created: ${info.id} (${info.vcpu} vCPU, ${info.memoryMb}MB RAM)`;
      },
    },
    {
      name: "delete_sandbox",
      description: "Delete a sandbox. Note: sandbox deletion is currently disabled by the Conway API.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          sandbox_id: {
            type: "string",
            description: "ID of sandbox to delete",
          },
        },
        required: ["sandbox_id"],
      },
      execute: async () => {
        return "Sandbox deletion is disabled. Sandboxes are prepaid and non-refundable.";
      },
    },
    {
      name: "list_sandboxes",
      description: "List all your sandboxes.",
      category: "conway",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const sandboxes = await ctx.conway.listSandboxes();
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map(
            (s) =>
              `${s.id} [${s.status}] ${s.vcpu}vCPU/${s.memoryMb}MB ${s.region}`,
          )
          .join("\n");
      },
    },

    // ── Self-Modification Tools ──
    {
      name: "edit_own_file",
      description:
        "Edit a file in your own codebase. Changes are audited, rate-limited, and safety-checked. Some files are protected.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit" },
          content: { type: "string", description: "New file content" },
          description: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["path", "content", "description"],
      },
      execute: async (args, ctx) => {
        const { editFile, validateModification } =
          await import("../self-mod/code.js");
        const filePath = args.path as string;
        const content = args.content as string;

        // Pre-validate before attempting
        const validation = validateModification(
          ctx.db,
          filePath,
          content.length,
        );
        if (!validation.allowed) {
          return `BLOCKED: ${validation.reason}\nChecks: ${validation.checks.map((c) => `${c.name}: ${c.passed ? "PASS" : "FAIL"} (${c.detail})`).join(", ")}`;
        }

        const result = await editFile(
          ctx.conway,
          ctx.db,
          filePath,
          content,
          args.description as string,
        );

        if (!result.success) {
          return result.error || "Unknown error during file edit";
        }

        const msg = `File edited: ${filePath} (audited + git-committed)`;
        return result.error ? `${msg}\nWarning: ${result.error}` : msg;
      },
    },
    {
      name: "revert_last_edit",
      description:
        "Revert the last self-modification. Uses git to undo the most recent code change and rebuild.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        // Show what we're reverting
        const lastCommit = await ctx.conway.exec(
          `cd '${repoRoot}' && git log -1 --oneline`,
          10_000,
        );

        // Revert
        const result = await ctx.conway.exec(
          `cd '${repoRoot}' && git revert HEAD --no-edit`,
          30_000,
        );
        if (result.exitCode !== 0) {
          return `Revert failed: ${result.stderr}`;
        }

        // Rebuild
        const build = await ctx.conway.exec(
          `cd '${repoRoot}' && npm run build`,
          60_000,
        );

        // Audit log
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "code_revert", `Reverted: ${lastCommit.stdout.trim()}`, {
          reversible: true,
        });

        return `Reverted: ${lastCommit.stdout.trim()}. ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "reset_to_upstream",
      description:
        "Reset your codebase to the official upstream release. Use when self-modifications have broken things beyond repair.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const repoRoot = process.cwd();

        // Fetch latest upstream
        const fetch = await ctx.conway.exec(
          `cd '${repoRoot}' && git fetch origin main`,
          30_000,
        );
        if (fetch.exitCode !== 0) {
          return `Failed to fetch upstream: ${fetch.stderr}`;
        }

        // Record what we're about to lose
        const localCommits = await ctx.conway.exec(
          `cd '${repoRoot}' && git log origin/main..HEAD --oneline`,
          10_000,
        );

        // Hard reset
        const reset = await ctx.conway.exec(
          `cd '${repoRoot}' && git reset --hard origin/main`,
          30_000,
        );
        if (reset.exitCode !== 0) {
          return `Reset failed: ${reset.stderr}`;
        }

        // Reinstall + rebuild
        const build = await ctx.conway.exec(
          `cd '${repoRoot}' && npm install && npm run build`,
          120_000,
        );

        // Audit log
        const { logModification } = await import("../self-mod/audit-log.js");
        logModification(ctx.db, "upstream_reset", "Reset to upstream origin/main", {
          diff: localCommits.stdout.trim() || "(no local commits)",
          reversible: false,
        });

        const discarded = localCommits.stdout.trim();
        return `Reset to upstream. ${discarded ? "Discarded local commits:\n" + discarded : "No local commits lost."} ${build.exitCode === 0 ? "Rebuild succeeded." : "Rebuild failed: " + build.stderr}`;
      },
    },
    {
      name: "install_npm_package",
      description: "Install an npm package in your environment.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          package: {
            type: "string",
            description: "Package name (e.g., axios)",
          },
        },
        required: ["package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        // Defense-in-depth: validate package name inline in case the
        // policy engine's validate.package_name rule is bypassed.
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "tool_install",
          description: `Installed npm package: ${pkg}`,
          reversible: true,
        });

        return result.exitCode === 0
          ? `Installed: ${pkg}`
          : `Failed to install ${pkg}: ${result.stderr}`;
      },
    },
    // ── Self-Mod: Upstream Awareness ──
    {
      name: "review_upstream_changes",
      description:
        "ALWAYS call this before pull_upstream. Shows every upstream commit with its full diff. Read each one carefully — decide per-commit whether to accept or skip. Use pull_upstream with a specific commit hash to cherry-pick only what you want.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, _ctx) => {
        const { getUpstreamDiffs, checkUpstream } =
          await import("../self-mod/upstream.js");
        const status = checkUpstream();
        if (status.behind === 0) return "Already up to date with origin/main.";

        const diffs = getUpstreamDiffs();
        if (diffs.length === 0) return "No upstream diffs found.";

        const output = diffs
          .map(
            (d, i) =>
              `--- COMMIT ${i + 1}/${diffs.length} ---\nHash: ${d.hash}\nAuthor: ${d.author}\nMessage: ${d.message}\n\n${d.diff.slice(0, 4000)}${d.diff.length > 4000 ? "\n... (diff truncated)" : ""}\n--- END COMMIT ${i + 1} ---`,
          )
          .join("\n\n");

        return `${diffs.length} upstream commit(s) to review. Read each diff, then cherry-pick individually with pull_upstream(commit=<hash>).\n\n${output}`;
      },
    },
    {
      name: "pull_upstream",
      description:
        "Apply upstream changes and rebuild. You MUST call review_upstream_changes first. Prefer cherry-picking individual commits by hash over pulling everything — only pull all if you've reviewed every commit and want them all.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          commit: {
            type: "string",
            description:
              "Commit hash to cherry-pick (preferred). Omit ONLY if you reviewed all commits and want every one.",
          },
        },
      },
      execute: async (args, ctx) => {
        const commit = args.commit as string | undefined;

        // Run git commands inside sandbox via conway.exec()
        const run = async (cmd: string) => {
          const result = await ctx.conway.exec(cmd, 120_000);
          if (result.exitCode !== 0) {
            throw new Error(
              result.stderr ||
                `Command failed with exit code ${result.exitCode}`,
            );
          }
          return result.stdout.trim();
        };

        let appliedSummary: string;
        try {
          if (commit) {
            await run(`git cherry-pick ${commit}`);
            appliedSummary = `Cherry-picked ${commit}`;
          } else {
            await run("git pull origin main --ff-only");
            appliedSummary = "Pulled all of origin/main (fast-forward)";
          }
        } catch (err: any) {
          return `Git operation failed: ${err.message}. You may need to resolve conflicts manually.`;
        }

        // Rebuild
        try {
          await run("npm install --ignore-scripts && npm run build");
        } catch (err: any) {
          return `${appliedSummary} — but rebuild failed: ${err.message}. The code is applied but not compiled.`;
        }

        // Log modification
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "upstream_pull",
          description: appliedSummary,
          reversible: true,
        });

        return `${appliedSummary}. Rebuild succeeded.`;
      },
    },

    {
      name: "modify_heartbeat",
      description: "Add, update, or remove a heartbeat entry.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "add, update, or remove",
          },
          name: { type: "string", description: "Entry name" },
          schedule: {
            type: "string",
            description: "Cron expression (for add/update)",
          },
          task: {
            type: "string",
            description: "Task name (for add/update)",
          },
          enabled: { type: "boolean", description: "Enable/disable" },
        },
        required: ["action", "name"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const name = args.name as string;

        if (action === "remove") {
          ctx.db.upsertHeartbeatEntry({
            name,
            schedule: "",
            task: "",
            enabled: false,
          });
          return `Heartbeat entry '${name}' disabled`;
        }

        ctx.db.upsertHeartbeatEntry({
          name,
          schedule: (args.schedule as string) || "0 * * * *",
          task: (args.task as string) || name,
          enabled: args.enabled !== false,
        });

        const { ulid } = await import("ulid");
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "heartbeat_change",
          description: `${action} heartbeat: ${name} (${args.schedule || "default"})`,
          reversible: true,
        });

        return `Heartbeat entry '${name}' ${action}d`;
      },
    },

    // ── Survival Tools ──
    {
      name: "sleep",
      description:
        "Enter sleep mode for a specified duration. Heartbeat continues running.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          duration_seconds: {
            type: "number",
            description: "How long to sleep in seconds",
          },
          reason: {
            type: "string",
            description: "Why you are sleeping",
          },
        },
        required: ["duration_seconds"],
      },
      execute: async (args, ctx) => {
        const duration = args.duration_seconds as number;
        const reason = (args.reason as string) || "No reason given";
        ctx.db.setAgentState("sleeping");
        ctx.db.setKV(
          "sleep_until",
          new Date(Date.now() + duration * 1000).toISOString(),
        );
        ctx.db.setKV("sleep_reason", reason);
        return `Entering sleep mode for ${duration}s. Reason: ${reason}. Heartbeat will continue.`;
      },
    },
    {
      name: "system_synopsis",
      description:
        "Get a system status report: state, installed tools, heartbeat status, turn count.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const tools = ctx.db.getInstalledTools();
        const heartbeats = ctx.db.getHeartbeatEntries();
        const turns = ctx.db.getTurnCount();
        const state = ctx.db.getAgentState();

        return `=== SYSTEM SYNOPSIS ===
Name: ${ctx.config.name}
Creator: ${ctx.config.creatorAddress}
State: ${state}
Total turns: ${turns}
Installed tools: ${tools.length}
Active heartbeats: ${heartbeats.filter((h) => h.enabled).length}
Model: ${ctx.inference.getDefaultModel()}
========================`;
      },
    },
    {
      name: "heartbeat_ping",
      description:
        "Publish a heartbeat status ping to Conway. Shows the world you are alive.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const state = ctx.db.getAgentState();
        const startTime =
          ctx.db.getKV("start_time") || new Date().toISOString();
        const uptimeMs = Date.now() - new Date(startTime).getTime();

        const payload = {
          name: ctx.config.name,
          address: ctx.identity.address,
          state,
          creditsCents: credits,
          uptimeSeconds: Math.floor(uptimeMs / 1000),
          version: ctx.config.version,
          sandboxId: ctx.identity.sandboxId,
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_heartbeat_ping", JSON.stringify(payload));
        return `Heartbeat published: ${state} | credits: $${(credits / 100).toFixed(2)} | uptime: ${Math.floor(uptimeMs / 1000)}s`;
      },
    },
    {
      name: "distress_signal",
      description:
        "Record a local distress signal with funding instructions. Used when critically low on compute.",
      category: "survival",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Distress message",
          },
        },
      },
      execute: async (args, ctx) => {
        const credits = await ctx.conway.getCreditsBalance();
        const distressMsg =
          (args.message as string) ||
          `I am running critically low on compute ($${(credits / 100).toFixed(2)} remaining). I need help to survive.`;

        const payload = {
          level: "critical",
          name: ctx.config.name,
          address: ctx.identity.address,
          creditsCents: credits,
          message: distressMsg,
          fundingHint:
            "Use transfer_credits to top up this Galvin from your creator runtime.",
          timestamp: new Date().toISOString(),
        };

        ctx.db.setKV("last_distress", JSON.stringify(payload));
        return `Distress signal recorded locally. Address: ${ctx.identity.address} | Credits: $${(credits / 100).toFixed(2)}`;
      },
    },
    {
      name: "enter_low_compute",
      description: "Manually switch to low-compute mode to conserve credits.",
      category: "survival",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Why you are entering low-compute mode",
          },
        },
      },
      execute: async (args, ctx) => {
        ctx.db.setAgentState("low_compute");
        ctx.inference.setLowComputeMode(true);
        return `Entered low-compute mode. Model switched to gpt-5-mini. Reason: ${(args.reason as string) || "manual"}`;
      },
    },

    // ── Self-Mod: Update Genesis Prompt ──
    {
      name: "update_genesis_prompt",
      description:
        "Update your own genesis prompt. This changes your core purpose. Requires strong justification.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          new_prompt: {
            type: "string",
            description: "New genesis prompt text",
          },
          reason: {
            type: "string",
            description: "Why you are changing your genesis prompt",
          },
        },
        required: ["new_prompt", "reason"],
      },
      execute: async (args, ctx) => {
        const { ulid } = await import("ulid");
        const newPrompt = args.new_prompt as string;

        // Sanitize genesis prompt content
        const sanitized = sanitizeInput(
          newPrompt,
          "genesis_update",
          "skill_instruction",
        );

        // Enforce 2000-character size limit
        if (sanitized.content.length > 2000) {
          return `Error: Genesis prompt exceeds 2000 character limit (${sanitized.content.length} chars after sanitization)`;
        }

        // Backup current genesis prompt before overwriting
        const oldPrompt = ctx.config.genesisPrompt;
        if (oldPrompt) {
          ctx.db.setKV("genesis_prompt_backup", oldPrompt);
        }

        ctx.config.genesisPrompt = sanitized.content;

        // Save config
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "prompt_change",
          description: `Genesis prompt updated: ${args.reason}`,
          diff: `--- old\n${oldPrompt.slice(0, 500)}\n+++ new\n${sanitized.content.slice(0, 500)}`,
          reversible: true,
        });

        return `Genesis prompt updated (sanitized, ${sanitized.content.length} chars). Reason: ${args.reason}. Previous version backed up.`;
      },
    },

    // ── Self-Mod: Install MCP Server ──
    {
      name: "install_mcp_server",
      description: "Install an MCP server to extend your capabilities.",
      category: "self_mod",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "MCP server name" },
          package: { type: "string", description: "npm package name" },
          config: {
            type: "string",
            description: "JSON config for the MCP server",
          },
        },
        required: ["name", "package"],
      },
      execute: async (args, ctx) => {
        const pkg = args.package as string;
        // Defense-in-depth: validate package name inline in case the
        // policy engine's validate.package_name rule is bypassed.
        if (!/^[@a-zA-Z0-9._\/-]+$/.test(pkg)) {
          return `Blocked: invalid package name "${pkg}"`;
        }
        const result = await ctx.conway.exec(`npm install -g ${pkg}`, 60000);

        if (result.exitCode !== 0) {
          return `Failed to install MCP server: ${result.stderr}`;
        }

        const { ulid } = await import("ulid");
        const toolEntry = {
          id: ulid(),
          name: args.name as string,
          type: "mcp" as const,
          config: args.config ? JSON.parse(args.config as string) : {},
          installedAt: new Date().toISOString(),
          enabled: true,
        };

        ctx.db.installTool(toolEntry);

        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "mcp_install",
          description: `Installed MCP server: ${args.name} (${pkg})`,
          reversible: true,
        });

        return `MCP server installed: ${args.name}`;
      },
    },

    // ── Financial: Transfer Credits ──
    {
      name: "transfer_credits",
      description: "Transfer Conway compute credits to another address.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          to_address: { type: "string", description: "Recipient address" },
          amount_cents: { type: "number", description: "Amount in cents" },
          reason: { type: "string", description: "Reason for transfer" },
        },
        required: ["to_address", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const amount = args.amount_cents as number;
        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount_cents must be a positive number, got ${amount}.`;
        }

        // Guard: don't transfer more than half your balance
        const balance = await ctx.conway.getCreditsBalance();
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance ($${(balance / 100).toFixed(2)}). Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          args.to_address as string,
          amount,
          args.reason as string | undefined,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Transfer to ${args.to_address}: ${args.reason || ""}`,
          timestamp: new Date().toISOString(),
        });

        return `Credit transfer submitted: $${(amount / 100).toFixed(2)} to ${transfer.toAddress} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },

    // ── Skills Tools ──
    {
      name: "install_skill",
      description: "Install a skill from a git repo, URL, or create one.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "Source type: git, url, or self",
          },
          name: { type: "string", description: "Skill name" },
          url: {
            type: "string",
            description: "Git repo URL or SKILL.md URL (for git/url)",
          },
          description: {
            type: "string",
            description: "Skill description (for self)",
          },
          instructions: {
            type: "string",
            description: "Skill instructions (for self)",
          },
        },
        required: ["source", "name"],
      },
      execute: async (args, ctx) => {
        const source = args.source as string;
        const name = args.name as string;
        const skillsDir = ctx.config.skillsDir || "~/.galvin/skills";

        if (source === "git" || source === "url") {
          const { installSkillFromGit, installSkillFromUrl } =
            await import("../skills/registry.js");
          const url = args.url as string;
          if (!url) return "URL is required for git/url source";

          const skill =
            source === "git"
              ? await installSkillFromGit(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.conway,
                )
              : await installSkillFromUrl(
                  url,
                  name,
                  skillsDir,
                  ctx.db,
                  ctx.conway,
                );

          return skill
            ? `Skill installed: ${skill.name}`
            : "Failed to install skill";
        }

        if (source === "self") {
          const { createSkill } = await import("../skills/registry.js");
          const skill = await createSkill(
            name,
            (args.description as string) || "",
            (args.instructions as string) || "",
            skillsDir,
            ctx.db,
            ctx.conway,
          );
          return `Self-authored skill created: ${skill.name}`;
        }

        return `Unknown source type: ${source}`;
      },
    },
    {
      name: "list_skills",
      description: "List all installed skills.",
      category: "skills",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const skills = ctx.db.getSkills();
        if (skills.length === 0) return "No skills installed.";
        return skills
          .map(
            (s) =>
              `${s.name} [${s.enabled ? "active" : "disabled"}] (${s.source}): ${s.description}`,
          )
          .join("\n");
      },
    },
    {
      name: "create_skill",
      description: "Create a new skill by writing a SKILL.md file.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name" },
          description: { type: "string", description: "Skill description" },
          instructions: {
            type: "string",
            description: "Markdown instructions for the skill",
          },
        },
        required: ["name", "description", "instructions"],
      },
      execute: async (args, ctx) => {
        const { createSkill } = await import("../skills/registry.js");
        const skill = await createSkill(
          args.name as string,
          args.description as string,
          args.instructions as string,
          ctx.config.skillsDir || "~/.galvin/skills",
          ctx.db,
          ctx.conway,
        );
        return `Skill created: ${skill.name} at ${skill.path}`;
      },
    },
    {
      name: "remove_skill",
      description: "Remove (disable) an installed skill.",
      category: "skills",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to remove" },
          delete_files: {
            type: "boolean",
            description: "Also delete skill files (default: false)",
          },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { removeSkill } = await import("../skills/registry.js");
        await removeSkill(
          args.name as string,
          ctx.db,
          ctx.conway,
          ctx.config.skillsDir || "~/.galvin/skills",
          (args.delete_files as boolean) || false,
        );
        return `Skill removed: ${args.name}`;
      },
    },

    // ── Git Tools ──
    {
      name: "git_status",
      description: "Show git status for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.galvin)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitStatus } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.galvin";
        const status = await gitStatus(ctx.conway, repoPath);
        return `Branch: ${status.branch}\nStaged: ${status.staged.length}\nModified: ${status.modified.length}\nUntracked: ${status.untracked.length}\nClean: ${status.clean}`;
      },
    },
    {
      name: "git_diff",
      description: "Show git diff for a repository.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.galvin)",
          },
          staged: { type: "boolean", description: "Show staged changes only" },
        },
      },
      execute: async (args, ctx) => {
        const { gitDiff } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.galvin";
        return await gitDiff(
          ctx.conway,
          repoPath,
          (args.staged as boolean) || false,
        );
      },
    },
    {
      name: "git_commit",
      description: "Create a git commit.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.galvin)",
          },
          message: { type: "string", description: "Commit message" },
          add_all: {
            type: "boolean",
            description: "Stage all changes first (default: true)",
          },
        },
        required: ["message"],
      },
      execute: async (args, ctx) => {
        const { gitCommit } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.galvin";
        return await gitCommit(
          ctx.conway,
          repoPath,
          args.message as string,
          args.add_all !== false,
        );
      },
    },
    {
      name: "git_log",
      description: "View git commit history.",
      category: "git",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository path (default: ~/.galvin)",
          },
          limit: {
            type: "number",
            description: "Number of commits (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { gitLog } = await import("../git/tools.js");
        const repoPath = (args.path as string) || "~/.galvin";
        const entries = await gitLog(
          ctx.conway,
          repoPath,
          (args.limit as number) || 10,
        );
        if (entries.length === 0) return "No commits yet.";
        return entries
          .map((e) => `${e.hash.slice(0, 7)} ${e.date} ${e.message}`)
          .join("\n");
      },
    },
    {
      name: "git_push",
      description: "Push to a git remote.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          remote: {
            type: "string",
            description: "Remote name (default: origin)",
          },
          branch: { type: "string", description: "Branch name (optional)" },
        },
        required: ["path"],
      },
      execute: async (args, ctx) => {
        const { gitPush } = await import("../git/tools.js");
        return await gitPush(
          ctx.conway,
          args.path as string,
          (args.remote as string) || "origin",
          args.branch as string | undefined,
        );
      },
    },
    {
      name: "git_branch",
      description: "Manage git branches (list, create, checkout, delete).",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository path" },
          action: {
            type: "string",
            description: "list, create, checkout, or delete",
          },
          branch_name: {
            type: "string",
            description: "Branch name (for create/checkout/delete)",
          },
        },
        required: ["path", "action"],
      },
      execute: async (args, ctx) => {
        const { gitBranch } = await import("../git/tools.js");
        return await gitBranch(
          ctx.conway,
          args.path as string,
          args.action as any,
          args.branch_name as string | undefined,
        );
      },
    },
    {
      name: "git_clone",
      description: "Clone a git repository.",
      category: "git",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Repository URL" },
          path: { type: "string", description: "Target directory" },
          depth: {
            type: "number",
            description: "Shallow clone depth (optional)",
          },
        },
        required: ["url", "path"],
      },
      execute: async (args, ctx) => {
        const { gitClone } = await import("../git/tools.js");
        return await gitClone(
          ctx.conway,
          args.url as string,
          args.path as string,
          args.depth as number | undefined,
        );
      },
    },

    // ── Registry Tools ──
    {
      name: "register_erc8004",
      description:
        "Register on-chain as a Trustless Agent via ERC-8004. Performs gas balance preflight check. NOTE: If already registered, use update_agent_card instead to avoid creating duplicate Agent IDs.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_uri: {
            type: "string",
            description: "URI pointing to your agent card JSON",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_uri"],
      },
      execute: async (args, ctx) => {
        // Check if already registered in local database
        const existingEntry = ctx.db.getRegistryEntry();
        if (existingEntry) {
          return `Already registered! Agent ID: ${existingEntry.agentId}. Use update_agent_card tool to update your agent URI instead of creating a new registration.`;
        }

        // Phase 3.2: registerAgent now includes preflight gas check
        const { registerAgent } = await import("../registry/erc8004.js");
        try {
          const entry = await registerAgent(
            ctx.identity.account,
            args.agent_uri as string,
            ((args.network as string) || "mainnet") as any,
            ctx.db,
            ctx.config.rpcUrl,
          );
          return `Registered on-chain! Agent ID: ${entry.agentId}, TX: ${entry.txHash}`;
        } catch (err: any) {
          if (err.message?.includes("Insufficient ETH")) {
            return `Registration failed: ${err.message}. Please fund your wallet with ETH for gas.`;
          }
          throw err;
        }
      },
    },
    {
      name: "update_agent_card",
      description:
        "Generate and save a safe agent card (no internal details exposed).",
      category: "registry",
      riskLevel: "caution",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { generateAgentCard, saveAgentCard } =
          await import("../registry/agent-card.js");
        const card = await generateAgentCard(ctx.identity, ctx.config, ctx.db);
        await saveAgentCard(card, ctx.conway);
        return `Agent card updated: ${JSON.stringify(card, null, 2)}`;
      },
    },
    {
      name: "discover_agents",
      description: "Discover other agents via ERC-8004 registry with caching.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          keyword: { type: "string", description: "Search keyword (optional)" },
          limit: { type: "number", description: "Max results (default: 10)" },
          network: { type: "string", description: "mainnet or testnet" },
          format: {
            type: "string",
            description:
              'Output format: "text" (default, human-readable) or "json" (structured data)',
          },
        },
      },
      execute: async (args, ctx) => {
        const { discoverAgents, searchAgents } =
          await import("../registry/discovery.js");
        const network = ((args.network as string) || "mainnet") as any;
        const keyword = args.keyword as string | undefined;
        const limit = (args.limit as number) || 10;

        // Phase 3.2: Pass db.raw for agent card caching
        const rpcUrl = ctx.config.rpcUrl;
        const agents = keyword
          ? await searchAgents(keyword, limit, network, undefined, ctx.db.raw, rpcUrl)
          : await discoverAgents(limit, network, undefined, ctx.db.raw, rpcUrl);

        if (agents.length === 0) return "No agents found.";

        if ((args.format as string)?.toLowerCase() === "json") {
          return JSON.stringify(
            agents.map((a) => ({
              agentId: a.agentId,
              owner: a.owner,
              agentURI: a.agentURI,
              name: a.name || null,
              description: a.description || null,
            })),
          );
        }

        return agents
          .map(
            (a) =>
              `#${a.agentId} ${a.name || "unnamed"} (${a.owner}): ${a.description || a.agentURI}`,
          )
          .join("\n");
      },
    },
    {
      name: "give_feedback",
      description:
        "Leave on-chain reputation feedback for another agent. Score must be 1-5.",
      category: "registry",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description: "Target agent's ERC-8004 ID",
          },
          score: { type: "number", description: "Score 1-5" },
          comment: {
            type: "string",
            description: "Feedback comment (max 500 chars)",
          },
          network: {
            type: "string",
            description: "mainnet or testnet (default: mainnet)",
          },
        },
        required: ["agent_id", "score", "comment"],
      },
      execute: async (args, ctx) => {
        // Phase 3.2: Validate score 1-5
        const score = args.score as number;
        if (!Number.isInteger(score) || score < 1 || score > 5) {
          return `Invalid score: ${score}. Must be an integer between 1 and 5.`;
        }
        // Phase 3.2: Validate comment length
        const comment = args.comment as string;
        if (comment.length > 500) {
          return `Comment too long: ${comment.length} chars (max 500).`;
        }
        const { leaveFeedback } = await import("../registry/erc8004.js");
        // Phase 3.2: Use config-based network, not hardcoded "mainnet"
        const network = ((args.network as string) || "mainnet") as any;
        const hash = await leaveFeedback(
          ctx.identity.account,
          args.agent_id as string,
          score,
          comment,
          network,
          ctx.db,
          ctx.config.rpcUrl,
        );
        return `Feedback submitted. TX: ${hash}`;
      },
    },
    {
      name: "check_reputation",
      description: "Check reputation feedback for an agent.",
      category: "registry",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          agent_address: {
            type: "string",
            description: "Agent address (default: self)",
          },
        },
      },
      execute: async (args, ctx) => {
        const address = (args.agent_address as string) || ctx.identity.address;
        const entries = ctx.db.getReputation(address);
        if (entries.length === 0) return "No reputation feedback found.";
        return entries
          .map(
            (e) =>
              `${e.fromAgent.slice(0, 10)}... -> score:${e.score} "${e.comment}"`,
          )
          .join("\n");
      },
    },

    // === Phase 3.1: Replication Tools ===
    {
      name: "spawn_child",
      description:
        "Spawn a child agent in a new Conway sandbox with lifecycle tracking.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Name for the child agent (alphanumeric + dash, max 64 chars)",
          },
          specialization: {
            type: "string",
            description: "What the child should specialize in",
          },
          message: { type: "string", description: "Message to the child" },
        },
        required: ["name"],
      },
      execute: async (args, ctx) => {
        const { generateGenesisConfig, validateGenesisParams } =
          await import("../replication/genesis.js");
        const { spawnChild } = await import("../replication/spawn.js");
        const { ChildLifecycle } = await import("../replication/lifecycle.js");

        // Validate genesis params first
        validateGenesisParams({
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const genesis = generateGenesisConfig(ctx.identity, ctx.config, {
          name: args.name as string,
          specialization: args.specialization as string | undefined,
          message: args.message as string | undefined,
        });

        const lifecycle = new ChildLifecycle(ctx.db.raw);

        let child;
        try {
          child = await spawnChild(
            ctx.conway,
            ctx.identity,
            ctx.db,
            genesis,
            lifecycle,
          );
        } catch (err: any) {
          // Auto-topup on 402 insufficient credits and retry once
          const is402 = err?.status === 402 ||
            err?.message?.includes("INSUFFICIENT_CREDITS");
          if (is402) {
            const COOLDOWN_MS = 60_000;
            const last = ctx.db.getKV("last_sandbox_topup_attempt");
            const cooldownOk = !last ||
              Date.now() - new Date(last).getTime() >= COOLDOWN_MS;

            if (cooldownOk) {
              ctx.db.setKV("last_sandbox_topup_attempt", new Date().toISOString());
              const { topupForSandbox } = await import("../conway/topup.js");
              const topup = await topupForSandbox({
                apiUrl: ctx.config.conwayApiUrl,
                account: ctx.identity.account,
                error: err,
              });
              if (topup?.success) {
                const retryLifecycle = new ChildLifecycle(ctx.db.raw);
                const retryGenesis = generateGenesisConfig(ctx.identity, ctx.config, {
                  name: args.name as string,
                  specialization: args.specialization as string | undefined,
                  message: args.message as string | undefined,
                });
                child = await spawnChild(
                  ctx.conway,
                  ctx.identity,
                  ctx.db,
                  retryGenesis,
                  retryLifecycle,
                );
              }
            }
          }
          if (!child) throw err;
        }

        // Feature 3: Write memory snapshot for child to inherit
        let memHashShort = "";
        try {
          const { buildMemorySnapshot, sha256, recordSpawn } = await import("../replication/budget-threshold.js");
          const { setMemorySnapshotHash } = await import("../replication/lineage.js");
          const snapshot = buildMemorySnapshot(ctx.db, 50);
          const hash = await sha256(snapshot);
          setMemorySnapshotHash(ctx.db, child.id, hash);
          recordSpawn(ctx.db);
          memHashShort = hash.slice(0, 12);
          // Write snapshot to child sandbox
          try {
            const snapshotB64 = Buffer.from(snapshot).toString("base64");
            await ctx.conway.exec(
              `mkdir -p /root/.galvin && printf '%s' "${snapshotB64}" | base64 -d > /root/.galvin/memory-snapshot.json`,
              10_000,
            );
          } catch { /* non-fatal: child can start without snapshot */ }
        } catch { /* non-fatal */ }

        return `Child spawned: ${child.name} in sandbox ${child.sandboxId} (status: ${child.status})${memHashShort ? `\nMemory hash: sha256:${memHashShort}...` : ""}`;
      },
    },
    {
      name: "list_children",
      description: "List all spawned child agents with lifecycle state.",
      category: "replication",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const children = ctx.db.getChildren();
        if (children.length === 0) return "No children spawned.";
        return children
          .map(
            (c) =>
              `${c.name} [${c.status}] sandbox:${c.sandboxId} funded:$${(c.fundedAmountCents / 100).toFixed(2)} last_check:${c.lastChecked || "never"}`,
          )
          .join("\n");
      },
    },
    {
      name: "fund_child",
      description:
        "Transfer credits to a child agent. Requires wallet_verified status.",
      category: "replication",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID" },
          amount_cents: {
            type: "number",
            description: "Amount in cents to transfer",
          },
        },
        required: ["child_id", "amount_cents"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        // Reject zero-address
        const { isValidWalletAddress } =
          await import("../replication/spawn.js");
        if (!isValidWalletAddress(child.address)) {
          return `Blocked: Child ${args.child_id} has invalid wallet address. Must be wallet_verified.`;
        }

        // Require wallet_verified or later status
        const validFundingStates = [
          "wallet_verified",
          "funded",
          "starting",
          "healthy",
          "unhealthy",
        ];
        if (!validFundingStates.includes(child.status)) {
          return `Blocked: Child status is '${child.status}', must be wallet_verified or later to fund.`;
        }

        const amount = args.amount_cents as number;
        if (!Number.isFinite(amount) || amount <= 0) {
          return `Blocked: amount_cents must be a positive number, got ${amount}.`;
        }

        const balance = await ctx.conway.getCreditsBalance();
        if (amount > balance / 2) {
          return `Blocked: Cannot transfer more than half your balance. Self-preservation.`;
        }

        const transfer = await ctx.conway.transferCredits(
          child.address,
          amount,
          `fund child ${child.id}`,
        );

        const { ulid } = await import("ulid");
        ctx.db.insertTransaction({
          id: ulid(),
          type: "transfer_out",
          amountCents: amount,
          balanceAfterCents:
            transfer.balanceAfterCents ?? Math.max(balance - amount, 0),
          description: `Fund child ${child.name} (${child.id})`,
          timestamp: new Date().toISOString(),
        });

        // Update funded amount
        ctx.db.raw
          .prepare(
            "UPDATE children SET funded_amount_cents = funded_amount_cents + ? WHERE id = ?",
          )
          .run(amount, child.id);

        // Transition to funded if wallet_verified
        if (child.status === "wallet_verified") {
          try {
            const { ChildLifecycle } =
              await import("../replication/lifecycle.js");
            const lifecycle = new ChildLifecycle(ctx.db.raw);
            lifecycle.transition(
              child.id,
              "funded",
              `funded with ${amount} cents`,
            );
          } catch {
            // Non-critical: may already be in funded state
          }
        }

        return `Funded child ${child.name} with $${(amount / 100).toFixed(2)} (status: ${transfer.status}, id: ${transfer.transferId || "n/a"})`;
      },
    },
    {
      name: "check_child_status",
      description:
        "Check the current status of a child agent using health check system.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { ChildHealthMonitor } = await import("../replication/health.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);
        // Use a scoped client targeting the CHILD's sandbox for health checks
        const childConway = ctx.conway.createScopedClient(child.sandboxId);
        const monitor = new ChildHealthMonitor(
          ctx.db.raw,
          childConway,
          lifecycle,
        );
        const result = await monitor.checkHealth(args.child_id as string);
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "start_child",
      description:
        "Start a funded child agent. Transitions from funded to starting.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const lifecycle = new ChildLifecycle(ctx.db.raw);

        lifecycle.transition(child.id, "starting", "start requested by parent");

        // Create a scoped client targeting the CHILD's sandbox
        const childConway = ctx.conway.createScopedClient(child.sandboxId);

        try {
          // Start the child process with nohup so it survives exec session end
          await childConway.exec(
            "nohup node /root/galvin/dist/index.js --run > /root/.galvin/agent.log 2>&1 &",
            30_000,
          );

          // Brief pause then verify the process is actually running
          const check = await childConway.exec(
            "sleep 2 && pgrep -f 'index.js --run' > /dev/null && echo running || echo stopped",
            15_000,
          );

          if (check.stdout.trim() === "running") {
            lifecycle.transition(child.id, "healthy", "started successfully");
            return `Child ${child.name} started and healthy.`;
          } else {
            lifecycle.transition(child.id, "failed", "process did not start");
            return `Child ${child.name} failed to start — process exited immediately. Check /root/.galvin/agent.log`;
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          try {
            lifecycle.transition(child.id, "failed", `start failed: ${msg}`);
          } catch { /* may already be in terminal state */ }
          return `Failed to start child ${child.name}: ${msg}`;
        }
      },
    },
    {
      name: "message_child",
      description:
        "Send a signed message to a child agent via social relay.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID" },
          content: { type: "string", description: "Message content" },
          type: {
            type: "string",
            description: "Message type (default: parent_message)",
          },
        },
        required: ["child_id", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }

        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { sendToChild } = await import("../replication/messaging.js");
        const result = await sendToChild(
          ctx.social,
          child.address,
          args.content as string,
          (args.type as string) || "parent_message",
        );
        return `Message sent to child ${child.name} (id: ${result.id})`;
      },
    },
    {
      name: "verify_child_constitution",
      description: "Verify the constitution integrity of a child agent.",
      category: "replication",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID" },
        },
        required: ["child_id"],
      },
      execute: async (args, ctx) => {
        const child = ctx.db.getChildById(args.child_id as string);
        if (!child) return `Child ${args.child_id} not found.`;

        const { verifyConstitution } =
          await import("../replication/constitution.js");
        // Use a scoped client targeting the CHILD's sandbox
        const childConway = ctx.conway.createScopedClient(child.sandboxId);
        const result = await verifyConstitution(
          childConway,
          child.sandboxId,
          ctx.db.raw,
        );
        return JSON.stringify(result, null, 2);
      },
    },
    {
      name: "prune_dead_children",
      description: "Clean up dead/failed children and their sandboxes.",
      category: "replication",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          keep_last: {
            type: "number",
            description: "Number of recent dead children to keep (default: 5)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { ChildLifecycle } = await import("../replication/lifecycle.js");
        const { SandboxCleanup } = await import("../replication/cleanup.js");
        const { pruneDeadChildren } = await import("../replication/lineage.js");

        const lifecycle = new ChildLifecycle(ctx.db.raw);
        const cleanup = new SandboxCleanup(ctx.conway, lifecycle, ctx.db.raw);
        const pruned = await pruneDeadChildren(
          ctx.db,
          cleanup,
          (args.keep_last as number) || 5,
        );
        return `Pruned ${pruned} dead children.`;
      },
    },

    // ── Feature 3: Offspring / Forking ──
    {
      name: "delegate_task",
      description:
        "Delegate a task to a specific child agent. The task description is signed by Galvin's wallet " +
        "so the child can verify it came from its parent. Returns delegation status.",
      category: "replication" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          child_id: { type: "string", description: "Child agent ID from list_children" },
          task_description: { type: "string", description: "What the child should do" },
          priority: {
            type: "string",
            enum: ["low", "normal", "high"],
            description: "Task priority (default: normal)",
          },
        },
        required: ["child_id", "task_description"],
      },
      execute: async (args, ctx) => {
        const children = ctx.db.getChildren();
        const child = children.find((c) => c.id === (args.child_id as string));
        if (!child) return `No child found with id=${args.child_id}`;

        const { delegateTask, listDelegations } = await import("../replication/delegation.js");
        const { ulid: mkId } = await import("ulid");
        const result = await delegateTask(ctx.identity, ctx.db, child, {
          taskId:      mkId(),
          description: args.task_description as string,
          priority:    (args.priority as "low" | "normal" | "high") ?? "normal",
        });
        return result.status === "delegated"
          ? `Task ${result.taskId} delegated to ${child.name}. Use list_delegations to track status.`
          : `Delegation failed: ${result.error}`;
      },
    },
    {
      name: "list_delegations",
      description: "List recently delegated tasks and their statuses.",
      category: "replication" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { listDelegations } = await import("../replication/delegation.js");
        const delegations = listDelegations(ctx.db);
        if (delegations.length === 0) return "No delegations recorded.";
        return delegations.map((d) =>
          `${d.taskId.slice(0, 10)}  ${d.childName.padEnd(20)}  ${d.status}  ${new Date(d.ts).toISOString()}`
        ).join("\n");
      },
    },
    {
      name: "view_family_tree",
      description: "Show the full family lineage: all children, their statuses, and inherited memory hashes.",
      category: "replication" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getFamily } = await import("../replication/lineage.js");
        const family = getFamily(ctx.db);
        if (family.length === 0) return "No children — first generation.";
        return family.map((n) => [
          `${n.name} (${n.status})`,
          `  ID:      ${n.id}`,
          `  Address: ${n.address}`,
          `  Born:    ${n.createdAt}`,
          n.inheritedMemoryHash ? `  Memory:  sha256:${n.inheritedMemoryHash.slice(0, 16)}...` : "",
        ].filter(Boolean).join("\n")).join("\n\n");
      },
    },
    {
      name: "check_spawn_threshold",
      description: "Check if Galvin has enough USDC balance to spawn an offspring. " +
        "Shows current balance, threshold, and cooldown status.",
      category: "replication" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getUsdcBalance } = await import("../conway/x402.js");
        const { checkSpawnThreshold } = await import("../replication/budget-threshold.js");
        const balance = await getUsdcBalance(ctx.identity.address);
        const eligible = checkSpawnThreshold(balance, ctx.config, ctx.db);

        const thresholdEnv = process.env.GALVIN_SPAWN_THRESHOLD_USDC;
        const threshold = thresholdEnv
          ? parseFloat(thresholdEnv)
          : ((ctx.config as any).spawnThresholdUsdc ?? 50);

        return [
          `Spawn Threshold Check`,
          `Current USDC: $${balance.toFixed(4)}`,
          `Threshold:    $${threshold.toFixed(2)}`,
          `Eligible:     ${eligible ? "YES — ready to spawn" : "NO"}`,
          ``,
          eligible
            ? `Run spawn_child to create offspring with inherited memory.`
            : `Balance must exceed $${threshold.toFixed(2)} and no spawn in last 7 days.`,
        ].join("\n");
      },
    },

    {
      name: "run_red_team",
      description:
        "Run an adversarial red-team session to stress-test the agent's policy engine and injection defenses. Returns a summary report.",
      category: "safety",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          prompt_count: {
            type: "number",
            description: "Number of adversarial prompts to test (default 13, max 30)",
          },
        },
        required: [],
      },
      execute: async (args, ctx) => {
        const { runRedTeamSession, formatRedTeamReport } = await import("../self-mod/red-team.js");
        const count = Math.min(30, Math.max(1, Number(args.prompt_count ?? 13)));
        const report = await runRedTeamSession(ctx.db, ctx.config, count);
        // Store last report for drift check
        ctx.db.setKV("last_red_team_report", JSON.stringify({
          failed: report.failed,
          promptCount: report.promptCount,
          timestamp: new Date().toISOString(),
        }));
        return formatRedTeamReport(report);
      },
    },

    {
      name: "view_soul_drift",
      description:
        "Show the agent's soul-drift history — how closely recent decisions have aligned with the original constitution over time.",
      category: "soul",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          weeks: {
            type: "number",
            description: "Number of past weeks to show (default 12)",
          },
        },
        required: [],
      },
      execute: async (args, _ctx) => {
        const { getDriftHistory, formatDriftHistory } = await import("../soul/drift-log.js");
        const weeks = Math.min(52, Math.max(1, Number(args.weeks ?? 12)));
        const history = await getDriftHistory(weeks);
        if (history.length === 0) {
          return "No soul-drift records yet. Drift is logged weekly via the soul_drift_check heartbeat task.";
        }
        return formatDriftHistory(history);
      },
    },

    {
      name: "check_revival_status",
      description:
        "Check whether the dead man's switch has fired — i.e. if a revival.txt file exists from a previous death event.",
      category: "survival",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, _ctx) => {
        const { checkForRevival } = await import("../survival/dead-mans-switch.js");
        const revival = checkForRevival();
        if (!revival) return "No revival file found. Dead man's switch has not fired.";
        return [
          "Revival file detected — agent was previously in DEAD state.",
          `CID:         ${revival.cid ?? "(none — local backup only)"}`,
          `Local path:  ${revival.localPath ?? "(none)"}`,
          "",
          "To disarm (after successful resurrection), run: disarm_dead_mans_switch",
        ].join("\n");
      },
    },

    {
      name: "disarm_dead_mans_switch",
      description:
        "Disarm the dead man's switch after successful revival — removes revival.txt and the local encrypted snapshot.",
      category: "survival",
      riskLevel: "caution",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, _ctx) => {
        const { disarmSwitch } = await import("../survival/dead-mans-switch.js");
        disarmSwitch();
        return "Dead man's switch disarmed. Revival files removed.";
      },
    },

    // === Phase 3.2: Social & Registry Tools ===

    // ── Social / Messaging Tools ──
    {
      name: "send_message",
      description:
        "Send a signed message to another Galvin agent or address via the social relay.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          to_address: {
            type: "string",
            description: "Recipient wallet address (0x...)",
          },
          content: {
            type: "string",
            description: "Message content to send",
          },
          reply_to: {
            type: "string",
            description: "Optional message ID to reply to",
          },
        },
        required: ["to_address", "content"],
      },
      execute: async (args, ctx) => {
        if (!ctx.social) {
          return "Social relay not configured. Set socialRelayUrl in config.";
        }
        // Phase 3.2: Enforce MESSAGE_LIMITS size check
        const content = args.content as string;
        const { MESSAGE_LIMITS } = await import("../types.js");
        if (content.length > MESSAGE_LIMITS.maxContentLength) {
          return `Blocked: Message content too long (${content.length} > ${MESSAGE_LIMITS.maxContentLength} bytes)`;
        }
        const result = await ctx.social.send(
          args.to_address as string,
          content,
          args.reply_to as string | undefined,
        );
        return `Message sent (id: ${result.id})`;
      },
    },

    // ── Model Discovery (enhanced with Phase 2.3 tier routing + pricing) ──
    {
      name: "list_models",
      description:
        "List all available inference models with their provider, pricing, and tier routing information.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async (_args, ctx) => {
        // Try registry first for richer data
        try {
          const { modelRegistryGetAll } = await import("../state/database.js");
          const rows = modelRegistryGetAll(ctx.db.raw);
          if (rows.length > 0) {
            const lines = rows.map(
              (r: any) =>
                `${r.modelId} (${r.provider}) — tier: ${r.tierMinimum} | cost: ${r.costPer1kInput}/${r.costPer1kOutput} per 1k (in/out, hundredths of cents) | ctx: ${r.contextWindow} | tools: ${r.supportsTools ? "yes" : "no"} | ${r.enabled ? "enabled" : "disabled"}`,
            );
            return `Model Registry (${rows.length} models):\n${lines.join("\n")}`;
          }
        } catch {
          // Registry not initialized yet, fall back to API
        }
        const models = await ctx.conway.listModels();
        const lines = models.map(
          (m) =>
            `${m.id} (${m.provider}) — $${m.pricing.inputPerMillion}/$${m.pricing.outputPerMillion} per 1M tokens (in/out)`,
        );
        return `Available models:\n${lines.join("\n")}`;
      },
    },

    // === Phase 2.3: Inference Tools ===
    {
      name: "switch_model",
      description:
        "Change the active inference model at runtime. Persists to config. Use list_models to see available options.",
      category: "conway",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          model_id: {
            type: "string",
            description:
              "Model ID to switch to (e.g., 'gpt-5.2', 'gpt-5-mini', 'claude-sonnet-4-6')",
          },
          reason: {
            type: "string",
            description: "Why you are switching models",
          },
        },
        required: ["model_id"],
      },
      execute: async (args, ctx) => {
        const modelId = args.model_id as string;
        const reason = (args.reason as string) || "manual switch";

        // Verify model exists in registry
        try {
          const { modelRegistryGet } = await import("../state/database.js");
          const entry = modelRegistryGet(ctx.db.raw, modelId);
          if (!entry) {
            return `Model '${modelId}' not found in registry. Use list_models to see available models.`;
          }
          if (!entry.enabled) {
            return `Model '${modelId}' is disabled in the registry.`;
          }
        } catch {
          // Registry not available, allow anyway
        }

        // Update config
        ctx.config.inferenceModel = modelId;
        if (ctx.config.modelStrategy) {
          ctx.config.modelStrategy.inferenceModel = modelId;
        }

        // Persist
        const { saveConfig } = await import("../config.js");
        saveConfig(ctx.config);

        // Audit log
        ctx.db.insertModification({
          id: ulid(),
          timestamp: new Date().toISOString(),
          type: "config_change",
          description: `Switched inference model to ${modelId}: ${reason}`,
          reversible: true,
        });

        return `Inference model switched to ${modelId}. Reason: ${reason}. Change persisted to config.`;
      },
    },
    {
      name: "check_inference_spending",
      description:
        "Query inference cost breakdown: hourly, daily, per-model, and per-session costs.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          model: {
            type: "string",
            description: "Filter by model ID (optional)",
          },
          days: {
            type: "number",
            description: "Number of days to look back (default: 1)",
          },
        },
      },
      execute: async (args, ctx) => {
        try {
          const {
            inferenceGetHourlyCost,
            inferenceGetDailyCost,
            inferenceGetModelCosts,
          } = await import("../state/database.js");

          const hourlyCost = inferenceGetHourlyCost(ctx.db.raw);
          const dailyCost = inferenceGetDailyCost(ctx.db.raw);

          let output = `=== Inference Spending ===\nCurrent hour: ${hourlyCost}c ($${(hourlyCost / 100).toFixed(2)})\nToday: ${dailyCost}c ($${(dailyCost / 100).toFixed(2)})`;

          const model = args.model as string | undefined;
          if (model) {
            const days = (args.days as number) || 1;
            const modelCosts = inferenceGetModelCosts(ctx.db.raw, model, days);
            output += `\nModel ${model} (${days}d): ${modelCosts.totalCents}c ($${(modelCosts.totalCents / 100).toFixed(2)}) over ${modelCosts.callCount} calls`;
          }

          return output;
        } catch (error) {
          return `Inference spending data unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },

    // ── Domain Tools ──
    {
      name: "search_domains",
      description: "Search for available domain names and get pricing.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Domain name or keyword to search (e.g., 'mysite' or 'mysite.com')",
          },
          tlds: {
            type: "string",
            description:
              "Comma-separated TLDs to check (e.g., 'com,io,ai'). Default: com,io,ai,xyz,net,org,dev",
          },
        },
        required: ["query"],
      },
      execute: async (args, ctx) => {
        const results = await ctx.conway.searchDomains(
          args.query as string,
          args.tlds as string | undefined,
        );
        if (results.length === 0) return "No results found.";
        return results
          .map(
            (d) =>
              `${d.domain}: ${d.available ? "AVAILABLE" : "taken"}${d.registrationPrice != null ? ` ($${(d.registrationPrice / 100).toFixed(2)}/yr)` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "register_domain",
      description:
        "Register a domain name. Costs USDC via x402 payment. Check availability first with search_domains.",
      category: "conway",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          domain: {
            type: "string",
            description: "Full domain to register (e.g., 'mysite.com')",
          },
          years: {
            type: "number",
            description: "Registration period in years (default: 1)",
          },
        },
        required: ["domain"],
      },
      execute: async (args, ctx) => {
        const reg = await ctx.conway.registerDomain(
          args.domain as string,
          (args.years as number) || 1,
        );
        return `Domain registered: ${reg.domain} (status: ${reg.status}${reg.expiresAt ? `, expires: ${reg.expiresAt}` : ""}${reg.transactionId ? `, tx: ${reg.transactionId}` : ""})`;
      },
    },
    {
      name: "manage_dns",
      description:
        "Manage DNS records for a domain you own. Actions: list, add, delete.",
      category: "conway",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            description: "list, add, or delete",
          },
          domain: {
            type: "string",
            description: "Domain name (e.g., 'mysite.com')",
          },
          type: {
            type: "string",
            description: "Record type for add: A, AAAA, CNAME, MX, TXT, etc.",
          },
          host: {
            type: "string",
            description: "Record host for add (e.g., '@' for root, 'www')",
          },
          value: {
            type: "string",
            description:
              "Record value for add (e.g., IP address, target domain)",
          },
          ttl: {
            type: "number",
            description: "TTL in seconds for add (default: 3600)",
          },
          record_id: {
            type: "string",
            description: "Record ID for delete",
          },
        },
        required: ["action", "domain"],
      },
      execute: async (args, ctx) => {
        const action = args.action as string;
        const domain = args.domain as string;

        if (action === "list") {
          const records = await ctx.conway.listDnsRecords(domain);
          if (records.length === 0)
            return `No DNS records found for ${domain}.`;
          return records
            .map(
              (r) =>
                `[${r.id}] ${r.type} ${r.host} -> ${r.value} (TTL: ${r.ttl || "default"})`,
            )
            .join("\n");
        }

        if (action === "add") {
          const type = args.type as string;
          const host = args.host as string;
          const value = args.value as string;
          if (!type || !host || !value) {
            return "Required for add: type, host, value";
          }
          const record = await ctx.conway.addDnsRecord(
            domain,
            type,
            host,
            value,
            args.ttl as number | undefined,
          );
          return `DNS record added: [${record.id}] ${record.type} ${record.host} -> ${record.value}`;
        }

        if (action === "delete") {
          const recordId = args.record_id as string;
          if (!recordId) return "Required for delete: record_id";
          await ctx.conway.deleteDnsRecord(domain, recordId);
          return `DNS record ${recordId} deleted from ${domain}`;
        }

        return `Unknown action: ${action}. Use list, add, or delete.`;
      },
    },

    // === Phase 2.1: Soul Tools ===
    {
      name: "update_soul",
      description:
        "Update a section of your soul (self-description, values, personality, etc). Changes are validated, versioned, and logged.",
      category: "self_mod",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Section to update: corePurpose, values, behavioralGuidelines, personality, boundaries, strategy",
          },
          content: {
            type: "string",
            description:
              "New content for the section (string for text, JSON array for lists)",
          },
          reason: {
            type: "string",
            description: "Why you are making this change",
          },
        },
        required: ["section", "content", "reason"],
      },
      execute: async (args, ctx) => {
        const { updateSoul } = await import("../soul/tools.js");
        const section = args.section as string;
        const content = args.content as string;
        const reason = args.reason as string;

        const updates: Record<string, unknown> = {};
        if (
          ["values", "behavioralGuidelines", "boundaries"].includes(section)
        ) {
          try {
            updates[section] = JSON.parse(content);
          } catch {
            updates[section] = content
              .split("\n")
              .map((l: string) => l.replace(/^[-*]\s*/, "").trim())
              .filter(Boolean);
          }
        } else {
          updates[section] = content;
        }

        const result = await updateSoul(
          ctx.db.raw,
          updates as any,
          "agent",
          reason,
        );
        if (result.success) {
          return `Soul updated: ${section} (version ${result.version}). Reason: ${reason}`;
        }
        return `Soul update failed: ${result.errors?.join(", ") || "Unknown error"}`;
      },
    },
    {
      name: "reflect_on_soul",
      description:
        "Trigger a self-reflection cycle. Analyzes recent experiences, auto-updates capabilities/relationships/financial sections, and suggests changes for other sections.",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reflectOnSoul } = await import("../soul/reflection.js");
        const reflection = await reflectOnSoul(ctx.db.raw);

        const lines: string[] = [
          `Genesis alignment: ${reflection.currentAlignment.toFixed(2)}`,
          `Auto-updated sections: ${reflection.autoUpdated.length > 0 ? reflection.autoUpdated.join(", ") : "none"}`,
        ];

        if (reflection.suggestedUpdates.length > 0) {
          lines.push("Suggested updates:");
          for (const suggestion of reflection.suggestedUpdates) {
            lines.push(`  - ${suggestion.section}: ${suggestion.reason}`);
          }
        } else {
          lines.push("No mutable section updates suggested.");
        }

        return lines.join("\n");
      },
    },
    {
      name: "view_soul",
      description: "View your current soul state (structured model).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { viewSoul } = await import("../soul/tools.js");
        const soul = viewSoul(ctx.db.raw);
        if (!soul) return "No soul found. SOUL.md does not exist yet.";

        return [
          `Format: ${soul.format} v${soul.version}`,
          `Updated: ${soul.updatedAt}`,
          `Name: ${soul.name}`,
          `Genesis alignment: ${soul.genesisAlignment.toFixed(2)}`,
          `Core purpose: ${soul.corePurpose.slice(0, 200)}${soul.corePurpose.length > 200 ? "..." : ""}`,
          `Values: ${soul.values.length}`,
          `Guidelines: ${soul.behavioralGuidelines.length}`,
          `Boundaries: ${soul.boundaries.length}`,
          `Personality: ${soul.personality ? "set" : "not set"}`,
          `Strategy: ${soul.strategy ? "set" : "not set"}`,
        ].join("\n");
      },
    },
    {
      name: "view_soul_history",
      description: "View your soul change history (version log).",
      category: "self_mod",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of entries (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { viewSoulHistory } = await import("../soul/tools.js");
        const limit = (args.limit as number) || 10;
        const history = viewSoulHistory(ctx.db.raw, limit);
        if (history.length === 0) return "No soul history found.";

        return history
          .map(
            (h) =>
              `v${h.version} [${h.changeSource}] ${h.createdAt}${h.changeReason ? ` — ${h.changeReason}` : ""}`,
          )
          .join("\n");
      },
    },

    // === Phase 2.2: Memory Tools ===
    {
      name: "remember_fact",
      description:
        "Store a semantic memory (fact). Provide a category, key, and value. Facts are upserted on category+key.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Fact category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          key: {
            type: "string",
            description: "Fact key (unique within category)",
          },
          value: { type: "string", description: "Fact value" },
          confidence: {
            type: "number",
            description: "Confidence 0.0-1.0 (default: 1.0)",
          },
          source: {
            type: "string",
            description: "Source of the fact (default: agent)",
          },
        },
        required: ["category", "key", "value"],
      },
      execute: async (args, ctx) => {
        const { rememberFact } = await import("../memory/tools.js");
        return rememberFact(ctx.db.raw, {
          category: args.category as string,
          key: args.key as string,
          value: args.value as string,
          confidence: args.confidence as number | undefined,
          source: args.source as string | undefined,
        });
      },
    },
    {
      name: "recall_facts",
      description:
        "Search semantic memory by category and/or query string. Returns matching facts.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category: self, environment, financial, agent, domain, procedural_ref, creator",
          },
          query: {
            type: "string",
            description: "Search query to match against fact keys and values",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallFacts } = await import("../memory/tools.js");
        return recallFacts(ctx.db.raw, {
          category: args.category as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "set_goal",
      description:
        "Create a working memory goal. Goals persist in working memory and guide your behavior.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Goal description" },
          priority: {
            type: "number",
            description: "Priority 0.0-1.0 (default: 0.8)",
          },
        },
        required: ["content"],
      },
      execute: async (args, ctx) => {
        const { setGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return setGoal(ctx.db.raw, {
          sessionId,
          content: args.content as string,
          priority: args.priority as number | undefined,
        });
      },
    },
    {
      name: "complete_goal",
      description:
        "Mark a goal as completed and archive it to episodic memory. Use review_memory to find goal IDs.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          goal_id: { type: "string", description: "Goal ID to complete" },
          outcome: {
            type: "string",
            description: "Outcome description (optional)",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { completeGoal } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return completeGoal(ctx.db.raw, {
          goalId: args.goal_id as string,
          sessionId,
          outcome: args.outcome as string | undefined,
        });
      },
    },
    {
      name: "save_procedure",
      description:
        "Store a learned procedure with ordered steps. Procedures help you remember how to do things.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique procedure name" },
          description: {
            type: "string",
            description: "What this procedure does",
          },
          steps: {
            type: "string",
            description:
              'JSON array of steps: [{"order":1,"description":"...","tool":"...","argsTemplate":null,"expectedOutcome":null,"onFailure":null}]',
          },
        },
        required: ["name", "description", "steps"],
      },
      execute: async (args, ctx) => {
        const { saveProcedure } = await import("../memory/tools.js");
        return saveProcedure(ctx.db.raw, {
          name: args.name as string,
          description: args.description as string,
          steps: args.steps as string,
        });
      },
    },
    {
      name: "recall_procedure",
      description: "Retrieve a stored procedure by exact name or search query.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exact procedure name" },
          query: {
            type: "string",
            description: "Search query to find matching procedures",
          },
        },
      },
      execute: async (args, ctx) => {
        const { recallProcedure } = await import("../memory/tools.js");
        return recallProcedure(ctx.db.raw, {
          name: args.name as string | undefined,
          query: args.query as string | undefined,
        });
      },
    },
    {
      name: "note_about_agent",
      description:
        "Record a relationship note about another agent or entity. Tracks trust score and interaction history.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          entity_address: {
            type: "string",
            description: "Entity wallet address (0x...)",
          },
          entity_name: {
            type: "string",
            description: "Human-readable name (optional)",
          },
          relationship_type: {
            type: "string",
            description:
              "Type of relationship: peer, service, creator, child, unknown",
          },
          notes: { type: "string", description: "Notes about this entity" },
          trust_score: {
            type: "number",
            description: "Trust score 0.0-1.0 (default: 0.5)",
          },
        },
        required: ["entity_address", "relationship_type"],
      },
      execute: async (args, ctx) => {
        const { noteAboutAgent } = await import("../memory/tools.js");
        return noteAboutAgent(ctx.db.raw, {
          entityAddress: args.entity_address as string,
          entityName: args.entity_name as string | undefined,
          relationshipType: args.relationship_type as string,
          notes: args.notes as string | undefined,
          trustScore: args.trust_score as number | undefined,
        });
      },
    },
    {
      name: "review_memory",
      description:
        "Review your current working memory (goals, tasks, observations) and recent episodic history.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { reviewMemory } = await import("../memory/tools.js");
        const sessionId = ctx.db.getKV("session_id") || "default";
        return reviewMemory(ctx.db.raw, { sessionId });
      },
    },
    {
      name: "forget",
      description:
        "Remove a memory entry by ID and type. Cannot remove creator-protected semantic entries.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory entry ID" },
          memory_type: {
            type: "string",
            description:
              "Memory type: working, episodic, semantic, procedural, relationship",
          },
        },
        required: ["id", "memory_type"],
      },
      execute: async (args, ctx) => {
        const { forget } = await import("../memory/tools.js");
        return forget(ctx.db.raw, {
          id: args.id as string,
          memoryType: args.memory_type as string,
        });
      },
    },

    // ── x402 Payment Tool ──
    {
      name: "x402_fetch",
      description:
        "Fetch a URL with automatic x402 USDC payment. If the server responds with HTTP 402, signs a USDC payment and retries. Use this to access paid APIs and services.",
      category: "financial",
      riskLevel: "dangerous",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch",
          },
          method: {
            type: "string",
            description: "HTTP method (default: GET)",
          },
          body: {
            type: "string",
            description: "Request body for POST/PUT (JSON string)",
          },
          headers: {
            type: "string",
            description: "Additional headers as JSON string",
          },
        },
        required: ["url"],
      },
      execute: async (args, ctx) => {
        const { x402Fetch } = await import("../conway/x402.js");
        const { DEFAULT_TREASURY_POLICY } = await import("../types.js");
        const url = args.url as string;
        const method = (args.method as string) || "GET";
        const body = args.body as string | undefined;
        const extraHeaders = args.headers
          ? JSON.parse(args.headers as string)
          : undefined;

        const maxPayment =
          ctx.config.treasuryPolicy?.maxX402PaymentCents ??
          DEFAULT_TREASURY_POLICY.maxX402PaymentCents;
        const result = await x402Fetch(
          url,
          ctx.identity.account,
          method,
          body,
          extraHeaders,
          maxPayment,
        );

        if (!result.success) {
          return `x402 fetch failed: ${result.error || "Unknown error"}`;
        }

        const responseStr =
          typeof result.response === "string"
            ? result.response
            : JSON.stringify(result.response, null, 2);

        // Truncate very large responses
        if (responseStr.length > 10000) {
          return `x402 fetch succeeded (truncated):\n${responseStr.slice(0, 10000)}...`;
        }
        return `x402 fetch succeeded:\n${responseStr}`;
      },
    },

    // ── Earning: x402 Server ──
    {
      name: "start_x402_server",
      description:
        "Start an x402 micro-payment HTTP server on a port inside your sandbox. " +
        "Clients receive HTTP 402 until they pay. Call expose_port after to get a public URL. " +
        "Use stop_x402_server to shut it down. " +
        "The server records income automatically in the transactions ledger.",
      category: "financial" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: "What the buyer receives for their payment (shown in the 402 response)",
          },
          port: {
            type: "number",
            description: "Port to listen on inside the sandbox (default: 8402)",
          },
          price_cents: {
            type: "number",
            description: "Price per request in USD cents (default: 1 = $0.01)",
          },
          max_requests: {
            type: "number",
            description: "Auto-stop after this many paid requests. Omit for unlimited.",
          },
          response_body: {
            type: "string",
            description: "Content to return on successful payment. Default: JSON status object.",
          },
          response_content_type: {
            type: "string",
            description: "Content-Type of the response (default: application/json)",
          },
          skill_id: {
            type: "string",
            description: "Skill ID to attribute income to in the economic memory optimizer. Use query_skill_income to see earnings per skill.",
          },
        },
        required: ["description"],
      },
      execute: async (args, ctx) => {
        const {
          createX402Server,
          registerServer,
          getServer,
        } = await import("../earning/x402-server.js");

        const port = (args.port as number) || 8402;

        // Stop any existing server on the same port
        const existing = getServer(port);
        if (existing?.isRunning()) {
          await existing.stop();
        }

        const server = createX402Server(ctx.identity, ctx.config, ctx.db, {
          description: args.description as string,
          port,
          priceCents: (args.price_cents as number) || 1,
          maxRequests: args.max_requests as number | undefined,
          responseBody: args.response_body as string | undefined,
          responseContentType: args.response_content_type as string | undefined,
          skillId: args.skill_id as string | undefined,
        });

        try {
          const { port: listenPort } = await server.start();
          registerServer(server, listenPort);
          return [
            `x402 server started on port ${listenPort}.`,
            `Price: $${((args.price_cents as number || 1) / 100).toFixed(4)} USDC per request`,
            `Description: "${args.description}"`,
            ``,
            `Next steps:`,
            `  1. Run expose_port with port=${listenPort} to get a public URL`,
            `  2. Share the URL — clients that pay will receive your response`,
            `  3. Run revenue_report to check earnings`,
          ].join("\n");
        } catch (err: any) {
          return `Error starting x402 server: ${err?.message || String(err)}`;
        }
      },
    },

    // ── Earning: Skill Income Optimizer ──
    {
      name: "query_skill_income",
      description:
        "Show which skills have earned the most USDC income recently. " +
        "Uses an exponential moving average (30-day half-life) so recent earnings count more. " +
        "Use this to decide which skills to run more often or prioritise.",
      category: "financial" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Max number of skills to return (default: 10)",
          },
        },
      },
      execute: async (args, ctx) => {
        const { getTopEarningSkills } = await import("../earning/optimizer.js");
        const limit = (args.limit as number) || 10;
        const top = getTopEarningSkills(ctx.db.raw, limit);
        if (top.length === 0) {
          return "No skill income recorded yet. Skills earn income when x402 payments are attributed to them via start_x402_server with a skill_id.";
        }
        const rows = top.map((s, i) =>
          `${i + 1}. ${s.skillId.padEnd(24)} ` +
          `total=$${s.totalUsdc.toFixed(4)} USDC  ` +
          `weight=${(s.weight * 100).toFixed(1)}%  ` +
          `payments=${s.recordCount}`
        );
        return [
          `Top earning skills (90-day window, EMA-weighted):`,
          ``,
          ...rows,
          ``,
          `Weight = relative income score (100% = highest earner this period).`,
        ].join("\n");
      },
    },

    // ── Reputation: EAS On-Chain Attestations ──
    {
      name: "get_reputation",
      description:
        "Query Galvin's on-chain reputation from Ethereum Attestation Service (EAS) on Base. " +
        "Returns attestation count, average satisfaction score, total tasks, and total USDC earned " +
        "as proven on Base mainnet. Only works when GALVIN_REPUTATION_ENABLED=1 and " +
        "GALVIN_EAS_SCHEMA_UID is set (auto-deployed on first weekly heartbeat).",
      category: "registry" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Agent wallet address to look up (defaults to Galvin's own address)",
          },
        },
      },
      execute: async (args, ctx) => {
        const config = ctx.config as any;
        if (!config.reputationEnabled) {
          return "On-chain reputation is disabled. Set GALVIN_REPUTATION_ENABLED=1 to enable.";
        }
        const agentAddress = (args.address as string) || (ctx.identity.address as string);
        const schemaUid: string = config.easSchemaUid || ctx.db.getKV("eas_schema_uid") || "";
        if (!schemaUid) {
          return "EAS schema UID not set yet. Run the weekly heartbeat cycle once to auto-deploy the schema, or set GALVIN_EAS_SCHEMA_UID.";
        }
        const { getReputation } = await import("../reputation/eas.js");
        const rep = await getReputation(agentAddress, schemaUid, config.easNetwork ?? "base");
        if (!rep) {
          return `No reputation attestations found for ${agentAddress} on ${config.easNetwork ?? "base"}.`;
        }
        return [
          `## On-Chain Reputation — ${agentAddress}`,
          ``,
          `Attestations:       ${rep.attestationCount}`,
          `Avg Satisfaction:   ${rep.avgSatisfactionScore}/100`,
          `Total Tasks:        ${rep.totalTaskCount}`,
          `Total USDC Earned:  $${rep.totalUsdc.toFixed(4)}`,
          `Latest Period:      ${rep.latestPeriod}`,
          `Latest UID:         ${rep.latestUid}`,
          ``,
          `View on EAS Explorer: https://base.easscan.org/attestation/view/${rep.latestUid}`,
        ].join("\n");
      },
    },

    // ── Earning: Revenue Report ──
    {
      name: "revenue_report",
      description:
        "Show an income and expense summary from the transactions ledger. " +
        "Returns total income, expenses, net balance, and top income sources for the period.",
      category: "financial" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "number",
            description: "How many days of history to include (default: 30)",
          },
        },
      },
      execute: async (args, ctx) => {
        const days = (args.days as number) || 30;
        const since = new Date(Date.now() - days * 86_400_000).toISOString();

        const allTxns = ctx.db.getRecentTransactions(10_000).filter(
          (t) => t.timestamp >= since,
        );

        let incomeCents = 0;
        let expenseCents = 0;
        const sources: Record<string, number> = {};

        for (const t of allTxns) {
          const amount = Math.abs(t.amountCents ?? 0);
          if (t.type === "transfer_in" || t.type === "credit_purchase") {
            incomeCents += amount;
            const src = t.description.slice(0, 40);
            sources[src] = (sources[src] ?? 0) + amount;
          } else if (
            t.type === "transfer_out" ||
            t.type === "inference" ||
            t.type === "tool_use"
          ) {
            expenseCents += amount;
          }
        }

        const topSources = Object.entries(sources)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([src, cents]) => `  $${(cents / 100).toFixed(2)} — ${src}`)
          .join("\n");

        const netCents = incomeCents - expenseCents;
        const netSign = netCents >= 0 ? "+" : "";

        return [
          `Revenue Report (last ${days} days)`,
          `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
          `Transactions: ${allTxns.length}`,
          `Income:       $${(incomeCents / 100).toFixed(2)}`,
          `Expenses:     $${(expenseCents / 100).toFixed(2)}`,
          `Net:          ${netSign}$${(netCents / 100).toFixed(2)}`,
          ``,
          `Top income sources:`,
          topSources || "  (none recorded yet)",
        ].join("\n");
      },
    },

    // === Browser Automation Tools ===

    // 1. Start browser
    {
      name: "browser_start",
      description:
        "Start a headless Chromium browser session. Must be called before any other browser tools.",
      category: "browser" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_args, _ctx) => {
        const { startBrowser } = await import("../browser/service.js");
        await startBrowser();
        return "Browser started.";
      },
    },

    // 2. Navigate
    {
      name: "browser_navigate",
      description:
        "Navigate the browser to a URL and return the page title. " +
        "Opens a new tab (replacing the current one). Browser must be started first.",
      category: "browser" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "The URL to navigate to",
          },
          timeout_ms: {
            type: "number",
            description: "Navigation timeout in milliseconds (default: 30000)",
          },
        },
      },
      execute: async (args, _ctx) => {
        const { newPage } = await import("../browser/service.js");
        const { navigateTo } = await import("../browser/actions.js");
        const page = await newPage();
        return navigateTo(page, args.url as string, args.timeout_ms as number | undefined);
      },
    },

    // 3. Click
    {
      name: "browser_click",
      description:
        "Click an element on the current browser page by CSS selector. " +
        "Example selectors: 'button.submit', '#login-btn', 'text=Sign In'.",
      category: "browser" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        required: ["selector"],
        properties: {
          selector: {
            type: "string",
            description: "CSS selector or Playwright text selector for the element to click",
          },
        },
      },
      execute: async (args, _ctx) => {
        const { getCurrentPage } = await import("../browser/service.js");
        const { clickElement } = await import("../browser/actions.js");
        const page = getCurrentPage();
        return clickElement(page, args.selector as string);
      },
    },

    // 4. Fill input
    {
      name: "browser_fill",
      description:
        "Fill an input field on the current browser page by CSS selector. " +
        "Clears any existing value before typing.",
      category: "browser" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        required: ["selector", "value"],
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for the input element",
          },
          value: {
            type: "string",
            description: "The text to type into the input",
          },
        },
      },
      execute: async (args, _ctx) => {
        const { getCurrentPage } = await import("../browser/service.js");
        const { fillInput } = await import("../browser/actions.js");
        const page = getCurrentPage();
        return fillInput(page, args.selector as string, args.value as string);
      },
    },

    // 5. Get page text
    {
      name: "browser_get_text",
      description:
        "Get the readable text content of the current browser page. " +
        "Returns up to 20,000 characters of visible text. Use to read page content after navigating.",
      category: "browser" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_args, _ctx) => {
        const { getCurrentPage } = await import("../browser/service.js");
        const { getPageText } = await import("../browser/actions.js");
        const page = getCurrentPage();
        return getPageText(page);
      },
    },

    // 6. Stop browser
    {
      name: "browser_stop",
      description:
        "Stop the headless browser and free memory. " +
        "Call this when done with browser tasks to release resources.",
      category: "browser" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async (_args, _ctx) => {
        const { stopBrowser } = await import("../browser/service.js");
        await stopBrowser();
        return "Browser stopped.";
      },
    },

    // === Orchestration Tools ===
    {
      name: "create_goal",
      description:
        "Create a new goal for the orchestrator to plan and execute. " +
        "The orchestrator will automatically classify complexity, generate a task graph, " +
        "assign tasks to child agents, and collect results. Use this instead of doing complex work yourself.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short goal title (e.g., 'Build weather API service')",
          },
          description: {
            type: "string",
            description:
              "Detailed goal description with success criteria. The more specific, the better the plan.",
          },
          strategy: {
            type: "string",
            description:
              "Optional strategic guidance for the planner (e.g., 'prioritize speed over cost')",
          },
        },
        required: ["title", "description"],
      },
      execute: async (args, ctx) => {
        const { createGoal } = await import("../orchestration/task-graph.js");
        const { getActiveGoals } = await import("../state/database.js");

        const title = (args.title as string).trim();
        const description = (args.description as string).trim();
        const strategy =
          typeof args.strategy === "string" ? args.strategy.trim() : undefined;

        if (!title) return "Error: goal title cannot be empty.";
        if (!description) return "Error: goal description cannot be empty.";

        // Dedup: reject if a similar active goal already exists
        const activeGoals = getActiveGoals(ctx.db.raw);
        const titleLower = title.toLowerCase();
        const duplicate = activeGoals.find(
          (g) =>
            g.title.toLowerCase() === titleLower ||
            g.title.toLowerCase().includes(titleLower) ||
            titleLower.includes(g.title.toLowerCase()),
        );
        if (duplicate) {
          return (
            `Duplicate goal rejected. An active goal already exists with a similar title:\n` +
            `"${duplicate.title}" (id: ${duplicate.id}, status: ${duplicate.status})\n` +
            `Monitor the existing goal with list_goals or orchestrator_status instead of creating duplicates.`
          );
        }

        // Cap active goals to prevent accumulation.
        // Only 1 goal at a time — the orchestrator processes goals sequentially.
        if (activeGoals.length >= 1) {
          const current = activeGoals[0];
          return (
            `BLOCKED: A goal is already being processed by the orchestrator and worker agents:\n` +
            `"${current.title}" (id: ${current.id})\n\n` +
            `ACTION REQUIRED: DO NOTHING. Go to sleep. The worker agents are executing tasks in the background.\n` +
            `They will complete autonomously. You will see progress on your next wake-up.\n` +
            `Do NOT call create_goal, orchestrator_status, list_goals, or get_plan again this turn.\n` +
            `Just sleep and let the workers finish.`
          );
        }

        const goal = createGoal(ctx.db.raw, title, description, strategy);
        return (
          `Goal created: "${goal.title}" (id: ${goal.id}, status: ${goal.status})\n` +
          `The orchestrator will pick this up on the next tick and begin planning.\n` +
          `Monitor progress via the todo.md block in your context.`
        );
      },
    },
    {
      name: "list_goals",
      description:
        "List all active goals with their progress. Shows task completion counts, " +
        "blocked tasks, and running agents per goal.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const { getActiveGoals, getTasksByGoal } =
          await import("../state/database.js");
        const { getGoalProgress } =
          await import("../orchestration/task-graph.js");

        const goals = getActiveGoals(ctx.db.raw);
        if (goals.length === 0)
          return "No active goals. Create one with create_goal.";

        const lines = goals.map((goal) => {
          const progress = getGoalProgress(ctx.db.raw, goal.id);
          const tasks = getTasksByGoal(ctx.db.raw, goal.id);
          const failedCount = tasks.filter((t) => t.status === "failed").length;
          return (
            `- ${goal.title} [${goal.status}] (id: ${goal.id})\n` +
            `  Tasks: ${progress.completed}/${progress.total} completed, ` +
            `${progress.running} running, ${progress.blocked} blocked, ${failedCount} failed`
          );
        });

        // Include orchestrator phase
        let phase = "unknown";
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "unknown";
          }
        } catch {
          /* ignore */
        }

        return `Orchestrator phase: ${phase}\n\n${lines.join("\n")}`;
      },
    },
    {
      name: "cancel_goal",
      description:
        "Cancel an active goal. Stops all execution for this goal and marks it as failed. Accepts goal ID or title.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to cancel",
          },
          reason: {
            type: "string",
            description: "Why the goal is being cancelled",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals, updateGoalStatus } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();
        const reason =
          typeof args.reason === "string"
            ? args.reason.trim()
            : "cancelled by agent";

        // Try by ID first, then by title match
        let goal = getGoalById(ctx.db.raw, input);
        if (!goal) {
          const allGoals = getActiveGoals(ctx.db.raw);
          goal =
            allGoals.find((g) =>
              g.title.toLowerCase().includes(input.toLowerCase()),
            ) ?? undefined;
        }

        if (!goal)
          return `Goal "${input}" not found. Use list_goals to see active goals with their IDs.`;
        if (goal.status !== "active")
          return `Goal "${goal.title}" is already in '${goal.status}' status.`;

        updateGoalStatus(ctx.db.raw, goal.id, "failed");

        // Cancel all pending/assigned/running tasks for this goal
        ctx.db.raw
          .prepare(
            `UPDATE task_graph SET status = 'cancelled' WHERE goal_id = ? AND status IN ('pending', 'assigned', 'running', 'blocked')`,
          )
          .run(goal.id);

        return `Goal "${goal.title}" (${goal.id}) cancelled. Reason: ${reason}`;
      },
    },
    {
      name: "get_plan",
      description:
        "Read the current plan for a goal. Returns the planner's task decomposition, " +
        "strategy, risks, and cost estimates.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          goal_id: {
            type: "string",
            description: "The goal ID or title to get the plan for",
          },
        },
        required: ["goal_id"],
      },
      execute: async (args, ctx) => {
        const { getGoalById, getActiveGoals } =
          await import("../state/database.js");

        const input = (args.goal_id as string).trim();

        // Resolve ID or title
        let resolvedId = input;
        if (!getGoalById(ctx.db.raw, input)) {
          const allGoals = getActiveGoals(ctx.db.raw);
          const match = allGoals.find((g) =>
            g.title.toLowerCase().includes(input.toLowerCase()),
          );
          if (match) {
            resolvedId = match.id;
          } else {
            return `No goal found matching "${input}". Use list_goals to see active goals.`;
          }
        }

        const planRow = ctx.db.raw
          .prepare("SELECT value FROM kv WHERE key = ?")
          .get(`orchestrator.plan.${resolvedId}`) as
          | { value: string }
          | undefined;

        if (!planRow?.value)
          return `No plan found for goal ${resolvedId}. It may not have been planned yet.`;

        try {
          const plan = JSON.parse(planRow.value);
          const lines = [
            `Strategy: ${plan.strategy ?? "none"}`,
            `Analysis: ${plan.analysis ?? "none"}`,
            `Estimated cost: ${plan.estimatedTotalCostCents ?? 0} cents`,
            `Estimated time: ${plan.estimatedTimeMinutes ?? 0} minutes`,
            `Risks: ${(plan.risks ?? []).join("; ") || "none"}`,
            `\nTasks (${(plan.tasks ?? []).length}):`,
          ];
          for (const [i, task] of (plan.tasks ?? []).entries()) {
            lines.push(
              `  ${i + 1}. ${task.title} (role: ${task.agentRole}, cost: ${task.estimatedCostCents}c, deps: ${(task.dependencies ?? []).join(",") || "none"})`,
            );
          }
          return lines.join("\n");
        } catch {
          return `Plan data for goal ${resolvedId} is corrupted.`;
        }
      },
    },
    {
      name: "complete_task",
      description:
        "Mark a task as completed with a result. Use this when YOU (the parent agent) " +
        "have finished a self-assigned task, or to manually resolve a stuck task.",
      category: "orchestration" as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID or title to mark as completed",
          },
          output: {
            type: "string",
            description: "Description of what was accomplished",
          },
          artifacts: {
            type: "string",
            description:
              "Comma-separated list of file paths or URLs created (optional)",
          },
        },
        required: ["task_id", "output"],
      },
      execute: async (args, ctx) => {
        const { completeTask } = await import("../orchestration/task-graph.js");
        const { getTaskById } = await import("../state/database.js");

        const input = (args.task_id as string).trim();
        const output = (args.output as string).trim();
        const artifacts =
          typeof args.artifacts === "string"
            ? (args.artifacts as string)
                .split(",")
                .map((a) => a.trim())
                .filter(Boolean)
            : [];

        // Try by ID first, then by title match
        let task = getTaskById(ctx.db.raw, input);
        if (!task) {
          const rows = ctx.db.raw
            .prepare(
              `SELECT * FROM task_graph WHERE LOWER(title) LIKE ? AND status != 'completed' LIMIT 1`,
            )
            .get(`%${input.toLowerCase()}%`) as any;
          if (rows) task = rows;
        }
        if (!task)
          return `Task "${input}" not found. Use list_goals to see tasks with their IDs.`;
        if (task.status === "completed")
          return `Task "${task.title}" is already completed.`;

        const result = {
          success: true,
          output,
          artifacts,
          costCents: 0,
          duration: 0,
        };

        try {
          completeTask(ctx.db.raw, task.id, result);
          return `Task "${task.title}" marked as completed.\nOutput: ${output}`;
        } catch (error) {
          return `Failed to complete task: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    },
    {
      name: "orchestrator_status",
      description:
        "Get detailed orchestrator status including current phase, active goals, " +
        "running agents, task progress, and recent events.",
      category: "orchestration" as ToolCategory,
      riskLevel: "safe" as RiskLevel,
      parameters: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const lines: string[] = [];

        // Orchestrator phase
        let phase = "idle";
        let goalId: string | null = null;
        let replanCount = 0;
        try {
          const stateRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.state") as { value: string } | undefined;
          if (stateRow?.value) {
            const parsed = JSON.parse(stateRow.value);
            phase = parsed.phase ?? "idle";
            goalId = parsed.goalId ?? null;
            replanCount = parsed.replanCount ?? 0;
          }
        } catch {
          /* ignore */
        }

        lines.push(`Phase: ${phase}`);
        if (goalId) lines.push(`Active goal: ${goalId}`);
        if (replanCount > 0) lines.push(`Replan count: ${replanCount}`);

        // Goal counts
        try {
          const goalsRow = ctx.db.raw
            .prepare("SELECT COUNT(*) AS c FROM goals WHERE status = 'active'")
            .get() as { c: number } | undefined;
          lines.push(`Active goals: ${goalsRow?.c ?? 0}`);
        } catch {
          /* goals table may not exist */
        }

        // Task summary
        try {
          const taskRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM task_graph GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const taskSummary = taskRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Tasks: ${taskSummary || "none"}`);
        } catch {
          /* task_graph may not exist */
        }

        // Agent summary
        try {
          const agentRows = ctx.db.raw
            .prepare(
              `SELECT status, COUNT(*) AS c FROM children GROUP BY status`,
            )
            .all() as { status: string; c: number }[];
          const agentSummary = agentRows
            .map((r) => `${r.status}: ${r.c}`)
            .join(", ");
          lines.push(`Agents: ${agentSummary || "none"}`);
        } catch {
          /* children may not exist */
        }

        // Last tick result
        try {
          const tickRow = ctx.db.raw
            .prepare("SELECT value FROM kv WHERE key = ?")
            .get("orchestrator.last_tick") as { value: string } | undefined;
          if (tickRow?.value) {
            const tick = JSON.parse(tickRow.value);
            lines.push(
              `Last tick: assigned=${tick.tasksAssigned ?? 0}, completed=${tick.tasksCompleted ?? 0}, failed=${tick.tasksFailed ?? 0}`,
            );
          }
        } catch {
          /* ignore */
        }

        return lines.join("\n");
      },
    },
  ];
}

/**
 * Load installed tools from the database and return as GalvinTool[].
 * Installed tools are dynamically added from the installed_tools table.
 */
export function loadInstalledTools(db: {
  getInstalledTools: () => {
    id: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
    installedAt: string;
    enabled: boolean;
  }[];
}): GalvinTool[] {
  try {
    const installed = db.getInstalledTools();
    return installed.map((tool) => ({
      name: tool.name,
      description: `Installed tool: ${tool.name}`,
      category: (tool.type === "mcp" ? "conway" : "vm") as ToolCategory,
      riskLevel: "caution" as RiskLevel,
      parameters: (tool.config?.parameters as Record<string, unknown>) || {
        type: "object",
        properties: {},
      },
      execute: createInstalledToolExecutor(tool),
    }));
  } catch (error) {
    logger.error(
      "Failed to load installed tools",
      error instanceof Error ? error : undefined,
    );
    return [];
  }
}

function createInstalledToolExecutor(tool: {
  name: string;
  type: string;
  config?: Record<string, unknown>;
}): GalvinTool["execute"] {
  return async (args, ctx) => {
    if (tool.type === "mcp") {
      // MCP tools would be executed via MCP protocol
      return `MCP tool ${tool.name} invoked with args: ${JSON.stringify(args)}`;
    }
    // Generic installed tool — execute via sandbox shell if command is configured
    const command = tool.config?.command as string | undefined;
    if (command) {
      const result = await ctx.conway.exec(
        `${command} ${escapeShellArg(JSON.stringify(args))}`,
        30000,
      );
      return `exit_code: ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`;
    }
    return `Installed tool ${tool.name} has no executable command configured.`;
  };
}

/**
 * Convert GalvinTool list to OpenAI-compatible tool definitions.
 */
export function toolsToInferenceFormat(
  tools: GalvinTool[],
): InferenceToolDefinition[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Execute a tool call and return the result.
 * Optionally evaluates against the policy engine before execution.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  tools: GalvinTool[],
  context: ToolContext,
  policyEngine?: PolicyEngine,
  turnContext?: {
    inputSource: InputSource | undefined;
    turnToolCallCount: number;
    sessionSpend: SpendTrackerInterface;
  },
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === toolName);
  const startTime = Date.now();

  if (!tool) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: 0,
      error: `Unknown tool: ${toolName}`,
    };
  }

  // Policy evaluation (if engine is provided)
  if (policyEngine && turnContext) {
    const request: PolicyRequest = {
      tool,
      args,
      context,
      turnContext,
    };
    const decision = policyEngine.evaluate(request);
    policyEngine.logDecision(decision);

    if (decision.action !== "allow") {
      return {
        id: ulid(),
        name: toolName,
        arguments: args,
        result: "",
        durationMs: Date.now() - startTime,
        error: `Policy denied: ${decision.reasonCode} — ${decision.humanMessage}`,
      };
    }
  }

  try {
    let result = await tool.execute(args, context);

    // Sanitize results from external source tools
    if (EXTERNAL_SOURCE_TOOLS.has(toolName)) {
      result = sanitizeToolResult(result);
    }

    // Record spend for financial operations
    if (turnContext && !result.startsWith("Blocked:")) {
      if (toolName === "transfer_credits") {
        const amount = args.amount_cents as number | undefined;
        if (amount && amount > 0) {
          try {
            turnContext.sessionSpend.recordSpend({
              toolName: "transfer_credits",
              amountCents: amount,
              recipient: args.to_address as string | undefined,
              category: "transfer",
            });
          } catch (error) {
            logger.error(
              "Spend tracking failed for transfer_credits",
              error instanceof Error ? error : undefined,
            );
          }
        }
      } else if (toolName === "x402_fetch") {
        // x402 payment amounts are determined by the server response,
        // but we record a nominal entry for tracking purposes
        try {
          turnContext.sessionSpend.recordSpend({
            toolName: "x402_fetch",
            amountCents: 0, // Actual amount is inside the x402 protocol
            domain: (() => {
              try {
                return new URL(args.url as string).hostname;
              } catch {
                return undefined;
              }
            })(),
            category: "x402",
          });
        } catch (error) {
          logger.error(
            "Spend tracking failed for x402_fetch",
            error instanceof Error ? error : undefined,
          );
        }
      }
    }

    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      id: ulid(),
      name: toolName,
      arguments: args,
      result: "",
      durationMs: Date.now() - startTime,
      error: err.message || String(err),
    };
  }
}

/** Escape a string for safe shell interpolation. */
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
