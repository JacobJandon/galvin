/**
 * Command consolidation.
 *
 * Galvin grew ~30 flat `--flags`. This collapses them into a small noun-grouped
 * surface (run · chat · watch · status · doctor · setup · wallet · id · report ·
 * lab · version · help) by translating the grouped form into the canonical flag
 * the existing handlers already match on. No handler changes; every old `--flag`
 * still works (it starts with "-", so it passes straight through). One tested
 * pure function — `normalizeArgs` — runs first thing in main().
 *
 *   galvin report debrief   → --debrief
 *   galvin wallet fund      → --fund
 *   galvin wallet backup p  → --wallet backup p   (passthrough sub-command)
 *   galvin setup model      → --pick-model
 *   galvin --debrief        → --debrief           (unchanged)
 */

const PASSTHROUGH = "@passthrough" as const;

interface Group {
  base: string; // `galvin <noun>` with no verb maps here
  verbs: Record<string, string>; // verb → canonical flag, or PASSTHROUGH
  hidden?: boolean; // alias noun, not shown in help
}

export const GROUPS: Record<string, Group> = {
  // ── Core (verbless) ──
  run: { base: "--run", verbs: {} },
  chat: { base: "--chat", verbs: {} },
  watch: { base: "--watch", verbs: {} },
  status: { base: "--status", verbs: {} },
  doctor: { base: "--doctor", verbs: {} },
  version: { base: "--version", verbs: {} },
  help: { base: "--help", verbs: {} },

  // ── Grouped ──
  setup: {
    base: "--setup",
    verbs: { configure: "--configure", model: "--pick-model", init: "--init", provision: "--provision", "reset-db": "--reset-db" },
  },
  wallet: {
    base: "--wallet",
    verbs: { backup: PASSTHROUGH, export: PASSTHROUGH, import: PASSTHROUGH, fund: "--fund", recover: "--recover" },
  },
  id: {
    base: "--trust",
    verbs: { trust: "--trust", owner: "--owner", passport: "--passport" },
  },
  report: {
    base: "--debrief",
    verbs: { logs: "--logs", debrief: "--debrief", income: "--income", tasks: "--tasks", verify: "--confirm", memory: "--memory" },
  },
  lab: {
    base: "--lab",
    verbs: { bounties: "--bounties", honeypot: "--honeypot", skills: "--skills", compute: "--compute", notify: "--notify" },
  },

  // ── Hidden convenience aliases (not in help) ──
  identity: { base: "--trust", verbs: { trust: "--trust", owner: "--owner", passport: "--passport" }, hidden: true },
  monitor: { base: "--watch", verbs: {}, hidden: true },
  live: { base: "--watch", verbs: {}, hidden: true },
  fund: { base: "--fund", verbs: {}, hidden: true },
  recover: { base: "--recover", verbs: {}, hidden: true },
  qr: { base: "--fund", verbs: {}, hidden: true },
};

/**
 * Translate the grouped noun-verb command form into canonical flags.
 * Anything already in flag form (starts with "-") or an unknown noun is
 * returned unchanged, so existing usage and scripts keep working.
 */
export function normalizeArgs(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const [head, ...rest] = argv;
  if (head.startsWith("-")) return argv; // already a flag (or -h/-v)

  const group = GROUPS[head];
  if (!group) return argv; // unknown noun — leave for positional handlers

  if (rest.length === 0) return [group.base];

  const verb = rest[0]!;
  const target = group.verbs[verb];

  if (target === undefined) {
    // unknown verb → fall back to the base flag, keep the rest positionally
    return [group.base, ...rest];
  }
  if (target === PASSTHROUGH) {
    // sub-command handled by the base flag's own handler (e.g. --wallet backup)
    return [group.base, verb, ...rest.slice(1)];
  }
  return [target, ...rest.slice(1)];
}
