// Capability file-transport guard (exact-id ledger).
//
// A capability whose transport returns bytes, or requires a file input, is
// suppressed from the generic transport: the generated CLI drops it and
// capability executors refuse it, so no agent surface can reach it. Every
// suppressed capability is listed by id in
// `apps/api/capability-file-transport-ledger.json`, and the list can only
// shrink:
//
//   1. a suppressed capability that is NOT in the ledger fails, so a newly
//      file-shaped capability cannot silently disappear from both clients;
//   2. a ledger entry whose capability is invocable again fails as stale, so
//      exposing a fileless mode means deleting its line in the same change;
//   3. a ledger entry naming a capability that no longer exists fails as
//      stale, so a later capability cannot inherit the entry under its id.
//
// It replaces the `capability-file-transport-suppressed` ratchet metric, which
// counted committed catalog shards. The catalog is now derived in memory from
// the handler graph, so a clean checkout measures the real set. "Suppressed"
// is the CLI's own predicate (`isCatalogTransportInvocable`): a capability with
// an optional file input keeps its JSON modes and is not counted.
//
// Modes:
//   bun apps/api/scripts/capability-file-transport-guard.ts                CI gate (exit 1 on failure)
//   bun apps/api/scripts/capability-file-transport-guard.ts --write-ledger regenerate the ledger
//   bun apps/api/scripts/capability-file-transport-guard.ts --self-test    prove the detectors fire

import { panic } from "better-result";
import path from "node:path";

import { parseCapabilityCatalog } from "../../../packages/cli/src/capability-catalog-load";
import {
  type CatalogTransport,
  isCatalogTransportInvocable,
} from "../../../packages/cli/src/generate-capability-tree";
import { computeLedgerDiff } from "./capability-description-guard";
import { buildCapabilityCatalog } from "./export-capability-catalog";
import { REPO_ROOT } from "./lib/enumerate-safe-handlers";

const LEDGER_FILE = "apps/api/capability-file-transport-ledger.json";
const LEDGER_PATH = path.resolve(REPO_ROOT, LEDGER_FILE);

type CatalogEntry = {
  readonly id: string;
  readonly transport: CatalogTransport;
};

/** Ids of capabilities the generic transport cannot invoke, sorted. */
export const findSuppressedIds = (entries: readonly CatalogEntry[]): string[] =>
  entries
    .filter(({ transport }) => !isCatalogTransportInvocable(transport))
    .map(({ id }) => id)
    .toSorted();

/** The repository catalog, derived in memory from the live handler graph. */
export const readRepositoryCatalog = async (): Promise<CatalogEntry[]> => {
  const parsed = parseCapabilityCatalog(await buildCapabilityCatalog());
  if (parsed === null) {
    return panic(
      "capability-file-transport-guard: generated catalog is not a valid capability catalog.",
    );
  }
  return parsed.map(({ id, transport }) => ({ id, transport }));
};

export const readLedger = async (): Promise<string[]> => {
  const parsed: unknown = await Bun.file(LEDGER_PATH).json();
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item): item is string => typeof item === "string")
  ) {
    return panic(
      `capability-file-transport-guard: ${LEDGER_FILE} must be a JSON array of capability ids.`,
    );
  }
  return parsed;
};

const report = (heading: string, ids: readonly string[]): boolean => {
  if (ids.length === 0) {
    return false;
  }
  console.error(`\ncapability-file-transport-guard: ${heading}`);
  for (const id of ids) {
    console.error(`  ${id}`);
  }
  return true;
};

const runCheck = async (): Promise<number> => {
  const entries = await readRepositoryCatalog();
  if (entries.length === 0) {
    console.error(
      "\ncapability-file-transport-guard: the catalog is empty, so the guard measured nothing.",
    );
    return 1;
  }
  const suppressed = findSuppressedIds(entries);
  const { unledgered, described, unknown, malformed } = computeLedgerDiff({
    undescribed: suppressed,
    ledger: await readLedger(),
    catalogIds: entries.map(({ id }) => id).toSorted(),
  });
  const failed = [
    report(
      "these capabilities are suppressed from the generic transport and not in the ledger. Give them a fileless mode or a JSON alternative; add a line only with the reason in the same change:",
      unledgered,
    ),
    report(
      `these ledger entries are invocable over the generic transport again. Delete their lines from ${LEDGER_FILE}:`,
      described,
    ),
    report(
      `these ledger entries name a capability that is not in the catalog. Delete their lines from ${LEDGER_FILE}:`,
      unknown,
    ),
    report(
      `${LEDGER_FILE} must be a sorted, duplicate-free list. Regenerate it with \`bun apps/api/scripts/capability-file-transport-guard.ts --write-ledger\`:`,
      malformed,
    ),
  ].includes(true);
  if (failed) {
    return 1;
  }
  console.log(
    `capability-file-transport-guard: OK. ${entries.length} capabilities; ${suppressed.length} suppressed, all ledgered.`,
  );
  return 0;
};

const runWriteLedger = async (): Promise<number> => {
  const suppressed = findSuppressedIds(await readRepositoryCatalog());
  await Bun.write(LEDGER_PATH, `${JSON.stringify(suppressed, null, 2)}\n`);
  console.log(
    `capability-file-transport-guard --write-ledger: wrote ${suppressed.length} capability ids to ${LEDGER_FILE}`,
  );
  return 0;
};

// Prove the predicate through the same function the check uses.
const runSelfTest = (): number => {
  const suppressed = findSuppressedIds([
    { id: "a.list", transport: { type: "json" } },
    {
      id: "b.upload",
      transport: {
        type: "file-input",
        input: { field: "file", required: true },
      },
    },
    {
      id: "c.import",
      transport: {
        type: "file-input",
        input: { field: "file", required: false },
      },
    },
    { id: "d.export", transport: { type: "file-response" } },
    {
      id: "e.convert",
      transport: {
        type: "file-both",
        input: { field: "file", required: false },
      },
    },
  ]);
  if (suppressed.join(",") !== "b.upload,d.export,e.convert") {
    console.error(
      `capability-file-transport-guard --self-test: FAIL (got ${suppressed.join(",")})`,
    );
    return 1;
  }
  console.log("capability-file-transport-guard --self-test: PASS");
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
