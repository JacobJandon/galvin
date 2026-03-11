/**
 * Galvin CLI Pretty-Print Utilities
 *
 * Shared ANSI-colored output helpers used by all CLI display commands.
 * Auto-degrades to plain text when stdout is not a TTY or GALVIN_NO_COLOR=1.
 */

// ── ANSI palette (matches banner.ts) ─────────────────────────────────────────
const _R   = "\x1b[0m";         // reset
const _B   = "\x1b[1m";         // bold
const _DIM = "\x1b[2m";         // dim
const _G   = "\x1b[38;5;46m";   // bright green  (Ben-10)
const _G2  = "\x1b[38;5;118m";  // lime accent
const _GR  = "\x1b[38;5;240m";  // dark grey
const _YEL = "\x1b[33m";        // yellow
const _RED = "\x1b[38;5;196m";  // red
const _CYN = "\x1b[38;5;51m";   // cyan
const _MAG = "\x1b[38;5;213m";  // magenta/pink

// ── TTY guard ─────────────────────────────────────────────────────────────────
const USE_COLOR =
  process.stdout.isTTY === true &&
  process.env["GALVIN_NO_COLOR"] !== "1" &&
  process.env["NO_COLOR"] === undefined;

const c = (code: string) => (USE_COLOR ? code : "");

// ── Public color strings ──────────────────────────────────────────────────────
export const R   = c(_R);
export const B   = c(_B);
export const DIM = c(_DIM);
export const G   = c(_G);
export const G2  = c(_G2);
export const GR  = c(_GR);
export const YEL = c(_YEL);
export const RED = c(_RED);
export const CYN = c(_CYN);
export const MAG = c(_MAG);

// ── Icons ─────────────────────────────────────────────────────────────────────
export const OK   = `${G}${B}✓${R}`;
export const WARN = `${YEL}${B}⚠${R}`;
export const FAIL = `${RED}${B}✗${R}`;
export const INFO = `${CYN}›${R}`;
export const SKIP = `${GR}○${R}`;
export const DASH = `${GR}─${R}`;

// ── Core print ────────────────────────────────────────────────────────────────
export function print(msg = ""): void {
  process.stdout.write(msg + "\n");
}

// ── Structural helpers ────────────────────────────────────────────────────────

/** Strip ANSI codes for measuring visible width */
function vis(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[mGKHJF]/g, "");
}

/** Print a top-level box header */
export function boxHeader(title: string, subtitle?: string): void {
  const visTitle    = title;
  const visSubtitle = subtitle ?? "";
  const inner       = subtitle
    ? `${B}${title}${R}  ${GR}${DIM}${subtitle}${R}`
    : `${B}${title}${R}`;
  const visInner = visTitle + (visSubtitle ? `  ${visSubtitle}` : "");
  const width    = Math.max(visInner.length + 8, 52);
  const lpad     = Math.max(2, Math.floor((width - visInner.length) / 2));
  const rpad     = Math.max(2, width - visInner.length - lpad);
  print(`\n  ${G}${DIM}┌${"─".repeat(width)}┐${R}`);
  print(`  ${G}${DIM}│${R}${" ".repeat(lpad)}${inner}${" ".repeat(rpad)}${G}${DIM}│${R}`);
  print(`  ${G}${DIM}└${"─".repeat(width)}┘${R}`);
}

/** Print a section label */
export function section(name: string): void {
  print(`\n  ${G2}${B}${name}${R}`);
  print(`  ${GR}${DIM}${"─".repeat(36)}${R}`);
}

/** Print a check row: icon + label + optional value */
export function row(icon: string, label: string, value?: string): void {
  const labelStr = value !== undefined
    ? `${label.padEnd(32)} ${GR}${value}${R}`
    : label;
  print(`  ${icon}  ${labelStr}`);
}

/** Print an indented hint line */
export function hint(msg: string): void {
  print(`     ${GR}${DIM}└─ ${msg}${R}`);
}

/** Print a blank line */
export function gap(): void {
  print();
}

/** Print a horizontal rule */
export function rule(): void {
  print(`  ${GR}${DIM}${"─".repeat(48)}${R}`);
}

/** Print a key-value info line (used in --status, --wallet, etc.) */
export function kv(key: string, value: string, icon = INFO): void {
  print(`  ${icon}  ${GR}${key}:${R}  ${B}${value}${R}`);
}

/** Print a table row for logs/tasks */
export function tableRow(col1: string, col2: string, col3?: string): void {
  const c1 = col1.padEnd(12);
  const c2 = col2.padEnd(36);
  const c3 = col3 ?? "";
  print(`  ${GR}│${R}  ${c1}  ${c2}  ${GR}${DIM}${c3}${R}`);
}

/** Format bytes → human readable */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Truncate address for display */
export function shortAddr(addr: string): string {
  if (addr.length <= 18) return addr;
  return `${addr.slice(0, 10)}…${addr.slice(-8)}`;
}

/** Format duration ms → human */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
