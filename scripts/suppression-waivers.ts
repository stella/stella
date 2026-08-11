// Security-tier suppression waiver ledger.
//
// The per-rule ratchet budgets in scripts/ratchet.ts cap HOW MANY suppressions
// each rule carries. For the security tier — the tenancy, authorization,
// credential, and audit rules listed in scripts/lint-suppressions.ts — a count
// is not enough: two waivers of the same rule are not interchangeable, so the
// ledger names each one individually and this guard mirrors it against the
// codebase in both directions.
//
//   every security-tier directive in the codebase has a ledger entry
//   every ledger entry matches a real directive
//
// Adding a suppression therefore requires a ledger edit naming the rule, the
// file, the anchoring symbol, the rationale, and where the invariant is
// evidenced. That edit is the reviewable act. Removing a suppression is a pure
// deletion: drop the directive and drop its entry in the same change.
//
// Entries are keyed by rule + file + nearest enclosing top-level symbol, never
// by line number: a waiver's identity must survive edits above it, and a key
// that moves on every unrelated change would make the ledger churn instead of
// document.
//
// Modes:
//   bun scripts/suppression-waivers.ts            report the ledger vs the tree
//   bun scripts/suppression-waivers.ts --check    CI gate (exit 1 on drift)
//   bun scripts/suppression-waivers.ts --seed     draft entries for undeclared
//                                                 directives, for hand review
//   bun scripts/suppression-waivers.ts --self-test prove the guard still fires
//
// CI-only wiring lives in .github/workflows/ci.yml and scripts/verify.sh
// alongside the ratchet guard.

import { panic, Result } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  collectLintDirectives,
  directiveReason,
  isSecurityTierRule,
  resolveDirectiveAnchors,
  SECURITY_TIER_RULES,
  suppressesRule,
} from "./lint-suppressions";
import { scanSourceFiles } from "./source-globs";

const SCRIPTS_DIR = import.meta.dir;
const REPO_ROOT = path.resolve(SCRIPTS_DIR, "..");
const LEDGER_PATH = path.resolve(SCRIPTS_DIR, "suppression-waivers.json");
const LEDGER_REL = "scripts/suppression-waivers.json";
const SEED_HINT = "bun scripts/suppression-waivers.ts --seed";

// --- Ledger shape -----------------------------------------------------------

const WAIVER_ID = /^SW-\d{4}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// `permanent` is a structural exception: the code cannot satisfy the rule and
// never will, so an owner or expiry field would be theatre that rots. A
// `temporary` waiver is a promise with a date attached, and this guard fails
// once the date passes. A boolean would not survive a third disposition.
const WAIVER_KINDS = ["permanent", "temporary"] as const;

type WaiverKind = (typeof WAIVER_KINDS)[number];

type WaiverIdentity = {
  readonly rule: string;
  readonly file: string;
  readonly symbol: string;
};

type WaiverCore = WaiverIdentity & {
  readonly id: string;
  // Directives for this rule anchored at this symbol. Usually 1; a helper that
  // legitimately repeats one exception carries the exact repeat count so an
  // extra directive beside it still fails.
  readonly count: number;
  readonly reason: string;
  // Repo-relative path, optionally `#symbol`, pointing at what makes the
  // exception safe: the test that pins the invariant, or the source symbol
  // whose comment argues it. Validated to exist, so it cannot rot into a dead
  // pointer.
  readonly evidence: string;
};

// `expires` exists only on the temporary branch, so a permanent waiver cannot
// carry a dead date and a temporary one cannot omit its deadline.
type Waiver =
  | (WaiverCore & { readonly kind: "permanent" })
  | (WaiverCore & { readonly kind: "temporary"; readonly expires: string });

type Ledger = { readonly waivers: readonly Waiver[] };

// An anchor symbol can contain spaces (`import @/api/db/auth-schema`), so the
// key is serialized rather than concatenated: no separator choice can make two
// different identities collide into one map entry.
const identityKey = ({ rule, file, symbol }: WaiverIdentity): string =>
  JSON.stringify([rule, file, symbol]);

