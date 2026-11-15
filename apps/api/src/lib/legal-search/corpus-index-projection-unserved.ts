import { panic, Result, TaggedError } from "better-result";
import { type SQL, sql, type SQLWrapper } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { executedRows } from "@/api/lib/db/executed-rows";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  CORPUS_INDEX_PROJECTION_SERVING,
  corpusIndexProjectionIsAbsent,
  corpusIndexProjectionRevisionDeleteIsUnproven,
  type CorpusIndexProjectionServing,
} from "@/api/lib/legal-search/corpus-index-projection-sql";
import type { CorpusProjectionRevision } from "@/api/lib/legal-search/corpus-index-revision-clause";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Entities a generation should serve and does not, read rather than kept:
 * the `at_risk` and `absent` branches of `CORPUS_INDEX_PROJECTION_SERVING`.
 *
 * `at_risk` walks `corpus_index_projection_intents_delete_unproven_idx`
 * oldest claim first and keeps the revisions a state still names; the walk
 * also passes revisions nothing names any more (superseded attempts in
 * cleanup), so its cost is the generation's unproven deletes, a cleanup
 * backlog, never its revision history. `absent` walks
 * `corpus_index_projection_states_absent_idx` in entity order. Every read is
 * bounded, and a failed read is a typed error, never an empty answer.
 */

export class CorpusProjectionUnservedReadError extends TaggedError(
  "CorpusProjectionUnservedReadError",
)<{
  message: string;
  cause: unknown;
}> {}

/** The serving branches that are a defect. */
export type CorpusProjectionUnservedKind = Extract<
  CorpusIndexProjectionServing,
  "at_risk" | "absent"
>;

type CorpusProjectionUnservedTarget = {
  family: CorpusFamily;
  generation: string;
};

const states = corpusIndexProjectionStates;
const intents = corpusIndexProjectionIntents;

const MICROSECONDS_PER_NANOSECOND = 1000n;

/**
 * Instants travel as epoch microseconds, PostgreSQL's own precision, so a
 * keyset cursor resumes exactly where its page stopped. A `Date` would drop
 * the microseconds and repeat or skip rows claimed within one millisecond.
 */
const epochMicros = (instant: SQLWrapper): SQL =>
  sql`(extract(epoch FROM ${instant}) * 1000000)::bigint`;

const instantFromMicros = (micros: string): Temporal.Instant =>
  Temporal.Instant.fromEpochNanoseconds(
    BigInt(micros) * MICROSECONDS_PER_NANOSECOND,
  );

const timestamptzFromInstant = (instant: Temporal.Instant): SQL =>
  sql`('epoch'::timestamptz + ${String(instant.epochNanoseconds / MICROSECONDS_PER_NANOSECOND)}::bigint * INTERVAL '1 microsecond')`;

/** When an at-risk revision was claimed, or last sent back to cleanup. */
const atRiskSince = sql`coalesce(${intents.cleanupStartedAt}, ${intents.updatedAt})`;

/** When an absent entity's copy was proven gone, or erased. */
const absentSince = sql`CASE
    WHEN ${states.appliedAction} = 'erase' THEN ${states.appliedAt}
    ELSE ${intents.settledAt}
  END`;

const isGeneration = (
  table: typeof states | typeof intents,
  { family, generation }: CorpusProjectionUnservedTarget,
): SQL =>
  sql`${table.family} = ${family} AND ${table.generation} = ${generation}`;

/** The state that names an at-risk revision, by its primary key. */
const namingState = sql`${states.family} = ${intents.family}
    AND ${states.generation} = ${intents.generation}
    AND ${states.entityId} = ${intents.entityId}
    AND ${states.appliedRevision} = ${intents.id}`;

const isAtRisk = CORPUS_INDEX_PROJECTION_SERVING.at_risk({
  state: states,
  revision: intents,
});

const requiredText = (row: unknown, key: string): string => {
  if (!isRecord(row) || typeof row[key] !== "string") {
    return panic(`Malformed unserved projection row: ${key}`);
  }
  return row[key];
};

