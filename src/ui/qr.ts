/**
 * Galvin — Funding Screen + Scannable QR Code
 *
 * Renders a full terminal funding screen with wallet QR code, centered panel,
 * and a live countdown bar.  Exported as MatrixRain (keeping the class name
 * consistent with Old-Galvin style so banner.ts stays clean).
 */
// @ts-ignore — qrcode ships CommonJS; types via @types/qrcode
import QRCode from "qrcode";

// ═══════════════════════════════════════════════════════════════
// QR CODE GENERATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Render a QR code as terminal lines using Unicode half-block chars.
 * Black modules on a bright-white background — scannable on any terminal theme.
 */
export function generateQR(text: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qr: any = (QRCode as any).create(text, { errorCorrectionLevel: "L" });
  const N    = qr.modules.size as number;
  const data = qr.modules.data as Uint8Array;
  const Q    = 4; // quiet-zone modules each side
  const total = N + Q * 2;

  const isDark = (r: number, c: number): boolean => {
    if (r < Q || r >= N + Q || c < Q || c >= N + Q) return false;
    return data[(r - Q) * N + (c - Q)] === 1;
  };

  const WBG = "\x1b[107m";      // bright-white background
  const BLK = "\x1b[30;107m";  // black fg + bright-white bg
  const RST = "\x1b[0m";

  const lines: string[] = [];
  const rows = total % 2 === 0 ? total : total + 1;

  for (let r = 0; r < rows; r += 2) {
    let line = "";
    for (let c = 0; c < total; c++) {
      const tp = r     < total ? isDark(r,     c) : false;
      const bt = r + 1 < total ? isDark(r + 1, c) : false;
      if      ( tp &&  bt) line += `${BLK}\u2588${RST}`;  // full block
      else if ( tp && !bt) line += `${BLK}\u2580${RST}`;  // upper half
      else if (!tp &&  bt) line += `${BLK}\u2584${RST}`;  // lower half
      else                 line += `${WBG} ${RST}`;        // light cell
    }
    lines.push(line);
  }
  return lines;
}

// ═══════════════════════════════════════════════════════════════
// FUNDING SCREEN (MatrixRain)
// ═══════════════════════════════════════════════════════════════

const ESC    = "\x1b[";
const RESET  = "\x1b[0m";
const CLEAR  = `${ESC}2J${ESC}H`;
const HIDE_C = `${ESC}?25l`;
const SHOW_C = `${ESC}?25h`;
const CUP    = (r: number, c: number) => `${ESC}${r};${c}H`;
const CLREOL = `${ESC}2K`;

const G_BRIGHT = "\x1b[38;5;46m\x1b[1m";
const G_DIM    = "\x1b[38;5;22m";
const G_BOX    = "\x1b[38;5;46m";
const YEL      = "\x1b[33;1m";
const CYN      = "\x1b[36;1m";
const DIM_S    = "\x1b[2m";
const BOLD     = "\x1b[1m";

