import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { open, rename, unlink } from "node:fs/promises";
import * as v from "valibot";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import { caseLawDecisions } from "@/api/db/schema";
import type { StoredRawReparseInput } from "@/api/handlers/case-law/ingestion/adapter";
import {
  ECJ_LANGUAGES,
  isValidCelex,
  refreshEcjStoredFormex,
} from "@/api/handlers/case-law/ingestion/adapters/eu-ecj";
import { PublisherRateLimitRefusalError } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import { readStoredRawFromS3 } from "@/api/handlers/case-law/ingestion/pipeline/stored-raw";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import type { SafeId } from "@/api/lib/branded-types";
import type { CaseLawIngestionHandle } from "@/api/lib/case-law/maintenance-lane";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { iterateCursorPages } from "@/api/lib/pagination";

export class EcjFormexRefreshInputError extends TaggedError(
  "EcjFormexRefreshInputError",
)<{
  message: string;
}> {}

const REFRESH_IDENTITY_LOOKUP_BATCH_SIZE = 500;

const REPLAY_COLUMNS = {
  id: caseLawDecisions.id,
  sourceDocumentId: caseLawDecisions.sourceDocumentId,
  language: caseLawDecisions.language,
  caseNumber: caseLawDecisions.caseNumber,
  court: caseLawDecisions.court,
  ecli: caseLawDecisions.ecli,
  decisionDate: caseLawDecisions.decisionDate,
  decisionType: caseLawDecisions.decisionType,
  sourceUrl: caseLawDecisions.sourceUrl,
  documentUrl: caseLawDecisions.documentUrl,
  metadata: caseLawDecisions.metadata,
  sourceRaw: caseLawDecisions.sourceRaw,
  sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
  sourceRawContentType: caseLawDecisions.sourceRawContentType,
  corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
  sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
};
type RefreshRow = Pick<
  typeof caseLawDecisions.$inferSelect,
  "id" | "sourceDocumentId" | "language"
>;
type RefreshOutcome = Awaited<ReturnType<typeof refreshEcjStoredFormex>>;
type TerminalRefreshOutcome = Exclude<RefreshOutcome["type"], "rate-limited">;
type ResultOutcome =
  | TerminalRefreshOutcome
  | "skipped-resume"
  | `would-${TerminalRefreshOutcome}`;
export type EcjFormexRefreshResult = {
  id: string;
  sourceDocumentId: string;
  celex: string;
  language: string;
  outcome: ResultOutcome;
  formexShape?: "archive" | "xml";
  bytes?: number;
  attempt: number;
};

type RefreshBatch = {
  ingestionDb: CaseLawIngestionHandle;
  sourceLease: CaseLawSourceIngestionLease;
  release: () => Promise<void>;
};

type RunEcjFormexRefreshOptions = {
  ingestionDb: CaseLawIngestionHandle;
  sourceId: SafeId<"caseLawSource">;
  idsFile: string;
  resultsOut: string;
  apply: boolean;
  after?: string | null;
  limit?: number | null;
  batchSize?: number;
  signal?: AbortSignal;
  /** Opens both the maintenance lane and source lease when supplied by the CLI. */
  acquireBatch?: () => Promise<RefreshBatch | null>;
  readStoredRaw?: typeof readStoredRawFromS3;
  refreshStoredFormex?: typeof refreshEcjStoredFormex;
  writeDecision?: typeof processDecision;
  leaseWaitMs?: number;
  now?: () => number;
  waitForLease?: (milliseconds: number) => Promise<void>;
};

type RequestedIdentity =
  | { type: "row"; value: string }
  | { type: "document"; value: string };

const inputError = (message: string): never => {
  throw new EcjFormexRefreshInputError({ message });
};

