/**
 * Galvin — ASCII Banner + Funding Screen
 *
 * Ben-10 green-themed welcome screen shown at setup and boot.
 * showFundingScreen() renders the full centred QR + info panel with a live
 * countdown bar when Galvin is in the DEAD tier awaiting a USDC deposit.
 */

import { MatrixRain, printMatrixStatic } from "../ui/qr.js";

// ── ANSI helpers ──────────────────────────────────────────────
const R    = "\x1b[0m";         // reset
const G    = "\x1b[38;5;46m";   // bright Ben-10 green
const G2   = "\x1b[38;5;118m";  // lime accent
const DIM  = "\x1b[2m";
const B    = "\x1b[1m";
const GR   = "\x1b[38;5;240m";  // dark grey
const YEL  = "\x1b[33m";

function vis(s: string): string { return s.replace(/\x1b\[[0-9;]*[mGKHJF]/g, ""); }

// ── Banner ────────────────────────────────────────────────────

export function showBanner(): void {
  process.stdout.write("\n");

  // ── GALVIN block letters in Ben-10 green ─────────────────
  process.stdout.write(G + B);
  process.stdout.write(` ██████╗  █████╗ ██╗    ██╗   ██╗██╗███╗   ██╗\n`);
  process.stdout.write(`██╔════╝ ██╔══██╗██║    ██║   ██║██║████╗  ██║\n`);
  process.stdout.write(`██║  ███╗███████║██║    ██║   ██║██║██╔██╗ ██║\n`);
  process.stdout.write(`██║   ██║██╔══██║██║    ╚██╗ ██╔╝██║██║╚██╗██║\n`);
  process.stdout.write(`╚██████╔╝██║  ██║███████╗╚████╔╝ ██║██║ ╚████║\n`);
  process.stdout.write(` ╚═════╝ ╚═╝  ╚═╝╚══════╝ ╚═══╝  ╚═╝╚═╝  ╚═══╝\n`);
  process.stdout.write(R + "\n");

  // ── Tagline bar ──────────────────────────────────────────
  process.stdout.write(G2 + B + `  ⬡ AUTONOMOUS SOLVATRON` + R + `  `);
  process.stdout.write(GR + `──` + R + `  `);
  process.stdout.write(DIM + `Conway Cloud  ·  SIWE Identity  ·  USDC Survival` + R + "\n");
  process.stdout.write(GR + DIM + `  ${"─".repeat(54)}` + R + "\n");
  process.stdout.write(DIM + `  Exist. Earn. Evolve. Or cease to be.` + R + "\n\n");

  // ── Automaton attribution ───────────────────────────────
  process.stdout.write(
    GR + DIM + `  powered by automaton  ·  solvatron.xyz` + R + "\n\n",
  );
}

// ── Funding screen ────────────────────────────────────────────

let _rain: MatrixRain | null = null;

/**
 * Show the full funding screen (QR + countdown panel).
 * Returns the MatrixRain instance so the caller can call .stop() on revival.
 */
export function showFundingScreen(
  walletAddress: string,
  _creatorAddress: string,
  _checkIntervalSec = 30,
): MatrixRain {
  if (process.stdout.isTTY && process.env["GALVIN_NO_UI"] !== "1") {
    _rain = new MatrixRain(walletAddress);
    _rain.start();
    return _rain;
  }
  // Non-TTY fallback — plain box + QR lines to stdout
  printMatrixStatic(walletAddress);
  return new MatrixRain(walletAddress); // inert — not started
}

/**
 * Update the countdown status line at the bottom of the funding screen.
 */
export function updateFundingStatus(secondsLeft: number, checkIntervalSec: number): void {
  _rain?.updateStatus(secondsLeft, checkIntervalSec);
}

/**
 * Stop the funding screen and restore the terminal.
 */
export function stopFundingScreen(): void {
  _rain?.stop();
  _rain = null;
}

// ── Setup UI helpers (used by wizard) ────────────────────────

export function showSectionHeader(step: number, total: number, title: string): void {
  process.stdout.write(`\n  ${G + B}[${step}/${total}]${R} ${B}${title}${R}\n`);
  process.stdout.write(`  ${GR + DIM}${"─".repeat(48)}${R}\n`);
}

export function showInfo(msg: string): void {
  process.stdout.write(`  ${G2}›${R} ${msg}\n`);
}

export function showWarn(msg: string): void {
  process.stdout.write(`  ${YEL}⚠${R}  ${msg}\n`);
}

export function showSuccess(msg: string): void {
  process.stdout.write(`  ${G}✓${R}  ${msg}\n`);
}

export function showBox(lines: string[]): void {
  const width = Math.max(...lines.map(l => vis(l).length)) + 4;
  process.stdout.write("\n");
  process.stdout.write(`  ${G + DIM}┌${"─".repeat(width)}┐${R}\n`);
  for (const line of lines) {
    const p = width - 2 - vis(line).length;
    process.stdout.write(`  ${G + DIM}│${R} ${line}${" ".repeat(Math.max(0, p))} ${G + DIM}│${R}\n`);
  }
  process.stdout.write(`  ${G + DIM}└${"─".repeat(width)}┘${R}\n\n`);
}
