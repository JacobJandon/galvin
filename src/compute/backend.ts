/**
 * Compute Backends
 *
 * A unified interface for running commands somewhere other than (or in addition
 * to) the Conway sandbox: the local machine, a remote box you own over SSH, or
 * future cloud sandboxes (Modal, Daytona). Lets Galvin offload work to cheaper /
 * more / isolated compute.
 *
 * Local and SSH are fully implemented and real. Modal/Daytona are honest
 * adapters: the interface is wired, but they require an account + SDK, so they
 * throw a clear "not configured" error instead of pretending to run anything.
 */
import { execFile } from "child_process";
import { promisify } from "util";

const pExecFile = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
}

export type ComputeKind = "local" | "ssh" | "modal" | "daytona";

export interface ComputeBackend {
  readonly id: string;
  readonly kind: ComputeKind;
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  describe(): string;
}

interface ExecError {
  stdout?: string;
  stderr?: string;
  message?: string;
  code?: number | string;
}

function toResult(e: unknown): ExecResult {
  const err = e as ExecError;
  return {
    stdout: err.stdout ?? "",
    stderr: err.stderr ?? String(err.message ?? err),
    exitCode: typeof err.code === "number" ? err.code : 1,
  };
}

/** Runs commands via /bin/sh on this machine. */
export class LocalComputeBackend implements ComputeBackend {
  readonly id = "local";
  readonly kind = "local" as const;

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await pExecFile("/bin/sh", ["-c", command], {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        cwd: opts.cwd,
        maxBuffer: MAX_BUFFER,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e) {
      return toResult(e);
    }
  }

  describe(): string {
    return "local shell on this machine";
  }
}

export interface SshConfig {
  /** user@host */
  host: string;
  port?: number;
  identityFile?: string;
}

/** Runs commands on a remote host over SSH (key-based, non-interactive). */
export class SshComputeBackend implements ComputeBackend {
  readonly id: string;
  readonly kind = "ssh" as const;

  constructor(private readonly cfg: SshConfig) {
    this.id = `ssh:${cfg.host}`;
  }

  /** Build the argv for `ssh` — exposed for testing without a live host. */
  buildArgs(command: string): string[] {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
    if (this.cfg.port) args.push("-p", String(this.cfg.port));
    if (this.cfg.identityFile) args.push("-i", this.cfg.identityFile);
    args.push(this.cfg.host, command);
    return args;
  }

  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await pExecFile("ssh", this.buildArgs(command), {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e) {
      return toResult(e);
    }
  }

  describe(): string {
    return `ssh to ${this.cfg.host}`;
  }
}

/**
 * Honest placeholder for a cloud backend that needs an account + SDK. It does
 * NOT fake execution — exec() throws with a setup hint so nothing silently
 * pretends to run.
 */
export class UnconfiguredComputeBackend implements ComputeBackend {
  readonly id: string;
  readonly kind: ComputeKind;

  constructor(kind: "modal" | "daytona", private readonly setupHint: string) {
    this.kind = kind;
    this.id = kind;
  }

  async exec(): Promise<ExecResult> {
    throw new Error(`${this.kind} compute backend is not configured. ${this.setupHint}`);
  }

  describe(): string {
    return `${this.kind} (not configured) — ${this.setupHint}`;
  }
}

export interface ComputeConfig {
  backend?: ComputeKind;
  ssh?: SshConfig;
}

/** Select a compute backend from config. Defaults to local. */
export function getComputeBackend(cfg: ComputeConfig = {}): ComputeBackend {
  switch (cfg.backend) {
    case "ssh":
      if (!cfg.ssh?.host) {
        throw new Error("ssh compute backend requires compute.ssh.host (user@host)");
      }
      return new SshComputeBackend(cfg.ssh);
    case "modal":
      return new UnconfiguredComputeBackend("modal", "Add a Modal (modal.com) account + adapter to enable cloud sandboxes.");
    case "daytona":
      return new UnconfiguredComputeBackend("daytona", "Add a Daytona workspace + adapter to enable dev-environment sandboxes.");
    case "local":
    default:
      return new LocalComputeBackend();
  }
}