const requiredNumber = (row: unknown, key: string): number => {
  if (!isRecord(row) || typeof row[key] !== "number") {
    return panic(`Malformed unserved projection row: ${key}`);
  }
  return row[key];
};

const readError = (
  { family, generation }: CorpusProjectionUnservedTarget,
  cause: unknown,
) =>
  new CorpusProjectionUnservedReadError({
    message: `Could not read unserved projection entities of ${family}/${generation}`,
    cause,
  });

const readRows = async (
  tx: Transaction,
  query: SQL,
  target: CorpusProjectionUnservedTarget,
): Promise<Result<unknown[], CorpusProjectionUnservedReadError>> =>
  await Result.tryPromise({
    try: async () => executedRows(await tx.execute(query)),
    catch: (cause) => readError(target, cause),
  });

/** The most entities one page returns. */
const CORPUS_PROJECTION_UNSERVED_PAGE_MAX = 500;

/** Where the next page starts: the last entity the previous page returned. */
export type CorpusProjectionUnservedCursor =
  | {
      kind: "at_risk";
      unservedSince: Temporal.Instant;
      revision: CorpusProjectionRevision;
    }
  | { kind: "absent"; entityId: string };

export type CorpusProjectionUnservedEntity = {
  entityId: string;
  /** The index the entity should be served from. */
  indexId: string;
  /** The revision readers address; null once an erasure cleared it. */
  revision: CorpusProjectionRevision | null;
  /** At risk: when its delete was claimed. Absent: when it was proven gone. */
  unservedSince: Temporal.Instant;
};

export type CorpusProjectionUnservedPage = {
  entities: readonly CorpusProjectionUnservedEntity[];
  /** Null once the page reached the last entity of its kind. */
  next: CorpusProjectionUnservedCursor | null;
};

type CorpusProjectionUnservedPageOptions = CorpusProjectionUnservedTarget & {
  limit: number;
} & (
    | {
        kind: "at_risk";
        after: Extract<
          CorpusProjectionUnservedCursor,
          { kind: "at_risk" }
        > | null;
      }
    | {
        kind: "absent";
        after: Extract<
          CorpusProjectionUnservedCursor,
          { kind: "absent" }
        > | null;
      }
  );

/**
 * At-risk entities come oldest claim first, so a page's first row is the
 * longest at risk. Absent entities come in entity order: no state column
 * records when a copy was proven gone, and an index on the revision side would
 * have to cover every settled revision of the corpus.
 */
export const corpusProjectionUnservedPageQuery = (
  tx: Transaction,
  options: CorpusProjectionUnservedPageOptions,
) => {
  switch (options.kind) {
    case "at_risk":
      return tx
        .select({
          entityId: states.entityId,
          indexId: states.desiredIndexId,
          revision: intents.id,
          unservedSinceUs: sql<string>`${epochMicros(atRiskSince)}::text`,
        })
        .from(intents)
        .innerJoin(states, namingState)
        .where(
          sql`${isGeneration(intents, options)}
          AND ${corpusIndexProjectionRevisionDeleteIsUnproven(intents)}
          AND ${isAtRisk}${
            options.after === null
              ? sql``
              : sql`
          AND (${atRiskSince}, ${intents.id}) > (
            ${timestamptzFromInstant(options.after.unservedSince)},
            ${options.after.revision}::uuid
          )`
          }`,
        )
        .orderBy(atRiskSince, intents.id)
        .limit(options.limit + 1);
    case "absent":
      return tx
        .select({
          entityId: states.entityId,
          indexId: states.desiredIndexId,
          revision: states.appliedRevision,
          unservedSinceUs: sql<string>`${epochMicros(absentSince)}::text`,
        })
        .from(states)
        .leftJoin(intents, sql`${intents.id} = ${states.appliedRevision}`)
        .where(
          sql`${isGeneration(states, options)}
          AND ${corpusIndexProjectionIsAbsent(states)}${
            options.after === null
              ? sql``
              : sql`
          AND ${states.entityId} > ${options.after.entityId}::uuid`
          }`,
        )
        .orderBy(states.entityId)
        .limit(options.limit + 1);
    default:
      options satisfies never;
      return panic("Unhandled unserved projection kind");
  }
};

