import { eq } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
/**
 * Read and un-retire the items the standing reconciliation loop is carrying.
 *
 * The loop parks an item it could not ingest, retries it on a widening
 * schedule, and retires it to `terminal` once the schedule is exhausted. That
 * is what lets a slice reach a fixed point instead of re-hunting the same
 * unservable document forever — and it is a statement about the publisher and
 * the adapter as they were when it was made. A fixed parser, or a publisher
 * that finally serves the document, changes that, and nothing in the loop
 * will ever look at those rows again.
 *
 * This is the operator entry that does. `--list` is the read that justifies a
 * reset: it names the identities that are stuck, in which slice, on what
 * error tag. `--reset-terminal` puts them back into the hunt as parked, due
 * immediately, so the next work unit re-attempts them.
 *
 *   # what one source is carrying
 *   bun run src/scripts/case-law-reconciliation-items.ts --list --adapter cz-ns
 *
 *   # the next page, and one slice on its own
 *   bun run src/scripts/case-law-reconciliation-items.ts --list --adapter cz-ns \
 *     --after 'document:2f0a1d6c-9c7f-4a58-bd4a-6c1e0f7a1b23'
 *   bun run src/scripts/case-law-reconciliation-items.ts --list --adapter cz-ns \
 *     --slice 2026-06-10
 *
 *   # re-hunt everything this source retired
 *   bun run src/scripts/case-law-reconciliation-items.ts \
 *     --reset-terminal --adapter cz-ns
 *
 *   # re-hunt one slice, after fixing what made that day fail
 *   bun run src/scripts/case-law-reconciliation-items.ts \
 *     --reset-terminal --adapter cz-ns --slice 2026-06-10 --limit 200
 *
 * Not a scheduled job: a reset re-spends the publisher's rate limit on
 * documents already proved unservable, so it runs under an operator who read
 * the listing and fixed the cause.
 */
import { listAdapterKeys } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import {
  countReconciliationItems,
  listReconciliationItems,
  resetTerminalReconciliationItems,
} from "@/api/lib/legal-search/reconciliation-store";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

/** Bounded by default: both modes read, and neither should scan a corpus. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

const USAGE = `Usage: bun run src/scripts/case-law-reconciliation-items.ts <mode> --adapter <key> [options]

Modes (exactly one):
  --list                 Print the parked and terminal items this source
                         carries, in identity-key order.
  --reset-terminal       Return terminal items to parked, due now, so the
                         loop re-hunts them.

Options:
  --adapter <key>        Required. The source to act on.
  --slice <slice>        Narrow to one slice, in either mode.
  --after <identityKey>  With --list, resume after this key. The last key a
                         page printed is the next page's --after.
  --limit <n>            Rows read or reset (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).

Adapter keys: ${listAdapterKeys().join(", ")}`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    console.error(USAGE);
    process.exit(1);
  }
  return value;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const DECIMAL_INTEGER = /^\d+$/u;

const list = hasFlag("list");
const resetTerminal = hasFlag("reset-terminal");
const adapterFlag = flagValue("adapter");
const sliceFlag = flagValue("slice");
const afterFlag = flagValue("after");
const limitFlag = flagValue("limit");

if ([list, resetTerminal].filter(Boolean).length !== 1) {
  console.error("Exactly one of --list or --reset-terminal is required.");
  console.error(USAGE);
  process.exit(1);
}

if (adapterFlag === undefined) {
  console.error("--adapter is required.");
  console.error(USAGE);
  process.exit(1);
}

const adapterKey = adapterFlag;
if (!listAdapterKeys().some((candidate) => candidate === adapterKey)) {
  console.error(`Unknown adapter: ${adapterKey}`);
  console.error(USAGE);
  process.exit(1);
}

// A cursor only means something against an ordering, and the reset selects
// its own rows. Refused rather than ignored: an operator who paged a listing
// and then reset would otherwise believe the reset resumed where they were.
if (afterFlag !== undefined && !list) {
  console.error("--after applies to --list only.");
  console.error(USAGE);
  process.exit(1);
}

const limit = (() => {
  if (limitFlag === undefined) {
    return DEFAULT_LIMIT;
  }
  const parsed = DECIMAL_INTEGER.test(limitFlag)
    ? Number.parseInt(limitFlag, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
    console.error(
      `--limit must be an integer between 1 and ${MAX_LIMIT}, got: ${limitFlag}`,
    );
    process.exit(1);
  }
  return parsed;
})();

const source = (
  await ingestionDb((tx) =>
    tx
      .select({ id: caseLawSources.id, name: caseLawSources.name })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, adapterKey))
      .limit(1),
  )
).at(0);

if (!source) {
  console.error(`No case-law source configured for adapter ${adapterKey}`);
  process.exit(1);
}

const counts = await countReconciliationItems(ingestionDb, source.id);
console.log(`=== RECONCILIATION ITEMS ${adapterKey} (${source.name}) ===`);
console.log(`parked:    ${counts.parked}`);
console.log(`terminal:  ${counts.terminal}`);

if (list) {
  const items = await listReconciliationItems(ingestionDb, {
    sourceId: source.id,
    limit,
    ...(sliceFlag === undefined ? {} : { slice: sliceFlag }),
    ...(afterFlag === undefined ? {} : { after: afterFlag }),
  });
  const scope = sliceFlag === undefined ? "all slices" : `slice ${sliceFlag}`;
  console.log(
    `--- ${items.length} item(s), ${scope}, of ${counts.parked + counts.terminal} total ---`,
  );
  for (const item of items) {
    const attempts = String(item.attempts).padStart(2);
    const next = item.nextAttemptAt?.toISOString() ?? "-";
    const seen = item.firstSeenAt.toISOString();
    console.log(
      `${item.status.padEnd(8)} ${item.slice.padEnd(12)} attempts=${attempts} firstSeen=${seen} next=${next} lastError=${item.lastError ?? "-"} ${item.identityKey}`,
    );
  }
  // The whole backlog is reachable by walking this cursor, so a page that
  // filled its limit says how to ask for the next one rather than leaving the
  // operator to assume they have seen everything.
  const lastKey = items.at(-1)?.identityKey;
  if (items.length === limit && lastKey !== undefined) {
    console.log(`next page: --after '${lastKey}'`);
  }
  process.exit(0);
}

const reset = await resetTerminalReconciliationItems(ingestionDb, {
  sourceId: source.id,
  now: new Date(),
  limit,
  ...(sliceFlag === undefined ? {} : { slice: sliceFlag }),
});

const scope = sliceFlag === undefined ? "all slices" : `slice ${sliceFlag}`;
console.log(`--- reset ---`);
console.log(
  `${adapterKey}: returned ${reset} terminal item(s) to parked (${scope})`,
);
// Bounded per run, so a source carrying more retired items than the limit
// needs another pass; saying so beats an operator assuming the source is now
// clear.
if (reset === limit) {
  console.log(`the limit of ${limit} was reached; run again to continue`);
}
process.exit(0);
