import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { caseLawSources } from "@/api/db/schema";
/**
 * Re-parse decisions a source already ingested, from the raw payload stored
 * with each of them, without fetching anything from the publisher.
 *
 * The payload every ingest writes to object storage
 * (`case_law_decisions.source_raw_s3_key`) is what makes this local: a
 * parser change can be applied to stored decisions instead of waiting for a
 * rate-limited re-crawl. Each re-parsed result goes through the ingestion
 * pipeline's own `processDecision`, so corpus-object storage, the content
 * hash, the search projection's staleness marker and citation extraction all
 * behave exactly as they do on a crawl.
 *
 *   # what a run would change, writing nothing (the default)
 *   bun run src/scripts/replay-case-law-source.ts --adapter eu-ecj --limit 20
 *
 *   # one decision, by the publisher id the adapter stored in metadata
 *   bun run src/scripts/replay-case-law-source.ts --adapter eu-ecj \
 *     --celex 62022CJ0123 --apply
 *
 *   # one court after deploying a parser improvement for that court
 *   bun run src/scripts/replay-case-law-source.ts --adapter cz-nss \
 *     --court "Nejvyšší správní soud" --apply
 *
 *   # take back rows whose stored payload re-parses to no document at all
 *   bun run src/scripts/replay-case-law-source.ts --adapter eu-ecj \
 *     --withdraw-rejected --apply
 *
 *   # resume where an interrupted run stopped
 *   bun run src/scripts/replay-case-law-source.ts --adapter eu-ecj \
 *     --after <decisionId> --apply
 *
 * Not a scheduled job: it runs when a parser changes, under an operator who
 * reads the report.
 */
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import {
  acquireReplayLease,
  CASE_LAW_REPLAY_SCOPE,
  countReplayability,
  REPLAY_REJECTION_POLICY,
  REPLAY_ROW_OUTCOME,
  replayCapability,
  replayCaseLawSource,
} from "@/api/handlers/case-law/ingestion/replay";
import type {
  CaseLawReplayScope,
  StoredRawReader,
} from "@/api/handlers/case-law/ingestion/replay";
import { enterCaseLawMaintenanceLane } from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  readS3ObjectIfPresent,
  refreshCorpusS3,
  refreshS3,
} from "@/api/lib/s3";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

// Hold the maintenance lane before the first statement: operator passes over
// the case-law tables serialize here instead of deadlocking on row locks.
const { ingestionDb } = await enterCaseLawMaintenanceLane();

const DEFAULT_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_LEASE_WAIT_MINUTES = 30;
const MINUTE_MS = 60_000;
/** A stored payload is one document; nothing here should take longer. */
const STORED_RAW_READ_TIMEOUT_MS = 30_000;

const USAGE = `Usage: bun run src/scripts/replay-case-law-source.ts --adapter <key> [options]

  --adapter <key>   Required. Adapter whose source is replayed.
  --apply           Write the re-parsed results. Omitted, the run reports
                    what it would change and writes nothing.
  --withdraw-rejected
                    Take back the stored document of a decision whose
                    payload re-parses to no document at all. The row, its
                    metadata and its stored payload are kept. Without it
                    such a row is only reported.
  --limit <n>       Maximum decisions to visit (default ${DEFAULT_LIMIT}).
  --court <name>    Replay only decisions from this exact court.
  --celex <value>   Replay only the decision stored under this publisher id
                    (metadata.celex).
  --after <id>      Resume strictly after this decision id.
  --page-size <n>   Rows read per query (default ${DEFAULT_PAGE_SIZE}).
  --lease-wait <minutes>
                    How long an --apply run waits for the source's ingestion
                    lease before giving up (default ${DEFAULT_LEASE_WAIT_MINUTES}).
                    0 attempts once and exits if the lease is held.`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    process.exit(1);
  }
  return value;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Bounds a numeric flag accepts, with the wording its refusal uses. */
const INTEGER_BOUND = {
  POSITIVE: { minimum: 1, wording: "a positive integer" },
  NON_NEGATIVE: { minimum: 0, wording: "a non-negative integer" },
} as const;