const cursorAfter = (
  kind: CorpusProjectionUnservedKind,
  last: CorpusProjectionUnservedEntity,
): CorpusProjectionUnservedCursor => {
  switch (kind) {
    case "at_risk":
      return {
        kind,
        unservedSince: last.unservedSince,
        revision: last.revision ?? panic("An at-risk entity names no revision"),
      };
    case "absent":
      return { kind, entityId: last.entityId };
    default:
      kind satisfies never;
      return panic("Unhandled unserved projection kind");
  }
};

/**
 * One page of a generation's unserved entities of one kind. The page reads
 * one row past the limit, so `next` is null exactly when nothing follows.
 */
export const readCorpusProjectionUnservedPageTx = async (
  tx: Transaction,
  options: CorpusProjectionUnservedPageOptions,
): Promise<
  Result<CorpusProjectionUnservedPage, CorpusProjectionUnservedReadError>
> => {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > CORPUS_PROJECTION_UNSERVED_PAGE_MAX
  ) {
    return panic(`Invalid unserved projection page size: ${options.limit}`);
  }
  const rows = await Result.tryPromise({
    try: async () => await corpusProjectionUnservedPageQuery(tx, options),
    catch: (cause) => readError(options, cause),
  });
  if (Result.isError(rows)) {
    return rows;
  }
  const entities = rows.value
    .slice(0, options.limit)
    .map(({ entityId, indexId, revision, unservedSinceUs }) => ({
      entityId,
      indexId:
        indexId ?? panic(`An unserved entity wants no index: ${entityId}`),
      revision,
      unservedSince: instantFromMicros(unservedSinceUs),
    }));
  const last = entities.at(-1);
  return Result.ok({
    entities,
    next:
      rows.value.length > options.limit && last !== undefined
        ? cursorAfter(options.kind, last)
        : null,
  });
};

/**
 * How many rows one count walks, at most, per kind and generation. The count
 * is a gauge: past this many it reports a lower bound, already far past any
 * threshold a reader acts on, and the read stays bounded however large the
 * defect or the cleanup backlog grows.
 */
export const CORPUS_PROJECTION_UNSERVED_COUNT_CAP = 100;

/** The age of a kind's longest-unserved entity, where the read can know it. */
export type CorpusProjectionUnservedOldest =
  { type: "exact"; since: Temporal.Instant } | { type: "unknown" };

type CorpusProjectionUnservedIndexCount = {
  indexId: string;
  count: number;
  oldest: CorpusProjectionUnservedOldest;
};

/**
 * `exact`: the walk reached the end, so every entity was counted and an index
 * not listed has none. `at_least`: the walk stopped at the cap, so each count
 * is a lower bound and an index not listed may still have some. An at-risk
 * walk goes oldest first, so a listed index's oldest is exact either way; an
 * absent walk goes in entity order, so a stopped walk cannot know it.
 */
export type CorpusProjectionUnservedCount = {
  type: "exact" | "at_least";
  byIndex: readonly CorpusProjectionUnservedIndexCount[];
};

export type CorpusProjectionUnservedCounts = Record<
  CorpusProjectionUnservedKind,
  CorpusProjectionUnservedCount
>;

const COUNT_WALK_LIMIT = CORPUS_PROJECTION_UNSERVED_COUNT_CAP + 1;

const countSummary = (matched: SQL): SQL => sql`
  SELECT (SELECT count(*) FROM walked)::int AS walked,
    coalesce((
      SELECT json_agg(json_build_object(
        'index_id', per_index.index_id,
        'count', per_index.count,
        'oldest_since_us', per_index.oldest_since_us
      ) ORDER BY per_index.index_id)
      FROM (
        SELECT matched.index_id,
          count(*)::int AS count,
          min(matched.since_us)::text AS oldest_since_us
        FROM (${matched}) AS matched
        GROUP BY matched.index_id
      ) AS per_index
    ), '[]'::json) AS by_index`;

