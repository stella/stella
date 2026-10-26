/**
 * Command line of `requeue-sk-emptied-documents.ts`, and the run it drives.
 *
 * Kept outside the script so it can be tested without the maintenance lane
 * the script takes before its first statement. The run receives its database
 * handle and its sinks, so a test drives it against a test database and reads
 * what it would print and record.
 */
import { Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

import type { ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  MAX_EMPTIED_DOCUMENT_REQUEUE,
  MAX_EMPTIED_DOCUMENT_SCAN,
  requeueEmptiedDocuments,
  scanEmptiedDocuments,
} from "@/api/lib/legal-search/sk-emptied-document-repair";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

const DEFAULT_SCAN = 10_000;
const MIN_REASON_LENGTH = 8;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

export const EMPTIED_DOCUMENT_REPAIR_USAGE = `Usage: bun run src/scripts/requeue-sk-emptied-documents.ts --since <instant> [options]

  --since <instant>  Required. Only decisions whose last fetch attempt is at
                     or after this ISO instant (2026-01-01T00:00:00Z).
  --after <id>       Resume strictly after this decision id.
  --scan <n>         Decisions of the source visited at most (default
                     ${String(DEFAULT_SCAN)}, at most ${String(MAX_EMPTIED_DOCUMENT_SCAN)}).
  --results-out <path>
                     Write one JSON line per qualifying decision (id, outcome,
                     reason, actor) to this file, which must not exist yet.
                     Required with --apply; keep it outside the repository.
  --apply            Requeue the qualifying decisions. Omitted, the run
                     reports what it would requeue and writes nothing.
  --reason <text>    Required with --apply: why these decisions are requeued.
  --actor <name>     Required with --apply: who runs it.`;

export class EmptiedDocumentRepairArgumentsError extends TaggedError(
  "EmptiedDocumentRepairArgumentsError",
)<{ message: string }> {}

export type EmptiedDocumentRepairCommand = {
  since: Date;
  after: SafeId<"caseLawDecision"> | null;
  scan: number;
  resultsOut: string | null;
  write: { type: "dry-run" } | { type: "apply"; reason: string; actor: string };
};

const VALUE_FLAGS = [
  "--since",
  "--after",
  "--scan",
  "--results-out",
  "--reason",
  "--actor",
] as const;

const invalid = (message: string) =>
  Result.err(
    new EmptiedDocumentRepairArgumentsError({
      message: `${message}\n${EMPTIED_DOCUMENT_REPAIR_USAGE}`,
    }),
  );

const isValueFlag = (flag: string): flag is (typeof VALUE_FLAGS)[number] =>
  VALUE_FLAGS.some((name) => name === flag);

type ParseResult<T> = Result<T, EmptiedDocumentRepairArgumentsError>;

/** Every flag's value, and whether `--apply` was given; each flag at most once. */
const readFlags = (
  argv: readonly string[],
): ParseResult<{ values: ReadonlyMap<string, string>; apply: boolean }> => {
  const values = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--apply") {
      if (apply) {
        return invalid("--apply was given more than once");
      }
      apply = true;
      continue;
    }
    if (!isValueFlag(flag)) {
      return invalid(`Unknown argument ${JSON.stringify(flag)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return invalid(`${flag} requires a value`);
    }
    if (values.has(flag)) {
      return invalid(`${flag} was given more than once`);
    }
    values.set(flag, value);
    index += 1;
  }
  return Result.ok({ values, apply });
};

const readSince = (raw: string | undefined): ParseResult<Date> => {
  if (raw === undefined) {
    return invalid("--since is required");
  }
  const since = Result.try(() => Temporal.Instant.from(raw));
  if (Result.isError(since)) {
    return invalid(`--since must be an ISO instant, got: ${raw}`);
  }
  if (Temporal.Instant.compare(since.value, Temporal.Now.instant()) > 0) {
    return invalid("--since must not be in the future");
  }
  return Result.ok(new Date(since.value.epochMilliseconds));
};

const readAfter = (
  raw: string | undefined,
): ParseResult<SafeId<"caseLawDecision"> | null> => {
  if (raw === undefined) {
    return Result.ok(null);
  }
  return UUID.test(raw)
    ? Result.ok(brandPersistedCaseLawDecisionId(raw))
    : invalid(`--after must be a decision id, got: ${raw}`);
};

const readScan = (raw: string | undefined): ParseResult<number> => {
  if (raw === undefined) {
    return Result.ok(DEFAULT_SCAN);
  }
  const scan = Number(raw);
  return /^[1-9]\d*$/u.test(raw) &&
    Number.isSafeInteger(scan) &&
    scan <= MAX_EMPTIED_DOCUMENT_SCAN
    ? Result.ok(scan)
    : invalid(
        `--scan must be an integer from 1 to ${String(MAX_EMPTIED_DOCUMENT_SCAN)}, got: ${raw}`,
      );
};

const readWrite = ({
  actor,
  apply,
  reason,
  resultsOut,
}: {
  actor: string | undefined;
  apply: boolean;
  reason: string | undefined;
  resultsOut: string | null;
}): ParseResult<EmptiedDocumentRepairCommand["write"]> => {
  if (!apply) {
    return reason === undefined && actor === undefined
      ? Result.ok({ type: "dry-run" })
      : invalid("--reason and --actor are taken only with --apply");
  }
  if (resultsOut === null) {
    return invalid("--apply requires --results-out");
  }
  if (actor === undefined || actor.length === 0) {
    return invalid("--apply requires --actor");
  }
  if (reason === undefined || reason.length < MIN_REASON_LENGTH) {
    return invalid("--apply requires a --reason of at least eight characters");
  }
  return Result.ok({ type: "apply", reason, actor });
};

export const parseEmptiedDocumentRepairArguments = (
  argv: readonly string[],
): ParseResult<EmptiedDocumentRepairCommand> =>
  Result.gen(function* () {
    const { apply, values } = yield* readFlags(argv);
    const since = yield* readSince(values.get("--since"));
    const after = yield* readAfter(values.get("--after"));
    const scan = yield* readScan(values.get("--scan"));
    const resultsOut = values.get("--results-out") ?? null;
    const write = yield* readWrite({
      actor: values.get("--actor")?.trim(),
      apply,
      reason: values.get("--reason")?.trim(),
      resultsOut,
    });
    return Result.ok({ since, after, scan, resultsOut, write });
  });

/** One qualifying decision, as the results file records it. */
export type EmptiedDocumentRepairRow = {
  id: SafeId<"caseLawDecision">;
  outcome: "eligible" | "requeued" | "no-longer-eligible";
  reason: string | null;
  actor: string | null;
};

export type EmptiedDocumentRepairReport = {
  visited: number;
  matched: number;
  requeued: number;
  /** The `--after` of the next run; null when the source is exhausted. */
  nextAfter: SafeId<"caseLawDecision"> | null;
};

type RunEmptiedDocumentRepairOptions = {
  scopedDb: ScopedDb;
  sourceId: SafeId<"caseLawSource">;
  /** Receives every qualifying decision's row; the script writes it to the results file. */
  record: (row: EmptiedDocumentRepairRow) => Promise<void>;
  /** Receives the report lines; the script prints them. */
  write: (line: string) => void;
};

/**
 * Scan one bounded window of the source and, under `--apply`, requeue what
 * qualifies in it. A window holding more qualifying decisions than one
 * requeue takes is refused before anything is written, so a run never
 * requeues part of the window it reports.
 */
export const runEmptiedDocumentRepair = async (
  command: EmptiedDocumentRepairCommand,
  { record, scopedDb, sourceId, write }: RunEmptiedDocumentRepairOptions,
): Promise<EmptiedDocumentRepairReport> => {
  const scan = await scanEmptiedDocuments({
    scopedDb,
    sourceId,
    since: command.since,
    after: command.after,
    scan: command.scan,
  });
  const nextAfter = scan.visited < command.scan ? null : scan.lastVisitedId;
  write(
    `mode=${command.write.type} since=${command.since.toISOString()} visited=${String(scan.visited)} matched=${String(scan.matched.length)} next_after=${nextAfter ?? "none"}`,
  );

  if (command.write.type === "dry-run") {
    for (const id of scan.matched) {
      await record({ id, outcome: "eligible", reason: null, actor: null });
    }
    return {
      visited: scan.visited,
      matched: scan.matched.length,
      requeued: 0,
      nextAfter,
    };
  }

  if (scan.matched.length > MAX_EMPTIED_DOCUMENT_REQUEUE) {
    throw new EmptiedDocumentRepairArgumentsError({
      message: `The window holds ${String(scan.matched.length)} qualifying decisions, more than one run requeues (${String(MAX_EMPTIED_DOCUMENT_REQUEUE)}); lower --scan. Nothing was written.`,
    });
  }
  const { actor, reason } = command.write;
  const outcomes = await requeueEmptiedDocuments({
    scopedDb,
    sourceId,
    since: command.since,
    decisionIds: scan.matched,
  });
  for (const { decisionId, outcome } of outcomes) {
    await record({ id: decisionId, outcome, reason, actor });
  }
  const requeued = outcomes.filter(
    ({ outcome }) => outcome === "requeued",
  ).length;
  write(
    `requeued=${String(requeued)} no_longer_eligible=${String(outcomes.length - requeued)}`,
  );
  return {
    visited: scan.visited,
    matched: scan.matched.length,
    requeued,
    nextAfter,
  };
};