type IntegerBound = (typeof INTEGER_BOUND)[keyof typeof INTEGER_BOUND];

type IntegerFlagOptions = {
  bound: IntegerBound;
  fallback: number;
  name: string;
  raw: string | undefined;
};

// The whole value has to be digits. `Number.parseInt` reads a prefix and
// stops, so "30minutes" would pass as 30 minutes, "0.5" as 0 and "1e3" as 1:
// every one of them a bound the operator did not ask for.
const DECIMAL_DIGITS = /^\d+$/u;

const integerFlag = ({
  bound,
  fallback,
  name,
  raw,
}: IntegerFlagOptions): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !DECIMAL_DIGITS.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < bound.minimum
  ) {
    console.error(`--${name} must be ${bound.wording}, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

const adapterKey = flagValue("adapter");
if (adapterKey === undefined || adapterKey.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

const apply = hasFlag("apply");
const rejectionPolicy = hasFlag("withdraw-rejected")
  ? REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT
  : REPLAY_REJECTION_POLICY.REPORT;
const limit = integerFlag({
  bound: INTEGER_BOUND.POSITIVE,
  fallback: DEFAULT_LIMIT,
  name: "limit",
  raw: flagValue("limit"),
});
const pageSize = integerFlag({
  bound: INTEGER_BOUND.POSITIVE,
  fallback: DEFAULT_PAGE_SIZE,
  name: "page-size",
  raw: flagValue("page-size"),
});
const leaseWaitMinutes = integerFlag({
  bound: INTEGER_BOUND.NON_NEGATIVE,
  fallback: DEFAULT_LEASE_WAIT_MINUTES,
  name: "lease-wait",
  raw: flagValue("lease-wait"),
});
const celex = flagValue("celex");
const court = flagValue("court");
if (celex?.length === 0) {
  console.error("--celex requires a non-empty value");
  process.exit(1);
}
if (court?.length === 0) {
  console.error("--court requires a non-empty value");
  process.exit(1);
}
if (celex !== undefined && court !== undefined) {
  console.error("--celex and --court are mutually exclusive replay scopes");
  process.exit(1);
}
const replayScope = (): CaseLawReplayScope => {
  if (court !== undefined) {
    return { type: "court", court };
  }
  if (celex !== undefined) {
    return { type: "celex", celex };
  }
  return CASE_LAW_REPLAY_SCOPE.SOURCE;
};
const scope = replayScope();
const afterArgument = flagValue("after");
const after =
  afterArgument === undefined
    ? null
    : brandPersistedCaseLawDecisionId(afterArgument);

const adapter = getAdapter(adapterKey);
if (!adapter) {
  console.error(`Unknown adapter: ${adapterKey}`);
  process.exit(1);
}

// Said out loud, because "nothing replayed" and "this adapter cannot replay"
// read the same in a summary, and only one of them means the decisions have
// to be re-fetched from the publisher.
const UNSUPPORTED_ADAPTER_MESSAGE = (key: string): string =>
  `Adapter ${key} cannot re-parse a stored payload: its stored raw does not ` +
  "map one payload to one decision. These decisions can only be re-parsed " +
  "by re-crawling the source.";

// Refused here as well as inside the run, so an unsupported adapter costs no
// database connection, no object-store client and no ingestion lease.
const capability = replayCapability(adapter);
if (capability.type === "unsupported") {
  console.error(UNSUPPORTED_ADAPTER_MESSAGE(capability.adapterKey));
  process.exit(1);
}

await refreshS3();
await refreshCorpusS3();

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

const split = await countReplayability({
  scopedDb: ingestionDb,
  sourceId: source.id,
  scope,
});
console.log(`=== REPLAY ${adapterKey} (${source.name}) ===`);
console.log(`mode:                ${apply ? "apply" : "dry run"}`);
console.log(`rejected rows:       ${rejectionPolicy}`);
console.log(`replayable locally:  ${split.storedLocally}`);
console.log(`needs a re-fetch:    ${split.needsRefetch}`);
if (celex !== undefined) {
  console.log(`targeting celex:     ${celex}`);
}
if (court !== undefined) {
  console.log(`targeting court:     ${court}`);
}

// `null` only where the store confirmed it holds no such object, which is a
// durable fact about that decision. A timeout, a refused credential or a
// dropped connection is raised instead: it says nothing about the row, and
// recording it as an absent payload would let a resume step over rows whose
// payloads are there.
const readStoredRaw: StoredRawReader = async (key) => {
  const bytes = await readS3ObjectIfPresent(
    key,
    AbortSignal.timeout(STORED_RAW_READ_TIMEOUT_MS),
  );
  return bytes === null ? null : new Uint8Array(bytes);
};

// A writing run takes the source's ingestion lease: it allocates observation
// orders from the same counter a crawl does, and the two must not interleave.
// A dry run writes nothing and takes nothing.
const acquisition = apply
  ? await acquireReplayLease({
      acquire: async () =>
        await acquireCaseLawSourceIngestionLease({
          scopedDb: ingestionDb,
          sourceId: source.id,
        }),
      waitBudgetMs: leaseWaitMinutes * MINUTE_MS,
      onWaitStart: () => {
        console.log(
          `lease held:          waiting up to ${leaseWaitMinutes} min for the running ingestion to release ${adapterKey}`,
        );
      },
    })
  : null;

if (acquisition?.type === "unavailable") {
  console.error(
    `Source ${adapterKey} is being ingested right now (lease held). Retry later.`,
  );
  process.exit(1);
}
if (acquisition !== null && acquisition.waitedMs > 0) {
  console.log(
    `lease acquired:      after ${String(acquisition.waitedMs / 1000)} s of waiting`,
  );
}
const sourceLease = acquisition?.lease ?? null;

const replayed = await Result.tryPromise({
  try: async () =>
    await replayCaseLawSource({
      adapter,
      scopedDb: ingestionDb,
      sourceId: source.id,
      readStoredRaw,
      sourceLease,
      limit,
      pageSize,
      after,
      scope,
      rejectionPolicy,
    }),
  catch: (cause) => cause,
});

// Released on both paths: a lease left behind blocks the source's next
// ingestion cycle until it expires.
await sourceLease?.release();

if (Result.isError(replayed)) {
  console.error("Replay failed:", replayed.error);
  process.exit(1);
}
if (replayed.value.type === "unsupported") {
  console.error(UNSUPPORTED_ADAPTER_MESSAGE(replayed.value.adapterKey));
  process.exit(1);
}
if (replayed.value.type === "unknown-boundary") {
  console.error(
    `--after ${replayed.value.after} is outside the selected ${scope.type} scope for ${adapterKey}. ` +
      "Resume from an id this scope's own run reported.",
  );
  process.exit(1);
}
const { report } = replayed.value;

console.log("--- outcomes ---");
for (const [outcome, count] of Object.entries(report.outcomes)) {
  console.log(`${outcome.padEnd(20)} ${count}`);
}
// Counted for a withdrawn row too: the reason it was withdrawn is the
// rejection its re-parse reported.
if (Object.values(report.rejections).some((count) => count > 0)) {
  console.log("--- rejections ---");
  for (const [rejection, count] of Object.entries(report.rejections)) {
    console.log(`${rejection.padEnd(20)} ${count}`);
  }
}
for (const problem of report.problems) {
  console.log(
    `${problem.outcome}: ${problem.caseNumber} (${problem.language}) ${problem.id} ${problem.detail ?? ""}`,
  );
}
console.log(`visited:             ${report.visited} of at most ${limit}`);
if (report.resumeAfter !== null) {
  console.log(`resume with:         --after ${report.resumeAfter}`);
}
if (report.haltReason !== null) {
  console.log(`halted:              ${report.haltReason}`);
}
if (!apply) {
  console.log(
    `would withdraw:      ${report.outcomes[REPLAY_ROW_OUTCOME.WOULD_WITHDRAW]}`,
  );
  console.log("Dry run: nothing was written. Re-run with --apply.");
}

process.exit(report.haltReason === null ? 0 : 1);
