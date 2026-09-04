import { panic } from "better-result";

import { SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import {
  getAdapter,
  listAdapterKeys,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
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

Options:
  --adapter <key>        Required with --total; narrows --poll to one source.
  --as-of <YYYY-MM-DD>   The day the figure was stated (default: now).

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
const totalFlag = flagValue("total");
const adapterFlag = flagValue("adapter");
const asOfFlag = flagValue("as-of");

const modes = [list, poll, totalFlag !== undefined].filter(Boolean);
if (modes.length !== 1) {
  console.error("Exactly one of --list, --total or --poll is required.");
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

const asOf = (() => {
  if (asOfFlag === undefined) {
    return new Date();
  }
  // `new Date(string)` accepts locale-ambiguous forms: "01/02/2026" is
  // 2 January to its parser and 1 February to much of the world. It also
  // rolls a day that does not exist ("2026-02-31") forward into the next
  // month rather than rejecting it. `isoCalendarDay` is the shared guard
  // against both, used here rather than restated.
  const day = isoCalendarDay(asOfFlag);
  // A datetime canonicalizes to its date part, so requiring the round-trip
  // is what keeps an operator's time-of-day from being dropped in silence:
  // a figure is stated on a day, and only a bare day is accepted.
  if (day === null || day !== asOfFlag) {
    console.error(
      `--as-of must be a bare ISO calendar date (YYYY-MM-DD), got: ${asOfFlag}`,
    );
    process.exit(1);
  }
  // No zone to interpret, so the day is anchored at UTC midnight rather
  // than at whatever local midnight the operator's machine is in.
  return new Date(`${day}T00:00:00.000Z`);
})();

// --list only reads, so it takes no lane; --total and --poll record a figure
// and serialize with every other writing pass.
const { ingestionDb } = list
  ? await openCaseLawReadOnlySession()
  : await enterCaseLawMaintenanceLane();

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
