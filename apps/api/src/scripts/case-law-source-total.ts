import { rlsDb } from "@/api/db/root";
import { SOURCE_TOTAL_ORIGIN } from "@/api/db/schema";
import { createIngestionDb } from "@/api/db/scoped";
import {
  getAdapter,
  listAdapterKeys,
} from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  readSourceReportedTotals,
  setSourceReportedTotal,
} from "@/api/handlers/case-law/ingestion/source-totals";

/**
 * Read and set the total each case-law publisher reports holding.
 *
 * Held-vs-total coverage needs a denominator, and only some publishers
 * expose a cheap count. Those adapters implement `getTotalCount` and are
 * polled here; for the rest, an operator reads the publisher's own figure
 * and records it, with the origin kept alongside so a reader can tell a
 * measured number from a transcribed one.
 *
 * A poll that returns null or throws records NOTHING and says so. The
 * stored total is the last number the publisher actually stated, and a
 * failed probe is not evidence that it changed. Only a broken probe moves
 * the exit code: an adapter whose publisher simply states no total is
 * reported and passed over, so a full sweep is not permanently red.
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
  --as-of <ISO date>     When the figure was stated (default: now).

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

/**
 * ISO 8601 calendar date, optionally with a time that must carry its own
 * zone. A zoneless time would be read as the operator's local time and
 * stored as a different instant depending on where it was typed.
 */
const ISO_DATE =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

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
  // `new Date(string)` also accepts locale-ambiguous forms: "01/02/2026" is
  // 2 January to its parser and 1 February to much of the world. Requiring
  // the ISO grammar first means an operator cannot silently date a figure
  // eleven months wrong by writing it the way their locale does. A time,
  // when given, must carry its zone for the same reason.
  const match = ISO_DATE.exec(asOfFlag);
  if (!match?.groups) {
    console.error(
      `--as-of must be an ISO date (YYYY-MM-DD, or YYYY-MM-DDThh:mm:ssZ with a zone), got: ${asOfFlag}`,
    );
    process.exit(1);
  }
  // The grammar admits days that do not exist ("2026-02-31"), which the
  // parser silently rolls forward into March. Check the calendar fields
  // themselves: the parsed instant's UTC day is not usable here, because a
  // legitimate zone offset moves it either way.
  const year = Number(match.groups["year"]);
  const month = Number(match.groups["month"]);
  const day = Number(match.groups["day"]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    console.error(`--as-of is not a real calendar date: ${asOfFlag}`);
    process.exit(1);
  }
  const parsed = new Date(asOfFlag);
  if (Number.isNaN(parsed.getTime())) {
    console.error(`--as-of is not a valid date: ${asOfFlag}`);
    process.exit(1);
  }
  return parsed;
})();

const ingestionDb = createIngestionDb(rlsDb);

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
  const applied = await setSourceReportedTotal({
    scopedDb: ingestionDb,
    adapterKey: adapterFlag,
    total: parsed,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
  });
  if (!applied) {
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
   * The adapter states no total. Covers both an adapter that implements no
   * `getTotalCount` and one whose implementation answers null because its
   * publisher exposes no readable count — `SourceAdapter.getTotalCount`
   * defines null as exactly that. Not a failure: a sweep over every adapter
   * would otherwise always end in one, whatever the count-capable sources did.
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
  if (!adapter?.getTotalCount) {
    return {
      adapterKey,
      outcome: POLL_OUTCOME.NO_COUNT,
      line: `${adapterKey}: exposes no count, nothing recorded`,
    };
  }

  // A throw is a failure of this probe; a null is the adapter's own answer
  // that its publisher states no total. The two are kept apart so a broken
  // probe still moves the exit code and a permanently countless source
  // never does.
  const probe = await adapter
    .getTotalCount(AbortSignal.timeout(POLL_TIMEOUT_MS))
    .then((total) => ({ ok: true, total }) as const)
    .catch((error: unknown) => ({ ok: false, error }) as const);
  if (!probe.ok) {
    console.error(`${adapterKey}: poll failed —`, probe.error);
    return {
      adapterKey,
      outcome: POLL_OUTCOME.FAILED,
      line: `${adapterKey}: poll failed, nothing recorded`,
    };
  }
  if (probe.total === null) {
    return {
      adapterKey,
      outcome: POLL_OUTCOME.NO_COUNT,
      line: `${adapterKey}: exposes no count, nothing recorded`,
    };
  }
  if (probe.total <= 0) {
    // A publisher that answers with a count it cannot hold: refuse it here
    // rather than let the writer's own validation throw mid-sweep.
    return {
      adapterKey,
      outcome: POLL_OUTCOME.FAILED,
      line: `${adapterKey}: poll returned an unusable total (${probe.total}), nothing recorded`,
    };
  }
  const { total } = probe;

  const applied = await setSourceReportedTotal({
    scopedDb: ingestionDb,
    adapterKey,
    total,
    asOf,
    origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
  });
  return applied
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
