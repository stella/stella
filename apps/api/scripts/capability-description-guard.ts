// Capability description guard (exact-id ledger).
//
// A capability's `description` is executable interface documentation, not a
// comment: the exporter carries it from the handler config into the committed
// catalog, and from there it becomes the generated CLI command's
// `--help` brief and the prose an MCP client reads before deciding whether to
// call the tool. A capability without one is briefed to an agent as "Invoke the
// <id> capability", which is no basis for that decision.
//
// This guard replaces the aggregate `capabilities-without-description` ratchet
// metric with an exact-id ledger (`apps/api/capability-description-ledger.json`):
// every capability that is currently missing a description is listed by id. Any
// set of the same size satisfies a count; a ledger names them, so the debt is
// reviewable, attributable, and can only shrink:
//
//   1. a capability missing a description that is NOT in the ledger fails — new
//      debt is forbidden, so a handler added today must carry prose;
//   2. a ledger entry whose capability now HAS a description fails as stale —
//      authoring prose means deleting the line in the same change, so the
//      ledger can never overstate the remaining work;
//   3. a ledger entry naming a capability that no longer exists fails as stale,
//      so a renamed or removed handler cannot leave a phantom entry that would
//      later admit a real gap under the same id;
// The ledger is the debt list, not a waiver list: there is no "reviewed
// exception" tier. It ends empty, at which point `description` becomes a
// required field on HandlerConfig and this guard retires.
//
// Reads the committed catalog rather than importing the handler graph: no env,
// no module loading, and the artifact is already pinned to the live
// handlers by the capability-catalog drift guard
// (`export-capability-catalog.ts --check`), which runs beside this one. A stale
// artifact therefore cannot hide debt from this guard without failing that one.
//
// Modes:
//   bun apps/api/scripts/capability-description-guard.ts               CI gate (exit 1 on failure)
//   bun apps/api/scripts/capability-description-guard.ts --write-ledger regenerate the ledger
//   bun apps/api/scripts/capability-description-guard.ts --self-test    prove the detectors fire
//
// Wired into `.github/workflows/ci.yml` and `bun run verify` next to the
// capability-catalog drift guard.

import { panic } from "better-result";
import path from "node:path";

import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import { REPO_ROOT } from "./lib/enumerate-safe-handlers";

const LEDGER_PATH = path.resolve(
  REPO_ROOT,
  "apps/api/capability-description-ledger.json",
);

const CATALOG_PATH = "packages/cli/capability-catalog.json";

type CatalogEntry = { id: string; description?: string };

/**
 * Ids of capabilities carrying no usable description, sorted. Blank and
 * whitespace-only prose counts as missing so an empty string cannot be used to
 * clear a ledger line without writing anything.
 */
export const findUndescribedIds = (
  entries: readonly CatalogEntry[],
): string[] =>
  entries
    .filter(
      ({ description }) =>
        description === undefined || description.trim().length === 0,
    )
    .map(({ id }) => id)
    .sort();

export type LedgerDiff = {
  /** Undescribed capabilities absent from the ledger: new debt. */
  unledgered: string[];
  /** Ledger entries whose capability now has a description: debt paid, line must go. */
  described: string[];
  /** Ledger entries naming a capability that is not in the catalog at all. */
  unknown: string[];
  /** Ledger entries that are out of order or duplicated. */
  malformed: string[];
};

type LedgerDiffInput = {
  undescribed: readonly string[];
  ledger: readonly string[];
  catalogIds: readonly string[];
};

/**
 * The full ledger comparison. Pure so the self-test and the unit suite can
 * exercise every branch without touching the filesystem.
 */
