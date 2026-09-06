/**
 * Command line of `replay-case-law-source.ts`, parsed on its own.
 *
 * Parsed outside the script because the script holds the case-law
 * maintenance lane before its first statement: importing it to ask what a
 * flag means would open a database connection. It sits beside the run it
 * configures rather than under `scripts/`, since what it produces is the
 * replay's own vocabulary (its visit bound, scope and rejection policy) and
 * every module in `scripts/` that can reach the case-law tables is expected
 * to hold the lane. This one issues no statement at all.
 */
import { Result, TaggedError } from "better-result";

import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_REJECTION_POLICY,
} from "@/api/handlers/case-law/ingestion/replay";
import type {
  CaseLawReplayScope,
  ReplayRejectionPolicy,
  ReplayVisitBound,
} from "@/api/handlers/case-law/ingestion/replay";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

export const DEFAULT_LIMIT = 100;
const DEFAULT_PAGE_SIZE = 25;
export const DEFAULT_LEASE_WAIT_MINUTES = 30;

export const REPLAY_USAGE = `Usage: bun run src/scripts/replay-case-law-source.ts --adapter <key> [options]

  --adapter <key>   Required. Adapter whose source is replayed.
  --apply           Write the re-parsed results. Omitted, the run reports
                    what it would change and writes nothing.
  --withdraw-rejected
                    Take back the stored document of a decision whose
                    payload re-parses to no document at all. The row, its
                    metadata and its stored payload are kept. Without it
                    such a row is only reported.
  --limit <n>       Maximum decisions to visit (default ${DEFAULT_LIMIT}).
  --all             Visit every decision of the scope. Mutually exclusive
                    with --limit; what an unattended run wants, since a
                    capped run stops with the rest of the scope unvisited.
  --court <name>    Replay only decisions from this exact court.
  --celex <value>   Replay only the decision stored under this publisher id
                    (metadata.celex).
  --after <id>      Resume strictly after this decision id.
  --page-size <n>   Rows read per query (default ${DEFAULT_PAGE_SIZE}).
  --lease-wait <minutes>
                    How long an --apply run waits for the source's ingestion
                    lease before giving up (default ${DEFAULT_LEASE_WAIT_MINUTES}).
                    0 attempts once and exits if the lease is held.`;

export class ReplayArgumentsError extends TaggedError("ReplayArgumentsError")<{
  message: string;
}> {}

export type ReplayArguments = {
  adapterKey: string;
  after: SafeId<"caseLawDecision"> | null;
  apply: boolean;
  bound: ReplayVisitBound;
  leaseWaitMinutes: number;
  pageSize: number;
  rejectionPolicy: ReplayRejectionPolicy;
  scope: CaseLawReplayScope;
};

const invalid = (message: string) =>
  Result.err(new ReplayArgumentsError({ message }));

const hasFlag = (argv: readonly string[], name: string): boolean =>
  argv.includes(`--${name}`);

const readValue = (
  argv: readonly string[],
  name: string,
): Result<string | undefined, ReplayArgumentsError> => {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index === -1) {
    return Result.ok(undefined);
  }
  // Taking the first occurrence would let the later one through unread, so
  // `--limit 20 --limit 20rows` would run under a bound the operator did not
  // write and never hear about the one they did.
  if (argv.includes(flag, index + 1)) {
    return invalid(`${flag} was given more than once`);
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return invalid(`${flag} requires a value`);
  }
  return Result.ok(value);
};

/** Bounds a numeric flag accepts, with the wording its refusal uses. */
const INTEGER_BOUND = {
  POSITIVE: { minimum: 1, wording: "a positive integer" },
  NON_NEGATIVE: { minimum: 0, wording: "a non-negative integer" },
} as const;

type IntegerBound = (typeof INTEGER_BOUND)[keyof typeof INTEGER_BOUND];

// The whole value has to be digits. `Number.parseInt` reads a prefix and
// stops, so "20rows" would pass as 20, "0.5" as 0 and "1e3" as 1: every one
// of them a bound the operator did not ask for.
const DECIMAL_DIGITS = /^\d+$/u;

const boundedInteger = (
  raw: string,
  name: string,
  bound: IntegerBound,
): Result<number, ReplayArgumentsError> => {
  const parsed = Number.parseInt(raw, 10);
  if (
    !DECIMAL_DIGITS.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < bound.minimum
  ) {
    return invalid(`--${name} must be ${bound.wording}, got: ${raw}`);
  }
  return Result.ok(parsed);
};