export const corpusProjectionUnservedCountQuery = (
  kind: CorpusProjectionUnservedKind,
  target: CorpusProjectionUnservedTarget,
): SQL => {
  switch (kind) {
    case "at_risk":
      return sql`
        WITH walked AS MATERIALIZED (
          SELECT ${intents.id} AS revision_id,
            ${intents.entityId} AS entity_id,
            ${intents.status} AS status,
            ${intents.cleanupAttempts} AS cleanup_attempts,
            ${epochMicros(atRiskSince)} AS since_us
          FROM ${intents}
          WHERE ${isGeneration(intents, target)}
            AND ${corpusIndexProjectionRevisionDeleteIsUnproven(intents)}
          ORDER BY ${atRiskSince}, ${intents.id}
          LIMIT ${COUNT_WALK_LIMIT}
        )
        ${countSummary(sql`
          SELECT ${states.desiredIndexId} AS index_id, walked.since_us
          FROM walked
          JOIN ${states}
            ON ${isGeneration(states, target)}
            AND ${states.entityId} = walked.entity_id
            AND ${states.appliedRevision} = walked.revision_id
          WHERE ${CORPUS_INDEX_PROJECTION_SERVING.at_risk({
            state: states,
            revision: {
              status: sql`walked.status`,
              cleanupAttempts: sql`walked.cleanup_attempts`,
            },
          })}`)}`;
    case "absent":
      return sql`
        WITH walked AS MATERIALIZED (
          SELECT ${states.desiredIndexId} AS index_id,
            ${epochMicros(absentSince)} AS since_us
          FROM ${states}
          LEFT JOIN ${intents} ON ${intents.id} = ${states.appliedRevision}
          WHERE ${isGeneration(states, target)}
            AND ${corpusIndexProjectionIsAbsent(states)}
          ORDER BY ${states.entityId}
          LIMIT ${COUNT_WALK_LIMIT}
        )
        ${countSummary(sql`SELECT walked.index_id, walked.since_us FROM walked`)}`;
    default:
      kind satisfies never;
      return panic("Unhandled unserved projection kind");
  }
};

const oldestOf = (
  kind: CorpusProjectionUnservedKind,
  stopped: boolean,
  since: Temporal.Instant,
): CorpusProjectionUnservedOldest => {
  switch (kind) {
    case "at_risk":
      return { type: "exact", since };
    case "absent":
      return stopped ? { type: "unknown" } : { type: "exact", since };
    default:
      kind satisfies never;
      return panic("Unhandled unserved projection kind");
  }
};

const readUnservedCountTx = async (
  tx: Transaction,
  kind: CorpusProjectionUnservedKind,
  target: CorpusProjectionUnservedTarget,
): Promise<
  Result<CorpusProjectionUnservedCount, CorpusProjectionUnservedReadError>
> => {
  const rows = await readRows(
    tx,
    corpusProjectionUnservedCountQuery(kind, target),
    target,
  );
  if (Result.isError(rows)) {
    return rows;
  }
  const row = rows.value.at(0);
  const byIndex = isRecord(row) ? row["by_index"] : undefined;
  if (!Array.isArray(byIndex)) {
    return panic("Malformed unserved projection count: by_index");
  }
  const stopped =
    requiredNumber(row, "walked") > CORPUS_PROJECTION_UNSERVED_COUNT_CAP;
  return Result.ok({
    type: stopped ? "at_least" : "exact",
    byIndex: byIndex.map((entry: unknown) => ({
      indexId: requiredText(entry, "index_id"),
      count: requiredNumber(entry, "count"),
      oldest: oldestOf(
        kind,
        stopped,
        instantFromMicros(requiredText(entry, "oldest_since_us")),
      ),
    })),
  });
};

/** A generation's at-risk and absent entities, per index it should serve. */
export const readCorpusProjectionUnservedCountsTx = async (
  tx: Transaction,
  target: CorpusProjectionUnservedTarget,
): Promise<
  Result<CorpusProjectionUnservedCounts, CorpusProjectionUnservedReadError>
> => {
  const atRisk = await readUnservedCountTx(tx, "at_risk", target);
  if (Result.isError(atRisk)) {
    return atRisk;
  }
  const absent = await readUnservedCountTx(tx, "absent", target);
  if (Result.isError(absent)) {
    return absent;
  }
  return Result.ok({ at_risk: atRisk.value, absent: absent.value });
};