const describeIdentity = ({ rule, file, symbol }: WaiverIdentity): string =>
  `${rule} at ${file} (${symbol})`;

// --- Parsing ----------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWaiverKind = (value: unknown): value is WaiverKind =>
  WAIVER_KINDS.some((kind) => kind === value);

type ParseResult =
  | { readonly status: "valid"; readonly ledger: Ledger }
  | { readonly status: "invalid"; readonly errors: readonly string[] };

const parseWaiver = (raw: unknown, index: number): Waiver | string => {
  const where = `${LEDGER_REL} entry #${index}`;
  if (!isRecord(raw)) {
    return `${where} must be an object`;
  }
  const { id, rule, file, symbol, count, reason, evidence, kind, expires } =
    raw;
  if (typeof id !== "string" || !WAIVER_ID.test(id)) {
    return `${where} needs a stable id of the form SW-0000`;
  }
  if (typeof rule !== "string" || typeof file !== "string") {
    return `${id}: rule and file must be strings`;
  }
  if (typeof symbol !== "string" || symbol.length === 0) {
    return `${id}: symbol must be a non-empty anchor name`;
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
    return `${id}: count must be a positive safe integer`;
  }
  if (typeof reason !== "string" || reason.length === 0) {
    return `${id}: reason must explain why the rule cannot be satisfied here`;
  }
  if (typeof evidence !== "string" || evidence.length === 0) {
    return `${id}: evidence must locate the test or invariant comment that makes this safe`;
  }
  if (!isWaiverKind(kind)) {
    return `${id}: kind must be one of ${WAIVER_KINDS.join(", ")}`;
  }
  if (kind === "permanent" && expires !== undefined) {
    return `${id}: a permanent structural exception must not carry an expiry; mark it temporary or drop the field`;
  }
  if (kind === "temporary") {
    if (typeof expires !== "string" || !ISO_DATE.test(expires)) {
      return `${id}: a temporary waiver needs an expires date (YYYY-MM-DD)`;
    }
    return { id, rule, file, symbol, count, reason, evidence, kind, expires };
  }
  return { id, rule, file, symbol, count, reason, evidence, kind };
};

const parseLedger = (raw: unknown): ParseResult => {
  const rawWaivers = isRecord(raw) ? raw.waivers : undefined;
  if (!Array.isArray(rawWaivers)) {
    return {
      status: "invalid",
      errors: [`${LEDGER_REL} must be an object with a "waivers" array`],
    };
  }
  const entries: readonly unknown[] = rawWaivers;

  const errors: string[] = [];
  const waivers: Waiver[] = [];
  for (const [index, entry] of entries.entries()) {
    const parsed = parseWaiver(entry, index);
    if (typeof parsed === "string") {
      errors.push(parsed);
      continue;
    }
    waivers.push(parsed);
  }

  return errors.length === 0
    ? { status: "valid", ledger: { waivers } }
    : { status: "invalid", errors };
};

// --- Scanning ---------------------------------------------------------------

type ObservedWaiver = WaiverIdentity & { readonly count: number };

type Observation = {
  readonly observed: readonly ObservedWaiver[];
  // Directives that name no rule at all. They silence every rule including the
  // whole security tier, so they get their own diagnostic rather than a
  // thicket of one missing-entry error per security rule.
  readonly bare: readonly string[];
};