type ReadIntegerOptions = {
  argv: readonly string[];
  bound: IntegerBound;
  fallback: number;
  name: string;
};

const readInteger = ({
  argv,
  bound,
  fallback,
  name,
}: ReadIntegerOptions): Result<number, ReplayArgumentsError> => {
  const raw = readValue(argv, name);
  if (Result.isError(raw)) {
    return raw;
  }
  return raw.value === undefined
    ? Result.ok(fallback)
    : boundedInteger(raw.value, name, bound);
};

const readVisitBound = (
  argv: readonly string[],
): Result<ReplayVisitBound, ReplayArgumentsError> => {
  const raw = readValue(argv, "limit");
  if (Result.isError(raw)) {
    return raw;
  }
  if (hasFlag(argv, "all")) {
    if (raw.value !== undefined) {
      return invalid("--all and --limit are mutually exclusive visit bounds");
    }
    return Result.ok({ type: "all" } as const satisfies ReplayVisitBound);
  }
  if (raw.value === undefined) {
    return Result.ok({
      type: "at-most",
      limit: DEFAULT_LIMIT,
    } as const satisfies ReplayVisitBound);
  }
  const limit = boundedInteger(raw.value, "limit", INTEGER_BOUND.POSITIVE);
  if (Result.isError(limit)) {
    return limit;
  }
  return Result.ok({
    type: "at-most",
    limit: limit.value,
  } as const satisfies ReplayVisitBound);
};

const readScope = (
  argv: readonly string[],
): Result<CaseLawReplayScope, ReplayArgumentsError> => {
  const celex = readValue(argv, "celex");
  if (Result.isError(celex)) {
    return celex;
  }
  const court = readValue(argv, "court");
  if (Result.isError(court)) {
    return court;
  }
  if (celex.value?.length === 0) {
    return invalid("--celex requires a non-empty value");
  }
  if (court.value?.length === 0) {
    return invalid("--court requires a non-empty value");
  }
  if (celex.value !== undefined && court.value !== undefined) {
    return invalid("--celex and --court are mutually exclusive replay scopes");
  }
  if (court.value !== undefined) {
    return Result.ok({
      type: "court",
      court: court.value,
    } as const satisfies CaseLawReplayScope);
  }
  if (celex.value !== undefined) {
    return Result.ok({
      type: "celex",
      celex: celex.value,
    } as const satisfies CaseLawReplayScope);
  }
  return Result.ok(CASE_LAW_REPLAY_SCOPE.SOURCE);
};

export const parseReplayArguments = (
  argv: readonly string[],
): Result<ReplayArguments, ReplayArgumentsError> => {
  const adapterKey = readValue(argv, "adapter");
  if (Result.isError(adapterKey)) {
    return adapterKey;
  }
  if (adapterKey.value === undefined || adapterKey.value.length === 0) {
    return invalid(REPLAY_USAGE);
  }

  const bound = readVisitBound(argv);
  if (Result.isError(bound)) {
    return bound;
  }
  const pageSize = readInteger({
    argv,
    bound: INTEGER_BOUND.POSITIVE,
    fallback: DEFAULT_PAGE_SIZE,
    name: "page-size",
  });
  if (Result.isError(pageSize)) {
    return pageSize;
  }
  const leaseWaitMinutes = readInteger({
    argv,
    bound: INTEGER_BOUND.NON_NEGATIVE,
    fallback: DEFAULT_LEASE_WAIT_MINUTES,
    name: "lease-wait",
  });
  if (Result.isError(leaseWaitMinutes)) {
    return leaseWaitMinutes;
  }
  const scope = readScope(argv);
  if (Result.isError(scope)) {
    return scope;
  }
  const after = readValue(argv, "after");
  if (Result.isError(after)) {
    return after;
  }

  return Result.ok({
    adapterKey: adapterKey.value,
    after:
      after.value === undefined
        ? null
        : brandPersistedCaseLawDecisionId(after.value),
    apply: hasFlag(argv, "apply"),
    bound: bound.value,
    leaseWaitMinutes: leaseWaitMinutes.value,
    pageSize: pageSize.value,
    rejectionPolicy: hasFlag(argv, "withdraw-rejected")
      ? REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT
      : REPLAY_REJECTION_POLICY.REPORT,
    scope: scope.value,
  });
};