export const parseEcjFormexRefreshIds = (text: string): RequestedIdentity[] => {
  const seen = new Set<string>();
  const requested: RequestedIdentity[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const value = line.trim();
    if (value === "") {
      continue;
    }
    if (seen.has(value)) {
      return inputError(`Duplicate input identity: ${value}`);
    }
    seen.add(value);
    const separator = value.indexOf(":");
    if (separator !== -1) {
      const celex = value.slice(0, separator);
      const language = value.slice(separator + 1);
      if (
        !isValidCelex(celex) ||
        !ECJ_LANGUAGES.some((supported) => supported.toLowerCase() === language)
      ) {
        return inputError(`Malformed source document identity: ${value}`);
      }
      requested.push({ type: "document", value });
      continue;
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        value,
      )
    ) {
      return inputError(`Malformed row identity: ${value}`);
    }
    requested.push({ type: "row", value });
  }
  if (requested.length === 0) {
    return inputError("The ids file contains no identities");
  }
  return requested;
};

type ResolveRowsOptions = {
  ingestionDb: CaseLawIngestionHandle;
  sourceId: SafeId<"caseLawSource">;
  requested: RequestedIdentity[];
};

const resolveRows = async ({
  ingestionDb,
  sourceId,
  requested,
}: ResolveRowsOptions) => {
  const rows: RefreshRow[] = [];
  // Bound SQL parameter count; all identities are resolved before any side effect.
  for (const chunk of chunkItems(
    requested,
    REFRESH_IDENTITY_LOOKUP_BATCH_SIZE,
  )) {
    const ids = chunk.flatMap((identity) =>
      identity.type === "row" ? [identity.value] : [],
    );
    const documents = chunk.flatMap((identity) =>
      identity.type === "document" ? [identity.value] : [],
    );
    rows.push(
      ...(await ingestionDb(
        async (tx) =>
          await tx
            .select({
              id: caseLawDecisions.id,
              sourceDocumentId: caseLawDecisions.sourceDocumentId,
              language: caseLawDecisions.language,
            })
            .from(caseLawDecisions)
            .where(
              and(
                eq(caseLawDecisions.sourceId, sourceId),
                or(
                  ids.length === 0
                    ? sql`false`
                    : sql`${caseLawDecisions.id} IN (${sql.join(
                        ids.map((id) => sql`${id}::uuid`),
                        sql`, `,
                      )})`,
                  inArray(caseLawDecisions.sourceDocumentId, documents),
                ),
              ),
            )
            .limit(chunk.length),
      )),
    );
  }
  const byId = new Map<string, RefreshRow>(rows.map((row) => [row.id, row]));
  const byDocument = new Map(
    rows.flatMap((row) =>
      row.sourceDocumentId === null
        ? []
        : [[row.sourceDocumentId, row] as const],
    ),
  );
  const resolved = new Map<SafeId<"caseLawDecision">, RefreshRow>();
  for (const identity of requested) {
    const row =
      identity.type === "row"
        ? byId.get(identity.value)
        : byDocument.get(identity.value);
    if (row === undefined) {
      return inputError(
        `Identity not found in the selected source: ${identity.value}`,
      );
    }
    if (resolved.has(row.id)) {
      return inputError(`Input identities resolve to the same row: ${row.id}`);
    }
    if (
      row.sourceDocumentId === null ||
      parseEcjFormexRefreshIds(row.sourceDocumentId).at(0)?.type !== "document"
    ) {
      return inputError(
        `Row lacks a valid EU-ECJ document identity: ${row.id}`,
      );
    }
    resolved.set(row.id, row);
  }
  return [...resolved.values()].toSorted((left, right) => {
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? -1 : 1;
  });
};

type ResultJournal = {
  prior: Map<string, EcjFormexRefreshResult>;
  offset: number;
};

type ReadJournalOptions = {
  path: string;
  journal: ResultJournal;
  repair?: boolean;
};