export const observeSecurityDirectives = (
  files: readonly string[],
  read: (file: string) => string,
): Observation => {
  const counts = new Map<string, ObservedWaiver>();
  const bare: string[] = [];

  for (const file of files) {
    const content = read(file);
    const directives = collectLintDirectives(content, file);
    if (directives.length === 0) {
      continue;
    }
    const anchors = resolveDirectiveAnchors(content, file, directives);

    for (const [index, directive] of directives.entries()) {
      if (directive.rules.length === 0) {
        bare.push(file);
        continue;
      }
      const symbol =
        anchors[index] ?? panic(`missing anchor for directive in ${file}`);
      for (const rule of directive.rules) {
        if (!isSecurityTierRule(rule)) {
          continue;
        }
        const key = identityKey({ rule, file, symbol });
        const previous = counts.get(key);
        counts.set(key, {
          rule,
          file,
          symbol,
          count: (previous?.count ?? 0) + 1,
        });
      }
    }
  }

  return {
    observed: [...counts.values()].sort((left, right) =>
      identityKey(left).localeCompare(identityKey(right)),
    ),
    bare: [...new Set(bare)].sort(),
  };
};

// --- Validation -------------------------------------------------------------

type InspectionInput = {
  readonly ledger: Ledger;
  readonly observation: Observation;
  readonly evidenceExists: (locator: string) => boolean;
  readonly today: string;
};

const evidencePath = (locator: string): string =>
  locator.split("#").at(0) ?? locator;