function visLen(s: string): number {
  return s
    .replace(/\x1b\[[0-9;]*[mGKHJF]/g, "")
    .replace(/[\u2580-\u259F\u2588]/g, " ")
    .replace(/[^\x00-\xFF]/g, "  ")
    .length;
}

function centre(text: string, width: number): string {
  const tl  = visLen(text);
  const pad = Math.max(0, Math.floor((width - tl) / 2));
  return " ".repeat(pad) + text + " ".repeat(Math.max(0, width - tl - pad));
}

/**
 * Full-terminal funding screen with centered QR panel and live countdown.
 * Call .start() to render, .updateStatus(secondsLeft, total) to tick,
 * .stop() to restore the terminal.
 */
/** Minimum USDC (dollars) required before Galvin will start. */
export const MINIMUM_USDC = 1.0;

export class MatrixRain {
  private readonly address: string;
  private readonly network = "Base Mainnet  (chain 8453 · eip155:8453)";
  private readonly asset   = "USDC  (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)";
  private readonly minimum = `$${MINIMUM_USDC.toFixed(2)} USDC  ($5.00 recommended)`;
  private readonly mode:    "dead" | "startup";

  private qrLines:  string[] = [];
  private statusRow = 0;
  private started   = false;

  constructor(address: string, mode: "dead" | "startup" = "dead") {
    this.mode = mode;
    this.address = address;
    try { this.qrLines = generateQR(address); } catch { /* noop */ }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    process.stdout.write(HIDE_C + CLEAR);
    this.render();
  }

  stop(): void {
    this.started = false;
    process.stdout.write(SHOW_C + RESET + "\n");
  }

  updateStatus(secondsLeft: number, totalSec: number): void {
    if (!this.started || this.statusRow === 0) return;
    const cols = process.stdout.columns || 120;
    const barW = 20;
    const pct  = Math.max(0, 1 - secondsLeft / totalSec);
    const f    = Math.round(pct * barW);
    const bar  = G_BRIGHT + "▓".repeat(f) + G_DIM + "░".repeat(barW - f) + RESET;
    const sp   = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(Date.now() / 100) % 10]!;

    const msg = secondsLeft <= 0
      ? `  ${G_BRIGHT}${sp}${RESET}  ${YEL}Checking on-chain…${RESET}`
      : `  ${G_BRIGHT}${sp}${RESET}  [${bar}]  ${DIM_S}next check in ${YEL}${secondsLeft}s${RESET}`;

    process.stdout.write(
      CUP(this.statusRow, 1) + CLREOL +
      centre(msg, cols),
    );
  }

  private render(): void {
    const cols = process.stdout.columns || 120;
    const bdr  = G_BOX + BOLD;

    const qrRaw = this.qrLines[0]?.replace(/\x1b\[[0-9;]*m/g, "") ?? "";
    const qrW   = qrRaw.length || 33;
    const pw    = Math.min(Math.max(qrW + 6, 54), cols - 4);
    const lpad  = " ".repeat(Math.max(0, Math.floor((cols - pw) / 2)));
    const w     = pw;

    const row = (content: string) => {
      const cl  = visLen(content);
      const pad = Math.max(0, w - 2 - cl);
      return `${lpad}${bdr}║${RESET}${content}${" ".repeat(pad)}${bdr}║${RESET}`;
    };

    const lines: string[] = [];
    const add = (s: string) => lines.push(s);

    add("");
    add("");
    add(`${lpad}${bdr}╔${"═".repeat(w - 2)}╗${RESET}`);

    const titleText = this.mode === "startup"
      ? "  ⚠  GALVIN NEEDS FUNDING — AI LOOPS PAUSED  "
      : " 💀  GALVIN IS DEAD — AWAITING USDC ";
    const titleColor = this.mode === "startup" ? `\x1b[31;1m` : YEL;
    add(row(centre(titleColor + BOLD + titleText + RESET, w - 2)));

    add(`${lpad}${bdr}╠${"═".repeat(w - 2)}╣${RESET}`);

    if (this.qrLines.length > 0) {
      const qrVisW = qrRaw.length;
      const qrPad  = " ".repeat(Math.max(0, Math.floor((w - 2 - qrVisW) / 2)));
      for (const ql of this.qrLines) {
        add(row(qrPad + ql));
      }
      const scanText = `${DIM_S}Scan to fund  ·  ${this.asset} on ${this.network}${RESET}`;
      add(row(centre(scanText, w - 2)));
      add(`${lpad}${bdr}╠${"─".repeat(w - 2)}╣${RESET}`);
    }

    add(row(`  ${DIM_S}Wallet  ${RESET}${CYN}${BOLD}${this.address}${RESET}`));
    add(row(
      `  ${DIM_S}Network${RESET}  ${G_BRIGHT}${this.network}${RESET}` +
      `   ${DIM_S}Asset${RESET}  ${G_BRIGHT}${this.asset}${RESET}` +
      `   ${DIM_S}Min${RESET}  ${G_BRIGHT}${this.minimum}${RESET}`,
    ));
    add(`${lpad}${bdr}╠${"─".repeat(w - 2)}╣${RESET}`);
    add(row(`  ${DIM_S}Bridge ETH → USDC on Base:  ${RESET}${CYN}https://bridge.base.org${RESET}`));
    add(row(`  ${DIM_S}Auto-detects deposit · no restart needed · Ctrl-C to exit${RESET}`));
    add(`${lpad}${bdr}╚${"═".repeat(w - 2)}╝${RESET}`);
    add("");
    add("");

    this.statusRow = 1 + lines.length;
    process.stdout.write(lines.join("\n") + "\n");
    this.updateStatus(0, 1);
  }
}

// ── Non-TTY fallback ──────────────────────────────────────────

export function printMatrixStatic(address: string): void {
  const G = "\x1b[38;5;46m", R = "\x1b[0m", Y = "\x1b[33;1m", W = "\x1b[1m";
  console.log();
  console.log(`${G + W}  ╔══════════════════════════════════════════════╗${R}`);
  console.log(`${G + W}  ║${R}${Y + W}   💀  GALVIN IS DEAD — FUND THIS WALLET   ${G + W}║${R}`);
  console.log(`${G + W}  ╠══════════════════════════════════════════════╣${R}`);
  console.log(`${G + W}  ║${R}  ${address}  ${G + W}║${R}`);
  console.log(`${G + W}  ╠══════════════════════════════════════════════╣${R}`);
  console.log(`${G + W}  ║${R}  Network: Base Mainnet (chain 8453)                  ${G + W}║${R}`);
  console.log(`${G + W}  ║${R}  Asset:   USDC  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  ${G + W}║${R}`);
  console.log(`${G + W}  ║${R}  Min: $${MINIMUM_USDC.toFixed(2)} USDC  ·  Bridge: https://bridge.base.org  ${G + W}║${R}`);
  console.log(`${G + W}  ╚══════════════════════════════════════════════╝${R}`);
  console.log();
  try {
    const lines = generateQR(address);
    console.log("  Scan to fund:\n");
    for (const l of lines) console.log("  " + l);
    console.log();
  } catch { /* ignore */ }
}