const readPriorResults = async ({
  path,
  journal,
  repair = false,
}: ReadJournalOptions): Promise<ResultJournal> => {
  if (!(await Bun.file(path).exists())) {
    return journal;
  }
  const text = await Bun.file(path).slice(journal.offset).text();
  // A torn last line cannot be acknowledged. Truncate it before appending.
  const completeLength = text.lastIndexOf("\n") + 1;
  const complete = text.slice(0, completeLength);
  if (repair && completeLength !== text.length) {
    const file = await open(path, "r+");
    try {
      await file.truncate(journal.offset + Buffer.byteLength(complete));
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const prior = journal.prior;
  for (const line of complete.split("\n")) {
    if (line === "") {
      continue;
    }
    const record: unknown = JSON.parse(line);
    if (
      typeof record !== "object" ||
      record === null ||
      !("id" in record) ||
      typeof record.id !== "string" ||
      !("outcome" in record) ||
      typeof record.outcome !== "string" ||
      !("attempt" in record) ||
      typeof record.attempt !== "number" ||
      !("sourceDocumentId" in record) ||
      typeof record.sourceDocumentId !== "string"
    ) {
      return inputError("Invalid durable result record");
    }
    const outcome = parseResultOutcome(record.outcome);
    const previous = prior.get(record.id);
    if (
      !Number.isSafeInteger(record.attempt) ||
      record.attempt < 1 ||
      (previous !== undefined &&
        (!previous.outcome.startsWith("would-") ||
          outcome.startsWith("would-") ||
          record.attempt !== previous.attempt + 1))
    ) {
      return inputError("Duplicate or invalid durable result attempt");
    }
    // Only fields needed for replay are retained; document contents never enter the journal.
    prior.set(record.id, {
      id: record.id,
      sourceDocumentId: record.sourceDocumentId,
      celex: "",
      language: "",
      outcome,
      attempt: record.attempt,
    });
  }
  return { prior, offset: journal.offset + Buffer.byteLength(complete) };
};

const REFRESH_OUTCOMES = {
  refreshed: true,
  "unchanged-already-current": true,
  "notice-missing": true,
  "formex-not-located": true,
  "formex-gone": true,
  "formex-refused": true,
  "retryable-exhausted": true,
  "write-rejected": true,
} as const satisfies Record<TerminalRefreshOutcome, true>;

const isRefreshOutcome = (value: string): value is TerminalRefreshOutcome =>
  Object.hasOwn(REFRESH_OUTCOMES, value);

const parseResultOutcome = (outcome: string): ResultOutcome => {
  if (outcome === "skipped-resume" || isRefreshOutcome(outcome)) {
    return outcome;
  }
  if (outcome.startsWith("would-")) {
    const suffix = outcome.slice("would-".length);
    if (isRefreshOutcome(suffix)) {
      return `would-${suffix}`;
    }
  }
  return inputError("Invalid durable result outcome");
};

type RefreshStoredRowOptions = {
  row: Pick<typeof caseLawDecisions.$inferSelect, keyof typeof REPLAY_COLUMNS>;
  sourceId: SafeId<"caseLawSource">;
  batch: RefreshBatch | null;
  apply: boolean;
  signal: AbortSignal;
  readStoredRaw: typeof readStoredRawFromS3;
  refreshStoredFormex: typeof refreshEcjStoredFormex;
  writeDecision: typeof processDecision;
  pending: RefreshIntent | null;
  persistIntent: (intent: RefreshIntent) => Promise<void>;
};

const INTENT_SCHEMA = v.object({
  id: v.string(),
  sourceDocumentId: v.string(),
  order: v.pipe(v.string(), v.regex(/^\d+$/u)),
  rawDigest: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
  formexShape: v.picklist(["archive", "xml"]),
  bytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
type RefreshIntent = v.InferOutput<typeof INTENT_SCHEMA>;

const rawDigest = (raw: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(raw).digest("hex");

const readIntent = async (path: string): Promise<RefreshIntent | null> => {
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  const parsed: unknown = JSON.parse(await Bun.file(path).text());
  const result = v.safeParse(INTENT_SCHEMA, parsed);
  if (!result.success) {
    return inputError("Invalid pending refresh intent");
  }
  return result.output;
};

const persistIntent = async (path: string, intent: RefreshIntent) => {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w");
  try {
    await file.writeFile(`${JSON.stringify(intent)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
};

type RowRefreshResult =
  | {
      type: "terminal";
      outcome: ResultOutcome;
      formexShape?: "archive" | "xml";
      bytes?: number;
    }
  | Extract<RefreshOutcome, { type: "rate-limited" }>;

const refreshStoredRow = async ({
  row,
  sourceId,
  batch,
  apply,
  signal,
  readStoredRaw,
  refreshStoredFormex,
  writeDecision,
  pending,
  persistIntent: writeIntent,
}: RefreshStoredRowOptions): Promise<RowRefreshResult> => {
  const rawResult =
    row.sourceRawS3Key === null
      ? Result.ok(
          row.sourceRaw === null
            ? null
            : new TextEncoder().encode(row.sourceRaw),
        )
      : await readStoredRaw(row.sourceRawS3Key);
  if (Result.isError(rawResult)) {
    return {
      type: "terminal",
      outcome: apply ? "retryable-exhausted" : "would-retryable-exhausted",
    };
  }
  if (rawResult.value === null) {
    return {
      type: "terminal",
      outcome: apply ? "notice-missing" : "would-notice-missing",
    };
  }
  // The order proves this run committed its attempt; matching bytes prove
  // the raw upload landed before an interrupted journal acknowledgment.
  if (
    pending !== null &&
    pending.id === row.id &&
    pending.sourceDocumentId === row.sourceDocumentId &&
    row.corpusMirrorStatus === "settled" &&
    row.sourceObservationOrder !== null &&
    row.sourceObservationOrder >= BigInt(pending.order) &&
    rawDigest(rawResult.value) === pending.rawDigest
  ) {
    return {
      type: "terminal",
      outcome: apply
        ? "unchanged-already-current"
        : "would-unchanged-already-current",
      formexShape: pending.formexShape,
      bytes: pending.bytes,
    };
  }
  const stored: StoredRawReparseInput = {
    raw: rawResult.value,
    contentType: row.sourceRawContentType,
    caseNumber: row.caseNumber,
    sourceDocumentId: row.sourceDocumentId,
    language: row.language,
    court: row.court,
    ecli: row.ecli,
    decisionDate: row.decisionDate,
    decisionType: row.decisionType,
    sourceUrl: row.sourceUrl,
    documentUrl: row.documentUrl,
    metadata: row.metadata ?? {},
  };
  const refreshed = await Result.tryPromise({
    try: async () =>
      batch === null
        ? await refreshStoredFormex({ stored, signal })
        : await batch.sourceLease.beforeRemoteEffect(
            async () => await refreshStoredFormex({ stored, signal }),
          ),
    catch: (cause) => cause,
  });
  if (Result.isError(refreshed)) {
    signal.throwIfAborted();
    if (refreshed.error instanceof PublisherRateLimitRefusalError) {
      return {
        type: "rate-limited",
        publisherKey: refreshed.error.publisherKey,
        status: refreshed.error.status,
        cooldownUntilEpochMs: refreshed.error.cooldownUntilEpochMs,
      };
    }
    return {
      type: "terminal",
      outcome: apply ? "retryable-exhausted" : "would-retryable-exhausted",
    };
  }
  const outcome = refreshed.value;
  if (outcome.type === "rate-limited") {
    return outcome;
  }
  if (outcome.type !== "refreshed") {
    return {
      type: "terminal",
      outcome: apply ? outcome.type : `would-${outcome.type}`,
    };
  }
  const extra = { formexShape: outcome.formexShape, bytes: outcome.bytes };
  if (batch === null) {
    return { type: "terminal", outcome: "would-refreshed", ...extra };
  }
  await batch.sourceLease.beforeDatabaseMark();
  const observationOrder = await allocateSourceObservationOrder({
    leaseToken: batch.sourceLease.leaseToken,
    scopedDb: batch.ingestionDb,
    sourceId,
  });
  const decisionRaw =
    outcome.decision.sourceRawBytes ??
    (outcome.decision.sourceRaw === undefined
      ? panic("refreshed decision has no stored raw")
      : new TextEncoder().encode(outcome.decision.sourceRaw));
  await writeIntent({
    id: row.id,
    sourceDocumentId:
      row.sourceDocumentId ?? panic("resolved identity missing"),
    order: observationOrder.toString(),
    rawDigest: rawDigest(decisionRaw),
    ...extra,
  });
  const written = await writeDecision({
    input: outcome.decision,
    sourceId,
    scopedDb: batch.ingestionDb,
    observedAt: new Date(),
    observationOrder,
    refresh: DECISION_REFRESH.ALWAYS,
  });
  return {
    type: "terminal",
    outcome:
      written.status === PROCESS_DECISION_STATUS.RETRYABLE || !written.inserted
        ? "write-rejected"
        : "refreshed",
    ...extra,
  };
};

const validateRunOptions = ({
  resultsOut,
  apply,
  acquireBatch,
  batchSize = 25,
  limit = null,
  after = null,
}: Pick<
  RunEcjFormexRefreshOptions,
  "resultsOut" | "apply" | "acquireBatch" | "batchSize" | "limit" | "after"
>) => {
  if (resultsOut === "") {
    inputError("A results output path is required");
  }
  if (apply && acquireBatch === undefined) {
    inputError("Apply requires a maintenance-lane batch acquisition callback");
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    inputError("Batch size must be a positive integer");
  }
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
    inputError("Limit must be a positive integer");
  }
  if (after !== null) {
    const cursor = parseEcjFormexRefreshIds(after);
    if (cursor.length !== 1 || cursor.at(0)?.type !== "row") {
      inputError("Resume cursor must be a row id");
    }
  }
};

type FilterPendingRowsOptions = {
  rows: RefreshRow[];
  prior: Map<string, EcjFormexRefreshResult>;
  apply: boolean;
};
const filterPendingRows = ({ rows, prior, apply }: FilterPendingRowsOptions) =>
  rows.filter((row) => {
    const previous = prior.get(row.id);
    if (
      previous !== undefined &&
      previous.sourceDocumentId !== row.sourceDocumentId
    ) {
      inputError(`Durable result identity mismatch: ${row.id}`);
    }
    return (
      previous === undefined || (apply && previous.outcome.startsWith("would-"))
    );
  });

type AcquireRefreshBatchOptions = {
  apply: boolean;
  acquireBatch: RunEcjFormexRefreshOptions["acquireBatch"];
  signal: AbortSignal;
  leaseWaitMs: number;
  now: () => number;
  waitForLease: (milliseconds: number) => Promise<void>;
};

const acquireRefreshBatch = async ({
  apply,
  acquireBatch,
  signal,
  leaseWaitMs,
  now,
  waitForLease,
}: AcquireRefreshBatchOptions) => {
  if (!apply) {
    return null;
  }
  if (acquireBatch === undefined) {
    return panic("apply acquisition callback was validated");
  }
  const deadline = now() + leaseWaitMs;
  while (true) {
    signal.throwIfAborted();
    const batch = await acquireBatch();
    if (batch !== null) {
      return batch;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return inputError("Source ingestion lease is held; retry later");
    }
    await waitForLease(Math.min(5000, remaining));
  }
};

type VisitRefreshBatchOptions = Omit<
  RefreshStoredRowOptions,
  "row" | "pending"
> & {
  identities: RefreshRow[];
  currentById: Map<SafeId<"caseLawDecision">, RefreshStoredRowOptions["row"]>;
  after: string | null;
  intentState: { pending: RefreshIntent | null };
  intentPath: string;
  append: (
    row: RefreshRow,
    outcome: ResultOutcome,
    extra?: { formexShape?: "archive" | "xml"; bytes?: number },
  ) => Promise<void>;
};
const visitRefreshBatch = async ({
  identities,
  currentById,
  after,
  signal,
  sourceId,
  batch,
  apply,
  readStoredRaw,
  refreshStoredFormex,
  writeDecision,
  intentState,
  persistIntent: writePending,
  intentPath,
  append,
}: VisitRefreshBatchOptions) => {
  for (const identity of identities) {
    signal.throwIfAborted();
    if (after !== null && identity.id <= after) {
      await append(identity, "skipped-resume");
      continue;
    }
    const row = currentById.get(identity.id);
    if (
      row === undefined ||
      row.sourceDocumentId !== identity.sourceDocumentId
    ) {
      await append(identity, apply ? "write-rejected" : "would-write-rejected");
      continue;
    }
    // db-await-in-loop: exactly-once crash recovery requires each write intent and fsynced acknowledgment before the next row
    const refreshed = await refreshStoredRow({
      row,
      sourceId,
      batch,
      apply,
      signal,
      readStoredRaw,
      refreshStoredFormex,
      writeDecision,
      pending: intentState.pending,
      persistIntent: writePending,
    });
    if (refreshed.type === "rate-limited") {
      return { refusal: refreshed, blockedId: row.id };
    }
    const { outcome, formexShape, bytes } = refreshed;
    const extra = {
      ...(formexShape === undefined ? {} : { formexShape }),
      ...(bytes === undefined ? {} : { bytes }),
    };
    await append(row, outcome, extra);

    if (intentState.pending?.id === row.id) {
      await unlink(intentPath);
      intentState.pending = null;
    }
  }
  return null;
};

type DurableResumeCursorOptions = {
  rows: RefreshRow[];
  prior: Map<string, EcjFormexRefreshResult>;
  apply: boolean;
  blockedId: string;
  after: string | null;
};
const durableResumeCursor = ({
  rows,
  prior,
  apply,
  blockedId,
  after,
}: DurableResumeCursorOptions) => {
  let cursor = after !== null && after < blockedId ? after : null;
  for (const row of rows) {
    if (row.id >= blockedId) {
      break;
    }
    const record = prior.get(row.id);
    if (
      record !== undefined &&
      (!apply || !record.outcome.startsWith("would-"))
    ) {
      cursor = row.id;
    }
  }
  return cursor;
};

export type EcjFormexRefreshSummary =
  | { type: "complete"; results: EcjFormexRefreshResult[] }
  | {
      type: "rate-limited";
      results: EcjFormexRefreshResult[];
      blockedId: string;
      resumeAfter: string | null;
      cooldownUntilEpochMs: number;
    };

/** Each row is acknowledged only after its pipeline write and durable journal append. */
export const runEcjFormexRefresh = async ({
  ingestionDb,
  sourceId,
  idsFile,
  resultsOut,
  apply,
  after = null,
  limit = null,
  batchSize = 25,
  signal = AbortSignal.timeout(24 * 60 * 60_000),
  acquireBatch,
  readStoredRaw = readStoredRawFromS3,
  refreshStoredFormex = refreshEcjStoredFormex,
  writeDecision = processDecision,
  leaseWaitMs = 15 * 60_000,
  now = () => performance.now(),
  waitForLease = async (milliseconds) => {
    await Bun.sleep(milliseconds);
  },
}: RunEcjFormexRefreshOptions): Promise<EcjFormexRefreshSummary> => {
  validateRunOptions({
    resultsOut,
    apply,
    ...(acquireBatch === undefined ? {} : { acquireBatch }),
    batchSize,
    limit,
    after,
  });
  const requested = parseEcjFormexRefreshIds(await Bun.file(idsFile).text());
  const rows = await resolveRows({ ingestionDb, sourceId, requested });
  let journal = await readPriorResults({
    path: resultsOut,
    journal: { prior: new Map(), offset: 0 },
  });
  const intentPath = `${resultsOut}.pending.json`;
  const intentState = { pending: await readIntent(intentPath) };
  const writePending = async (intent: RefreshIntent) => {
    await persistIntent(intentPath, intent);
    intentState.pending = intent;
  };
  const pending = filterPendingRows({ rows, prior: journal.prior, apply });
  const skipped = pending.filter((row) => after !== null && row.id <= after);
  const plan = [
    ...skipped,
    ...pending
      .filter((row) => after === null || row.id > after)
      .slice(0, limit ?? undefined),
  ];
  const file = await open(resultsOut, "a");
  const results: EcjFormexRefreshResult[] = [];
  const append = async (
    row: RefreshRow,
    outcome: ResultOutcome,
    extra: { formexShape?: "archive" | "xml"; bytes?: number } = {},
  ) => {
    const sourceDocumentId =
      row.sourceDocumentId ?? panic("resolved document identity missing");
    const result = {
      id: row.id,
      sourceDocumentId,
      celex: sourceDocumentId.split(":").at(0) ?? panic("missing CELEX"),
      language: row.language,
      outcome,
      ...extra,
      attempt: (journal.prior.get(row.id)?.attempt ?? 0) + 1,
    };
    const line = `${JSON.stringify(result)}\n`;
    await file.writeFile(line);
    await file.sync();
    results.push(result);
    journal.prior.set(row.id, result);
    journal.offset += Buffer.byteLength(line);
  };
  const readRefreshPage = async (cursor: string | null) => {
    const offset = cursor === null ? 0 : Number(cursor);
    signal.throwIfAborted();
    if (offset >= plan.length) {
      return { items: [], nextCursor: null, limit: batchSize };
    }
    const batch = await acquireRefreshBatch({
      apply,
      acquireBatch,
      signal,
      leaseWaitMs,
      now,
      waitForLease,
    });
    let prepared = false;
    try {
      journal = await readPriorResults({
        path: resultsOut,
        journal,
        repair: true,
      });
      intentState.pending = await readIntent(intentPath);
      const identities = filterPendingRows({
        rows: plan.slice(offset, offset + batchSize),
        prior: journal.prior,
        apply,
      });
      const currentRows =
        identities.length === 0
          ? []
          : await (batch?.ingestionDb ?? ingestionDb)(
              async (tx) =>
                await tx
                  .select(REPLAY_COLUMNS)
                  .from(caseLawDecisions)
                  .where(
                    and(
                      eq(caseLawDecisions.sourceId, sourceId),
                      inArray(
                        caseLawDecisions.id,
                        identities.map(({ id }) => id),
                      ),
                      isNull(caseLawDecisions.redactedAt),
                    ),
                  )
                  .limit(identities.length),
            );
      const page = {
        items: [
          {
            batch,
            identities,
            currentById: new Map(currentRows.map((row) => [row.id, row])),
          },
        ],
        nextCursor:
          offset + batchSize < plan.length ? String(offset + batchSize) : null,
        limit: batchSize,
      };
      prepared = true;
      return page;
    } finally {
      if (!prepared) {
        await batch?.release();
      }
    }
  };
  try {
    for await (const pages of iterateCursorPages(readRefreshPage)) {
      const page = pages.at(0);
      if (page === undefined) {
        continue;
      }
      const { batch, identities, currentById } = page;
      let refusal: Awaited<ReturnType<typeof visitRefreshBatch>> = null;
      try {
        // db-await-in-loop: exactly-once crash recovery requires ordered pipeline writes and fsynced row acknowledgments within this lease batch
        refusal = await visitRefreshBatch({
          identities,
          currentById,
          after,
          signal,
          sourceId,
          batch,
          apply,
          readStoredRaw,
          refreshStoredFormex,
          writeDecision,
          intentState,
          persistIntent: writePending,
          intentPath,
          append,
        });
      } finally {
        await batch?.release();
      }
      if (refusal !== null) {
        return {
          type: "rate-limited",
          results,
          blockedId: refusal.blockedId,
          resumeAfter: durableResumeCursor({
            rows,
            prior: journal.prior,
            apply,
            blockedId: refusal.blockedId,
            after,
          }),
          cooldownUntilEpochMs: refusal.refusal.cooldownUntilEpochMs,
        };
      }
    }
  } finally {
    await file.close();
  }
  return { type: "complete", results };
};