const inspectShape = (
  waivers: readonly Waiver[],
  evidenceExists: (locator: string) => boolean,
  today: string,
): string[] => {
  const errors: string[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();

  for (const waiver of waivers) {
    if (ids.has(waiver.id)) {
      errors.push(`${waiver.id}: duplicate waiver id`);
    }
    ids.add(waiver.id);

    const key = identityKey(waiver);
    if (keys.has(key)) {
      errors.push(
        `${waiver.id}: duplicate entry for ${describeIdentity(waiver)} — merge them and raise count instead`,
      );
    }
    keys.add(key);

    if (!isSecurityTierRule(waiver.rule)) {
      errors.push(
        `${waiver.id}: ${waiver.rule} is not a security-tier rule; the ledger governs ${SECURITY_TIER_RULES.length} rules listed in scripts/lint-suppressions.ts`,
      );
    }
    if (!evidenceExists(evidencePath(waiver.evidence))) {
      errors.push(
        `${waiver.id}: evidence ${waiver.evidence} does not exist; point at a test or a source symbol that does`,
      );
    }
    if (waiver.kind === "temporary" && waiver.expires < today) {
      errors.push(
        `${waiver.id}: temporary waiver expired on ${waiver.expires}; remove the suppression or re-justify it with a new date`,
      );
    }
  }

  return errors;
};

export const inspectLedger = ({
  ledger,
  observation,
  evidenceExists,
  today,
}: InspectionInput): readonly string[] => {
  const errors = inspectShape(ledger.waivers, evidenceExists, today);

  for (const file of observation.bare) {
    errors.push(
      `${file}: a rule-less disable directive silences every rule, the security tier included. Name the rules it is meant to suppress.`,
    );
  }

  const ledgered = new Map(
    ledger.waivers.map((waiver) => [identityKey(waiver), waiver]),
  );
  const observed = new Map(
    observation.observed.map((entry) => [identityKey(entry), entry]),
  );

  for (const entry of observation.observed) {
    const waiver = ledgered.get(identityKey(entry));
    if (!waiver) {
      errors.push(
        `undeclared security suppression: ${describeIdentity(entry)}. Add a ledger entry in ${LEDGER_REL} (draft one with \`${SEED_HINT}\`) and justify it in the PR description.`,
      );
      continue;
    }
    if (waiver.count < entry.count) {
      errors.push(
        `${waiver.id}: ${describeIdentity(entry)} now carries ${entry.count} directive(s), ledger declares ${waiver.count}. Each added suppression needs its own justification.`,
      );
    }
  }

  for (const waiver of ledger.waivers) {
    const entry = observed.get(identityKey(waiver));
    if (!entry) {
      errors.push(
        `${waiver.id}: no suppression found for ${describeIdentity(waiver)}. If it was removed, delete this entry; if it moved, update file/symbol.`,
      );
      continue;
    }
    if (waiver.count > entry.count) {
      errors.push(
        `${waiver.id}: ledger declares ${waiver.count} directive(s) for ${describeIdentity(waiver)} but only ${entry.count} remain. Lower the count in the same change.`,
      );
    }
  }

  return errors;
};

// --- Modes ------------------------------------------------------------------

const today = (): string => new Date().toISOString().slice(0, 10);

const readLedger = (): Ledger => {
  const parsed = Result.try((): unknown =>
    JSON.parse(readFileSync(LEDGER_PATH, "utf-8")),
  );
  if (Result.isError(parsed)) {
    panic(`${LEDGER_REL} is not valid JSON`);
  }
  const inspection = parseLedger(parsed.value);
  if (inspection.status === "invalid") {
    panic(inspection.errors.join("\n"));
  }
  return inspection.ledger;
};

const observeRepo = (root: string): Observation =>
  observeSecurityDirectives(scanSourceFiles(root), (file) =>
    readFileSync(path.join(root, file), "utf-8"),
  );

const runCheck = (): number => {
  const ledger = readLedger();
  const errors = inspectLedger({
    ledger,
    observation: observeRepo(REPO_ROOT),
    evidenceExists: (locator) => existsSync(path.join(REPO_ROOT, locator)),
    today: today(),
  });

  if (errors.length === 0) {
    console.log(
      `suppression-waivers --check: OK. ${ledger.waivers.length} security-tier waiver(s) match the tree.`,
    );
    return 0;
  }

  console.error("\nsuppression-waivers --check: ledger and tree disagree:\n");
  for (const error of errors) {
    console.error(`  ${error}`);
  }
  console.error(
    `\nThe ledger is a mirror of the security-tier suppressions in the tree.\n` +
      `Removing a suppression is a pure deletion; adding one is a ledger edit\n` +
      `plus a per-rule baseline reseed (\`bun scripts/ratchet.ts --write\`).`,
  );
  return 1;
};

const runReport = (): number => {
  const { observed, bare } = observeRepo(REPO_ROOT);
  console.log(`security-tier suppressions in the tree (${observed.length}):\n`);
  for (const entry of observed) {
    console.log(`  ${entry.count}  ${describeIdentity(entry)}`);
  }
  for (const file of bare) {
    console.log(`  ?  rule-less disable directive in ${file}`);
  }
  return 0;
};

// Drafts entries for directives the ledger does not yet declare, carrying the
// directive's own `-- reason` trailer across. Evidence defaults to the file's
// adjacent test when one exists and to the anchoring symbol otherwise; both
// are starting points a reviewer is expected to replace with the real locator.
const runSeed = (): number => {
  const ledger = readLedger();
  const { observed } = observeRepo(REPO_ROOT);
  const declared = new Set(ledger.waivers.map(identityKey));

  const contents = new Map<string, string>();
  const contentOf = (file: string): string => {
    const cached = contents.get(file);
    if (cached !== undefined) {
      return cached;
    }
    const content = readFileSync(path.join(REPO_ROOT, file), "utf-8");
    contents.set(file, content);
    return content;
  };

  const reasonFor = (entry: ObservedWaiver): string => {
    const content = contentOf(entry.file);
    const directives = collectLintDirectives(content, entry.file);
    const anchors = resolveDirectiveAnchors(content, entry.file, directives);
    const match = directives.find(
      (directive, index) =>
        anchors[index] === entry.symbol &&
        suppressesRule(directive, entry.rule),
    );
    return match ? directiveReason(match) : "";
  };

  const evidenceFor = (entry: ObservedWaiver): string => {
    const adjacent = entry.file.replace(/\.tsx?$/u, ".test.ts");
    return existsSync(path.join(REPO_ROOT, adjacent))
      ? adjacent
      : `${entry.file}#${entry.symbol}`;
  };

  let next =
    ledger.waivers.reduce(
      (highest, { id }) => Math.max(highest, Number(id.slice(3))),
      0,
    ) + 1;

  const drafted: Waiver[] = [];
  for (const entry of observed) {
    if (declared.has(identityKey(entry))) {
      continue;
    }
    drafted.push({
      id: `SW-${String(next).padStart(4, "0")}`,
      kind: "permanent",
      rule: entry.rule,
      file: entry.file,
      symbol: entry.symbol,
      count: entry.count,
      reason: reasonFor(entry),
      evidence: evidenceFor(entry),
    });
    next += 1;
  }

  if (drafted.length === 0) {
    console.log("suppression-waivers --seed: nothing undeclared.");
    return 0;
  }

  const merged = [...ledger.waivers, ...drafted].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
  writeFileSync(
    LEDGER_PATH,
    `${JSON.stringify({ waivers: merged }, null, 2)}\n`,
  );
  console.log(
    `suppression-waivers --seed: drafted ${drafted.length} entry(ies) into ${LEDGER_REL}.\n` +
      "Review every reason and replace each placeholder evidence locator.",
  );
  return 0;
};

// --- Self-test --------------------------------------------------------------
// Prove the guard fires. Each case names the drift it injects, so a guard that
// silently stopped detecting one fails here rather than in production.

const FIXTURE_RULE = "security-guards/no-unscoped-user-query";
const OTHER_RULE = "require-search-scope/require-search-scope";

const fixtureCore = (overrides: Partial<WaiverCore> = {}): WaiverCore => ({
  id: "SW-0001",
  rule: FIXTURE_RULE,
  file: "apps/api/src/handlers/example.ts",
  symbol: "listExample",
  count: 1,
  reason: "instance-wide operator surface, token-gated at the deployment",
  evidence: "apps/api/src/handlers/example.test.ts",
  ...overrides,
});

const permanentWaiver = (overrides: Partial<WaiverCore> = {}): Waiver => ({
  ...fixtureCore(overrides),
  kind: "permanent",
});

const temporaryWaiver = (
  expires: string,
  overrides: Partial<WaiverCore> = {},
): Waiver => ({ ...fixtureCore(overrides), kind: "temporary", expires });

const fixtureObservation = (
  observed: readonly ObservedWaiver[],
  bare: readonly string[] = [],
): Observation => ({ observed, bare });

const fixtureObserved = (
  overrides: Partial<ObservedWaiver> = {},
): ObservedWaiver => ({
  rule: FIXTURE_RULE,
  file: "apps/api/src/handlers/example.ts",
  symbol: "listExample",
  count: 1,
  ...overrides,
});

const inspect = (
  ledger: readonly Waiver[],
  observation: Observation,
  today = "2026-01-01",
): readonly string[] =>
  inspectLedger({
    ledger: { waivers: ledger },
    observation,
    evidenceExists: () => true,
    today,
  });

const SOURCE_FIXTURE_LINES = [
  'import { member, user } from "@/api/db/auth-schema";',
  "",
  "export const listExample = async () => {",
  "  // eslint-disable-next-line security-guards/no-unscoped-user-query -- audit rows are already org-scoped",
  "  const rows = await db.select().from(user);",
  "  // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- data-volume tier needs no ledger entry",
  "  const more = await db.select().from(member);",
  "  return [...rows, ...more];",
  "};",
  "",
  "export const otherExample = () => {",
  "  // eslint-disable-next-line require-search-scope/require-search-scope -- system backfill, returns no request data",
  "  return rootDb.execute(sql`select 1`);",
  "};",
];
const SOURCE_FIXTURE = `${SOURCE_FIXTURE_LINES.join("\n")}\n`;

// The same directive, moved down inside its function by an unrelated edit
// above it. The anchor must not move: line-keyed entries would churn here.
const SHIFTED_FIXTURE_LINES = [
  'import { member, user } from "@/api/db/auth-schema";',
  "",
  "export const listExample = async () => {",
  "  const preamble = await db.select().from(member);",
  "  const second = preamble.length;",
  "  // eslint-disable-next-line security-guards/no-unscoped-user-query -- audit rows are already org-scoped",
  "  const rows = await db.select().from(user);",
  "  return [...rows, second];",
  "};",
];
const SHIFTED_FIXTURE = `${SHIFTED_FIXTURE_LINES.join("\n")}\n`;

// A trailing `-disable-line` directive sits in the next statement's leading
// trivia. It must still anchor to the import it annotates.
const TRAILING_FIXTURE_LINES = [
  'import { user } from "@/api/db/auth-schema"; // oxlint-disable-line security-guards/no-unscoped-user-query -- joined via RLS-scoped members',
  'import { workspaces } from "@/api/db/schema";',
  "",
  "export const listWorkspaces = () => db.select().from(workspaces);",
];
const TRAILING_FIXTURE = `${TRAILING_FIXTURE_LINES.join("\n")}\n`;

const runSelfTest = (): number => {
  const failures: string[] = [];

  const expectClean = (name: string, errors: readonly string[]): void => {
    if (errors.length > 0) {
      failures.push(`${name} should have passed, got: ${errors.join("; ")}`);
    }
  };
  const expectError = (
    name: string,
    errors: readonly string[],
    fragment: string,
  ): void => {
    if (!errors.some((error) => error.includes(fragment))) {
      failures.push(
        `${name} did not report ${JSON.stringify(fragment)}; got: ${errors.join("; ") || "no errors"}`,
      );
    }
  };

  expectClean(
    "a ledger mirroring the tree",
    inspect([permanentWaiver()], fixtureObservation([fixtureObserved()])),
  );

  expectError(
    "an undeclared suppression",
    inspect([], fixtureObservation([fixtureObserved()])),
    "undeclared security suppression",
  );

  expectError(
    "a stale ledger entry",
    inspect([permanentWaiver()], fixtureObservation([])),
    "no suppression found",
  );

  expectError(
    "a second directive beside a declared one",
    inspect(
      [permanentWaiver()],
      fixtureObservation([fixtureObserved({ count: 2 })]),
    ),
    "now carries 2 directive(s)",
  );

  expectError(
    "a ledger count left high after a removal",
    inspect(
      [permanentWaiver({ count: 3 })],
      fixtureObservation([fixtureObserved({ count: 2 })]),
    ),
    "but only 2 remain",
  );

  expectError(
    "a suppression that moved to another symbol",
    inspect(
      [permanentWaiver()],
      fixtureObservation([fixtureObserved({ symbol: "renamedExample" })]),
    ),
    "undeclared security suppression",
  );

  expectError(
    "an expired temporary waiver",
    inspect(
      [temporaryWaiver("2025-12-31")],
      fixtureObservation([fixtureObserved()]),
    ),
    "expired on 2025-12-31",
  );

  expectClean(
    "a temporary waiver still in date",
    inspect(
      [temporaryWaiver("2026-06-30")],
      fixtureObservation([fixtureObserved()]),
    ),
  );

  expectError(
    "a waiver for a rule outside the security tier",
    inspect(
      [permanentWaiver({ rule: "no-db-await-in-loop/no-db-await-in-loop" })],
      fixtureObservation([]),
    ),
    "is not a security-tier rule",
  );

  expectError(
    "duplicate waiver ids",
    inspect(
      [permanentWaiver(), permanentWaiver({ symbol: "otherExample" })],
      fixtureObservation([
        fixtureObserved(),
        fixtureObserved({ symbol: "otherExample" }),
      ]),
    ),
    "duplicate waiver id",
  );

  expectError(
    "two entries for one identity",
    inspect(
      [permanentWaiver(), permanentWaiver({ id: "SW-0002" })],
      fixtureObservation([fixtureObserved()]),
    ),
    "duplicate entry for",
  );

  expectError(
    "a rule-less disable directive",
    inspect([], fixtureObservation([], ["apps/api/src/handlers/bare.ts"])),
    "silences every rule",
  );

  expectError(
    "evidence pointing at a file that does not exist",
    inspectLedger({
      ledger: { waivers: [permanentWaiver()] },
      observation: fixtureObservation([fixtureObserved()]),
      evidenceExists: () => false,
      today: "2026-01-01",
    }),
    "does not exist",
  );

  // Shape validation, on the JSON as authored rather than the parsed form.
  const shapeCases = [
    {
      name: "a permanent waiver carrying an expiry",
      raw: { ...permanentWaiver(), expires: "2026-06-30" },
      fragment: "must not carry an expiry",
    },
    {
      name: "a temporary waiver with no expiry",
      raw: { ...permanentWaiver(), kind: "temporary" },
      fragment: "needs an expires date",
    },
    {
      name: "a waiver with no evidence",
      raw: { ...permanentWaiver(), evidence: "" },
      fragment: "evidence must locate",
    },
    {
      name: "a waiver with no reason",
      raw: { ...permanentWaiver(), reason: "" },
      fragment: "reason must explain",
    },
    {
      name: "a free-form waiver id",
      raw: { ...permanentWaiver(), id: "waiver-1" },
      fragment: "stable id of the form",
    },
    {
      name: "a zero count",
      raw: { ...permanentWaiver(), count: 0 },
      fragment: "count must be a positive",
    },
    {
      name: "an unknown kind",
      raw: { ...permanentWaiver(), kind: "provisional" },
      fragment: "kind must be one of",
    },
  ] as const;

  for (const { name, raw, fragment } of shapeCases) {
    const parsed = parseLedger({ waivers: [raw] });
    if (
      parsed.status !== "invalid" ||
      !parsed.errors.some((error) => error.includes(fragment))
    ) {
      failures.push(`ledger parsing did not reject ${name}`);
    }
  }

  if (parseLedger([]).status !== "invalid") {
    failures.push("ledger parsing accepted a non-object ledger");
  }

  // Scanning: only security-tier rules reach the ledger, and the anchor is the
  // enclosing top-level symbol rather than anything line-derived.
  const file = "apps/api/src/handlers/example.ts";
  const { observed } = observeSecurityDirectives([file], () => SOURCE_FIXTURE);
  const keys = observed.map(describeIdentity);
  const expectedKeys = [
    `${OTHER_RULE} at ${file} (otherExample)`,
    `${FIXTURE_RULE} at ${file} (listExample)`,
  ];
  for (const expected of expectedKeys) {
    if (!keys.includes(expected)) {
      failures.push(`scanning missed ${expected}; saw ${keys.join(", ")}`);
    }
  }
  if (observed.length !== expectedKeys.length) {
    failures.push(
      `scanning charged the ledger ${observed.length} entries, expected ${expectedKeys.length} (a data-volume directive must not need a waiver)`,
    );
  }

  const shifted = observeSecurityDirectives(
    ["apps/api/src/handlers/shifted.ts"],
    () => SHIFTED_FIXTURE,
  ).observed.at(0);
  if (shifted?.symbol !== "listExample") {
    failures.push(
      `anchor moved when the directive shifted inside its function: ${shifted?.symbol ?? "none"}`,
    );
  }

  const trailing = observeSecurityDirectives(
    ["apps/api/src/handlers/trailing.ts"],
    () => TRAILING_FIXTURE,
  ).observed.at(0);
  if (trailing?.symbol !== "import @/api/db/auth-schema") {
    failures.push(
      `a trailing disable-line directive anchored to ${trailing?.symbol ?? "none"} instead of its own import`,
    );
  }

  if (failures.length > 0) {
    console.error("suppression-waivers --self-test: FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }
  console.log("suppression-waivers --self-test: PASS");
  return 0;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--seed")) {
    return runSeed();
  }
  if (process.argv.includes("--check")) {
    return runCheck();
  }
  return runReport();
};

if (import.meta.main) {
  process.exit(main());
}