export const computeLedgerDiff = ({
  undescribed,
  ledger,
  catalogIds,
}: LedgerDiffInput): LedgerDiff => {
  const undescribedSet = new Set(undescribed);
  const ledgerSet = new Set(ledger);
  const catalogSet = new Set(catalogIds);

  const unledgered = undescribed.filter((id) => !ledgerSet.has(id)).sort();
  const described = ledger
    .filter((id) => catalogSet.has(id) && !undescribedSet.has(id))
    .sort();
  const unknown = ledger.filter((id) => !catalogSet.has(id)).sort();

  // A ledger that is unsorted or holds a duplicate produces noisy diffs and can
  // hide a line during review, so the file's own shape is part of the contract.
  const sorted = [...ledger].sort();
  const malformed =
    ledger.length === new Set(ledger).size &&
    ledger.every((id, index) => id === sorted[index])
      ? []
      : [...new Set(ledger)].sort();

  return { unledgered, described, unknown, malformed };
};

const readCatalog = async (relativePath: string): Promise<CatalogEntry[]> => {
  const absolute = path.resolve(REPO_ROOT, relativePath);
  const raw: unknown = await Bun.file(absolute).json();
  const parsed = parseCapabilityCatalog(raw);
  if (parsed === null) {
    return panic(
      `capability-description-guard: ${relativePath} is not a valid capability catalog.`,
    );
  }
  return parsed.map(({ id, description }) =>
    description === undefined ? { id } : { id, description },
  );
};

const readLedger = async (): Promise<string[]> => {
  const file = Bun.file(LEDGER_PATH);
  if (!(await file.exists())) {
    return [];
  }
  const parsed: unknown = await file.json();
  if (!Array.isArray(parsed)) {
    return panic(
      `capability-description-guard: ${LEDGER_PATH} must be a JSON array of capability ids.`,
    );
  }
  const entries: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") {
      return panic(
        `capability-description-guard: ${LEDGER_PATH} must be a JSON array of capability ids.`,
      );
    }
    entries.push(item);
  }
  return entries;
};

