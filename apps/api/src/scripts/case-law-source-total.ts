import { panic, Result } from "better-result";

import type { Transaction } from "@/api/db/root";
import { SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import {
  getAdapter,
  listAdapterKeys,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  inspectListingCensus,
  runListingCensus,
} from "@/api/handlers/case-law/ingestion/listing-census";
import {
  readSourceReportedTotals,
  setSourceReportedTotal,
} from "@/api/handlers/case-law/ingestion/source-totals";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { isoCalendarDay } from "@/api/lib/dates";

/**
 * Read and set the total each case-law publisher reports holding.
 *
 * Held-vs-total coverage needs a denominator, and only some publishers
 * expose a cheap count. Those adapters implement `getTotalCount` and are
 * polled here; for the rest, an operator reads the publisher's own figure
 * and records it, with the origin kept alongside so a reader can tell a
 * measured number from a transcribed one.
 *
 * A poll that yields no count records NOTHING and says so. The stored total
 * is the last number the publisher actually stated, and a failed probe is not
 * evidence that it changed. Only a broken probe moves the exit code: an
 * adapter whose publisher simply states no total is reported and passed over,
 * so a full sweep is not permanently red. The adapter states which of the two
 * it is, so the report names the failing step instead of guessing.
 *
 *   # what is recorded today
 *   bun run src/scripts/case-law-source-total.ts --list
 *
 *   # transcribe a publisher's own figure
 *   bun run src/scripts/case-law-source-total.ts \
 *     --adapter cz-ns --total 123456 [--as-of 2026-08-11]
 *
 *   # poll every adapter that exposes a count, or just one
 *   bun run src/scripts/case-law-source-total.ts --poll [--adapter cz-us]
 *
 *   # sum a countless publisher's own listing (see ingestion/listing-census.ts)
 *   bun run src/scripts/case-law-source-total.ts \
 *     --census --adapter sk-us --max-slices 500 [--from ...] [--to ...] [--dry-run]
 *
 * Not a scheduled job: a deliberate operation under an operator who reads
 * the report.
 */

/** Publishers compute a full-range count slowly; the probe must outlast it. */
const POLL_TIMEOUT_MS = 120_000;

const USAGE = `Usage: bun run src/scripts/case-law-source-total.ts <mode> [options]

Modes (exactly one):
  --list                 Print the recorded total for every source.
  --total <n>            Record <n> for --adapter, origin "operator".
  --poll                 Poll adapters that expose a count, origin
                         "adapter-poll".
  --census               Sum what --adapter's publisher lists, slice by slice,
                         origin "listing-census"; resumable, one bounded run
                         per call.

Options:
  --adapter <key>        Required with --total and --census; narrows --poll.
  --as-of <YYYY-MM-DD>   The day the figure was stated (default: now).
  --max-slices <n>       Census: slices this run may list (required to run).
  --from <YYYY-MM-DD>    Census floor (default: the source's sweep floor).
  --to <YYYY-MM-DD>      Census end and as-of (default: resume the stored
                         census, or extend it to today).
  --dry-run              Census: print the plan, contact no publisher.

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
const poll = hasFlag("poll");
const census = hasFlag("census");
const dryRun = hasFlag("dry-run");
const totalFlag = flagValue("total");
const adapterFlag = flagValue("adapter");
const asOfFlag = flagValue("as-of");
const maxSlicesFlag = flagValue("max-slices");
const fromFlag = flagValue("from");
const toFlag = flagValue("to");

const modes = [list, poll, census, totalFlag !== undefined].filter(Boolean);
if (modes.length !== 1) {
  console.error(
    "Exactly one of --list, --total, --poll or --census is required.",
  );
  console.error(USAGE);
  process.exit(1);
}

const knownKeys = listAdapterKeys();
if (
  adapterFlag !== undefined &&
  !knownKeys.some((candidate) => candidate === adapterFlag)
) {
  console.error(`Unknown adapter: ${adapterFlag}`);
  console.error(USAGE);
  process.exit(1);
}

const bareDay = (name: string, raw: string): Date => {
  // `new Date(string)` accepts locale-ambiguous forms: "01/02/2026" is
  // 2 January to its parser and 1 February to much of the world. It also
  // rolls a day that does not exist ("2026-02-31") forward into the next
  // month rather than rejecting it. `isoCalendarDay` is the shared guard
  // against both, used here rather than restated.
  const day = isoCalendarDay(raw);
  // A datetime canonicalizes to its date part, so requiring the round-trip
  // is what keeps an operator's time-of-day from being dropped in silence:
  // a figure is stated on a day, and only a bare day is accepted.
  if (day === null || day !== raw) {
    console.error(
      `--${name} must be a bare ISO calendar date (YYYY-MM-DD), got: ${raw}`,
    );
    process.exit(1);
  }
  // No zone to interpret, so the day is anchored at UTC midnight rather
  // than at whatever local midnight the operator's machine is in.
  return new Date(`${day}T00:00:00.000Z`);
};

const asOf = asOfFlag === undefined ? new Date() : bareDay("as-of", asOfFlag);

// --list and a census dry run only read, so they take no lane; everything
// else records a figure and serializes with every other writing pass.
const { ingestionDb, rootDb } =
  list || (census && dryRun)
    ? await openCaseLawReadOnlySession()
    : await enterCaseLawMaintenanceLane();

if (census) {
  const adapter =
    adapterFlag === undefined ? undefined : getAdapter(adapterFlag);
  if (adapter === undefined) {
    console.error("--census requires --adapter.");
    console.error(USAGE);
    process.exit(1);
  }
  const maxSlices =
    maxSlicesFlag !== undefined && DECIMAL_INTEGER.test(maxSlicesFlag)
      ? Number.parseInt(maxSlicesFlag, 10)
      : Number.NaN;
  // The checkpoint lives in the source's configuration, which the ingestion
  // role may not write, so the census runs on the lane's owner connection.
  const request = {
    scopedDb: async <T>(operation: (tx: Transaction) => Promise<T>) =>
      await rootDb.transaction(operation),
    adapter,
    from: fromFlag === undefined ? undefined : bareDay("from", fromFlag),
    to: toFlag === undefined ? undefined : bareDay("to", toFlag),
    now: new Date(),
  };
  const plan = await inspectListingCensus(request);
  if (Result.isError(plan)) {
    console.error(plan.error.message);
    process.exit(1);
  }
  const { asOf: planAsOf, fromSlice, start, toSlice } = plan.value;
  console.log(
    `${adapter.key}: census ${fromSlice} .. ${toSlice} as of ${planAsOf.toISOString()}, ${start.type}`,
  );
  if (dryRun) {
    process.exit(0);
  }
  if (maxSlicesFlag === undefined) {
    console.error("--census requires --max-slices unless --dry-run.");
    process.exit(1);
  }
  const ran = await runListingCensus({
    ...request,
    maxSlices,
    sleep: async (ms) => {
      await Bun.sleep(ms);
    },
  });
  if (Result.isError(ran)) {
    console.error(
      `${ran.error.message}; every slice before it is kept, and a re-run resumes there`,
    );
    process.exit(1);
  }
  const outcome = ran.value;
  const report = ((): { line: string; exitCode: 0 | 1 } => {
    switch (outcome.type) {
      case "counting":
        return {
          line: `${outcome.checkpoint.counted.toLocaleString()} counted over ${outcome.checkpoint.slicesCounted} slices; re-run to continue at ${outcome.checkpoint.nextSlice}`,
          exitCode: 0,
        };
      case "completed":
        return {
          line: `recorded ${outcome.checkpoint.total.toLocaleString()} as of ${outcome.checkpoint.asOf} (listing-census)`,
          exitCode: 0,
        };
      case "already-complete":
        return {
          line: `unchanged, complete with ${outcome.checkpoint.total.toLocaleString()}`,
          exitCode: 0,
        };
      case "nothing-listed":
        return {
          line: "the publisher listed nothing over the whole range, nothing recorded",
          exitCode: 1,
        };
      case "superseded":
        return {
          line: `another run moved the checkpoint after ${outcome.slicesThisRun} slices`,
          exitCode: 1,
        };
      default: {
        outcome satisfies never;
        return panic(`Unhandled census outcome: ${JSON.stringify(outcome)}`);
      }
    }
  })();
  const line = `${adapter.key}: ${report.line}`;
  if (report.exitCode === 0) {
    console.log(line);
  } else {
    console.error(line);
  }
  process.exit(report.exitCode);
}

if (list) {
  const rows = await readSourceReportedTotals(ingestionDb);
  console.log("=== CASE-LAW SOURCE REPORTED TOTALS ===");
  for (const row of rows) {
    const total = row.reportedTotal?.toLocaleString() ?? "unrecorded";
    const asOfText = row.reportedTotalAsOf?.toISOString() ?? "-";
    const origin = row.reportedTotalOrigin ?? "-";
    console.log(
      `${row.adapterKey.padEnd(12)} ${total.padStart(12)}  ${asOfText}  ${origin}`,
    );
  }
  process.exit(0);
}

if (totalFlag !== undefined) {
  if (adapterFlag === undefined) {
    console.error("--total requires --adapter.");
    console.error(USAGE);
    process.exit(1);
  }
  const parsed = DECIMAL_INTEGER.test(totalFlag)
    ? Number.parseInt(totalFlag, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--total must be a positive integer, got: ${totalFlag}`);
    process.exit(1);
  }
  // The remaining bound on the number is the writer's, so it is reported
  // rather than restated: a value the column cannot hold should read as a
  // refused argument, not an unhandled rejection.
  const write = await setSourceReportedTotal({
    scopedDb: ingestionDb,
    adapterKey: adapterFlag,
    total: parsed,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  })
    .then((applied) => ({ ok: true, applied }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
  if (!write.ok) {
    console.error(
      `not recorded: ${write.error instanceof Error ? write.error.message : "the write failed"}`,
    );
    process.exit(1);
  }
  if (!write.applied) {
    console.error(`No case-law source configured for adapter ${adapterFlag}`);
    process.exit(1);
  }
  console.log(
    `${adapterFlag}: recorded ${parsed.toLocaleString()} as of ${asOf.toISOString()} (operator)`,
  );
  process.exit(0);
}

const POLL_OUTCOME = {
  RECORDED: "recorded",
  /**
   * The adapter's implementation answers null because its publisher exposes
   * no readable count — `SourceAdapter.getTotalCount` defines null as exactly
   * that. Not a failure: a sweep over every adapter would otherwise always end
   * in one, whatever the count-capable sources did.
   */
  NO_COUNT: "no-count",
  FAILED: "failed",
} as const;

type PollOutcome = (typeof POLL_OUTCOME)[keyof typeof POLL_OUTCOME];

type PollResult = {
  adapterKey: string;
  outcome: PollOutcome;
  line: string;
};

/**
 * One probe against one publisher. A poll that yields no usable number
 * writes nothing: the stored total is the last figure the publisher
 * actually stated, and a failed probe is not a statement that it changed.
 */
const pollOne = async (adapterKey: string): Promise<PollResult> => {
  const adapter = getAdapter(adapterKey);
  if (!adapter) {
    return {
      adapterKey,
      outcome: POLL_OUTCOME.FAILED,
      line: `${adapterKey}: no adapter registered, nothing recorded`,
    };
  }

  // The adapter classifies its own answer, so this reads a disposition rather
  // than inferring one: a broken probe moves the exit code and a permanently
  // countless source never does. A throw is this probe's own failure.
  const probe = await adapter
    .getTotalCount(AbortSignal.timeout(POLL_TIMEOUT_MS))
    .then((count) => ({ ok: true, count }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
  if (!probe.ok) {
    console.error(`${adapterKey}: poll failed —`, probe.error);
    return {
      adapterKey,
      outcome: POLL_OUTCOME.FAILED,
      line: `${adapterKey}: poll failed, nothing recorded`,
    };
  }
  const { count } = probe;
  switch (count.type) {
    case "no-count-endpoint":
      return {
        adapterKey,
        outcome: POLL_OUTCOME.NO_COUNT,
        line: `${adapterKey}: exposes no count, nothing recorded`,
      };
    case "probe-failed":
      return {
        adapterKey,
        outcome: POLL_OUTCOME.FAILED,
        line: `${adapterKey}: probe failed (${count.errorTag}), nothing recorded`,
      };
    case "count":
      break;
    default: {
      count satisfies never;
      return panic(`Unhandled source total: ${JSON.stringify(count)}`);
    }
  }
  // The writer owns what counts as a usable number, so its rules are not
  // restated here — but its rejection must not escape. The probes run
  // together, so a throw would reject the whole batch and lose the result of
  // every other adapter, including the ones that succeeded.
  const { total } = count;
  const write = await setSourceReportedTotal({
    scopedDb: ingestionDb,
    adapterKey,
    total,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  })
    .then((applied) => ({ ok: true, applied }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
  if (!write.ok) {
    return {
      adapterKey,
      outcome: POLL_OUTCOME.FAILED,
      line: `${adapterKey}: ${write.error instanceof Error ? write.error.message : "poll write failed"}, nothing recorded`,
    };
  }
  return write.applied
    ? {
        adapterKey,
        outcome: POLL_OUTCOME.RECORDED,
        line: `${adapterKey}: recorded ${total.toLocaleString()} (adapter-poll)`,
      }
    : {
        adapterKey,
        outcome: POLL_OUTCOME.FAILED,
        line: `${adapterKey}: no case-law source configured, not recorded`,
      };
};

// One request per publisher, and each publisher is a different host, so the
// sweep runs them together rather than serializing behind the slowest count.
const pollKeys = adapterFlag === undefined ? knownKeys : [adapterFlag];
const results = await Promise.all(pollKeys.map(pollOne));

for (const result of results) {
  console.log(result.line);
}

const tally = (outcome: PollOutcome): number =>
  results.filter((result) => result.outcome === outcome).length;

console.log("--- outcomes ---");
console.log(`recorded:    ${tally(POLL_OUTCOME.RECORDED)}`);
console.log(`no count:    ${tally(POLL_OUTCOME.NO_COUNT)}`);
console.log(`failed:      ${tally(POLL_OUTCOME.FAILED)}`);
process.exit(tally(POLL_OUTCOME.FAILED) > 0 ? 1 : 0);
