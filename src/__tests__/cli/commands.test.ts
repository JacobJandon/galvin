import { describe, it, expect } from "vitest";
import { normalizeArgs, GROUPS } from "../../cli/commands.js";

describe("normalizeArgs — grouped commands → canonical flags", () => {
  it("maps grouped verbs to their flag", () => {
    expect(normalizeArgs(["report", "debrief"])).toEqual(["--debrief"]);
    expect(normalizeArgs(["report", "verify"])).toEqual(["--confirm"]);
    expect(normalizeArgs(["setup", "model"])).toEqual(["--pick-model"]);
    expect(normalizeArgs(["wallet", "fund"])).toEqual(["--fund"]);
    expect(normalizeArgs(["wallet", "recover"])).toEqual(["--recover"]);
    expect(normalizeArgs(["id", "passport"])).toEqual(["--passport"]);
    expect(normalizeArgs(["lab", "bounties"])).toEqual(["--bounties"]);
  });

  it("noun with no verb maps to the base flag", () => {
    expect(normalizeArgs(["report"])).toEqual(["--debrief"]);
    expect(normalizeArgs(["wallet"])).toEqual(["--wallet"]);
    expect(normalizeArgs(["setup"])).toEqual(["--setup"]);
    expect(normalizeArgs(["lab"])).toEqual(["--lab"]);
    expect(normalizeArgs(["id"])).toEqual(["--trust"]);
    expect(normalizeArgs(["watch"])).toEqual(["--watch"]);
    expect(normalizeArgs(["run"])).toEqual(["--run"]);
  });

  it("keeps positional values after the verb", () => {
    expect(normalizeArgs(["report", "logs", "20"])).toEqual(["--logs", "20"]);
    expect(normalizeArgs(["report", "income", "7"])).toEqual(["--income", "7"]);
    expect(normalizeArgs(["lab", "honeypot", "https://x/y"])).toEqual(["--honeypot", "https://x/y"]);
    expect(normalizeArgs(["lab", "notify", "hello world"])).toEqual(["--notify", "hello world"]);
  });

  it("passes wallet sub-commands through to --wallet's own handler", () => {
    expect(normalizeArgs(["wallet", "backup"])).toEqual(["--wallet", "backup"]);
    expect(normalizeArgs(["wallet", "backup", "/tmp/k"])).toEqual(["--wallet", "backup", "/tmp/k"]);
    expect(normalizeArgs(["wallet", "import", "0xabc", "--force"])).toEqual(["--wallet", "import", "0xabc", "--force"]);
  });

  it("forwards extra flags after a core noun", () => {
    expect(normalizeArgs(["watch", "--once"])).toEqual(["--watch", "--once"]);
    expect(normalizeArgs(["wallet", "recover", "--execute"])).toEqual(["--recover", "--execute"]);
  });

  it("leaves old --flags completely unchanged (back-compat)", () => {
    expect(normalizeArgs(["--debrief"])).toEqual(["--debrief"]);
    expect(normalizeArgs(["--recover", "--execute"])).toEqual(["--recover", "--execute"]);
    expect(normalizeArgs(["--wallet", "backup"])).toEqual(["--wallet", "backup"]);
    expect(normalizeArgs(["-v"])).toEqual(["-v"]);
    expect(normalizeArgs(["-h"])).toEqual(["-h"]);
  });

  it("leaves unknown nouns/empty alone", () => {
    expect(normalizeArgs([])).toEqual([]);
    expect(normalizeArgs(["wat", "is", "this"])).toEqual(["wat", "is", "this"]);
  });

  it("unknown verb under a known noun falls back to the base flag + rest", () => {
    expect(normalizeArgs(["report", "nope"])).toEqual(["--debrief", "nope"]);
    expect(normalizeArgs(["setup", "frobnicate"])).toEqual(["--setup", "frobnicate"]);
  });

  it("hidden aliases resolve too", () => {
    expect(normalizeArgs(["identity", "owner"])).toEqual(["--owner"]);
    expect(normalizeArgs(["monitor"])).toEqual(["--watch"]);
    expect(normalizeArgs(["fund"])).toEqual(["--fund"]);
    expect(normalizeArgs(["qr"])).toEqual(["--fund"]);
  });

  it("consolidates the surface to ~12 visible groups (≥50% fewer)", () => {
    const visible = Object.values(GROUPS).filter((g) => !g.hidden).length;
    expect(visible).toBeLessThanOrEqual(12);
    // every grouped verb resolves to a real flag or passthrough
    for (const g of Object.values(GROUPS)) {
      for (const target of Object.values(g.verbs)) {
        expect(target === "@passthrough" || target.startsWith("--")).toBe(true);
      }
    }
  });
});