const writeLedger = async (ids: readonly string[]): Promise<void> => {
  const sorted = [...ids].sort();
  await Bun.write(LEDGER_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
};

type Loaded = {
  catalogIds: string[];
  undescribed: string[];
};

const loadCatalog = async (): Promise<Loaded> => {
  const entries = await readCatalog(CATALOG_PATH);
  return {
    catalogIds: entries.map(({ id }) => id).sort(),
    undescribed: findUndescribedIds(entries),
  };
};

const runCheck = async (): Promise<number> => {
  const { catalogIds, undescribed } = await loadCatalog();

  if (catalogIds.length === 0) {
    console.error(
      "\ncapability-description-guard: the catalog is empty — the guard did not exercise anything. Fix the committed catalog before trusting a green run.",
    );
    return 1;
  }

  let failed = false;

  const ledger = await readLedger();
  const { unledgered, described, unknown, malformed } = computeLedgerDiff({
    undescribed,
    ledger,
    catalogIds,
  });

  if (unledgered.length > 0) {
    failed = true;
    console.error(
      "\ncapability-description-guard: these capabilities have no `description` and are not in the ledger. The ledger can only shrink: write the prose on the handler config (see CapabilityDescription in apps/api/src/lib/api-handlers.ts), do not add new gaps:",
    );
    for (const id of unledgered) {
      console.error(`  ${id}`);
    }
  }

  if (described.length > 0) {
    failed = true;
    console.error(
      "\ncapability-description-guard: these ledger entries now have a description. Delete their lines from apps/api/capability-description-ledger.json in the same change that authored the prose:",
    );
    for (const id of described) {
      console.error(`  ${id}`);
    }
  }

  if (unknown.length > 0) {
    failed = true;
    console.error(
      "\ncapability-description-guard: these ledger entries name a capability that is not in the catalog (renamed, removed, or no longer exposed). Remove them so a future capability cannot inherit the gap under the same id:",
    );
    for (const id of unknown) {
      console.error(`  ${id}`);
    }
  }

  if (malformed.length > 0) {
    failed = true;
    console.error(
      "\ncapability-description-guard: apps/api/capability-description-ledger.json must be a sorted, duplicate-free list of ids. Regenerate it: `bun apps/api/scripts/capability-description-guard.ts --write-ledger`.",
    );
  }

  if (failed) {
    return 1;
  }

  console.log(
    `capability-description-guard: OK. ${catalogIds.length} capabilities; ${undescribed.length} without a description, all ledgered; ${catalogIds.length - undescribed.length} described.`,
  );
  return 0;
};

const runWriteLedger = async (): Promise<number> => {
  const { undescribed } = await loadCatalog();
  await writeLedger(undescribed);
  console.log(
    `capability-description-guard --write-ledger: wrote ${undescribed.length} capability ids to apps/api/capability-description-ledger.json`,
  );
  return 0;
};

// Self-test: prove each detector fires on synthetic input, through the same
// pure functions the real check uses. A broken detector cannot pass here.
const runSelfTest = (): number => {
  const failures: string[] = [];

  const undescribed = findUndescribedIds([
    { id: "a.get", description: "Reads an a." },
    { id: "b.get" },
    { id: "c.get", description: "   " },
    { id: "d.get", description: "" },
  ]);
  if (undescribed.join(",") !== "b.get,c.get,d.get") {
    failures.push(
      `findUndescribedIds did not treat absent/blank prose as missing (got ${undescribed.join(",")})`,
    );
  }

  const newDebt = computeLedgerDiff({
    undescribed: ["a.get", "b.get"],
    ledger: ["a.get"],
    catalogIds: ["a.get", "b.get"],
  });
  if (newDebt.unledgered.join(",") !== "b.get") {
    failures.push("computeLedgerDiff did not flag an unledgered capability");
  }

  const paid = computeLedgerDiff({
    undescribed: [],
    ledger: ["a.get"],
    catalogIds: ["a.get"],
  });
  if (paid.described.join(",") !== "a.get") {
    failures.push(
      "computeLedgerDiff did not flag a ledger entry that now has a description",
    );
  }

  const gone = computeLedgerDiff({
    undescribed: [],
    ledger: ["ghost.get"],
    catalogIds: ["a.get"],
  });
  if (gone.unknown.join(",") !== "ghost.get") {
    failures.push(
      "computeLedgerDiff did not flag a ledger entry naming a capability that no longer exists",
    );
  }

  const unsorted = computeLedgerDiff({
    undescribed: ["a.get", "b.get"],
    ledger: ["b.get", "a.get"],
    catalogIds: ["a.get", "b.get"],
  });
  if (unsorted.malformed.length === 0) {
    failures.push("computeLedgerDiff did not flag an unsorted ledger");
  }

  const duplicated = computeLedgerDiff({
    undescribed: ["a.get"],
    ledger: ["a.get", "a.get"],
    catalogIds: ["a.get"],
  });
  if (duplicated.malformed.length === 0) {
    failures.push("computeLedgerDiff did not flag a duplicated ledger entry");
  }

  const clean = computeLedgerDiff({
    undescribed: ["a.get", "b.get"],
    ledger: ["a.get", "b.get"],
    catalogIds: ["a.get", "b.get", "c.get"],
  });
  if (
    clean.unledgered.length > 0 ||
    clean.described.length > 0 ||
    clean.unknown.length > 0 ||
    clean.malformed.length > 0
  ) {
    failures.push("computeLedgerDiff flagged an exactly-matching ledger");
  }

  if (failures.length > 0) {
    console.error("capability-description-guard --self-test: FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }
  console.log("capability-description-guard --self-test: PASS");
  return 0;
};

const main = async (): Promise<number> => {
  if (process.argv.includes("--self-test")) {
    return runSelfTest();
  }
  if (process.argv.includes("--write-ledger")) {
    return await runWriteLedger();
  }
  return await runCheck();
};

if (import.meta.main) {
  process.exit(await main());
}
