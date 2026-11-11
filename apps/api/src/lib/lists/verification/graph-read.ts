/**
 * One page of a list's verification graph, read from the stored blocks
 * through the owners the run read uses: each claim's current grade
 * (`gradeOf`, so a re-check counts) as its reviewers see it
 * (`reviewedView`), its qualifiers (`qualifiersOfClaim`), and each fact's
 * standing and tier (`readFactStandings`). `graph.ts` decides what the rows
 * say; this file only gathers them.
 *
 * Bounded by construction: a page reads at most
 * `GRAPH_STATEMENTS_PAGE_MAX` documents and `limit` claims (a document with
 * more continues on the next page, its run pinned in the cursor), and the
 * list's first `GRAPH_FACTS_MAX` facts. The documents are found through the
 * list-and-document index of finished runs, never by reading every run's
 * pinned evidence.
 */

import { panic } from "better-result";
import { and, asc, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { LIST_ITEM_TYPE } from "@stll/api-contract/entity-options";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  legalListClaims,
  legalListFactDetails,
  legalListItems,
  legalLists,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  VerificationEvidence,
  VerificationEvidenceFact,
} from "@/api/lib/lists/verification/contract";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import { readFactSources } from "@/api/lib/lists/verification/evidence";
import { buildVerificationGraph } from "@/api/lib/lists/verification/graph";
import type {
  GraphClaimInput,
  GraphFactInput,
  GraphStatementInput,
} from "@/api/lib/lists/verification/graph";
import {
  factsWithRechecks,
  qualifiersOfClaim,
  readClaimReviewsOfRuns,
  readFactStandings,
  readRunsWithEvidence,
  verificationRunListIdColumn,
} from "@/api/lib/lists/verification/read-run";
import type { ClaimReviewRecord } from "@/api/lib/lists/verification/read-run";
import {
  EMPTY_CLAIM_REVIEW,
  gradeOf,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";
import {
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import {
  brandPersistedEntityId,
  brandPersistedFieldId,
  brandPersistedListVerificationRunId,
} from "@/api/lib/safe-id-boundaries";

type RunId = SafeId<"legalListVerificationRun">;
type ClaimId = SafeId<"legalListClaim">;
type FactId = SafeId<"entity">;

/**
 * Where the next page starts: after the document `entityId`/`fileFieldId`,
 * or, when `afterPosition` is set, inside it, after that claim of `runId`.
 * The run is pinned so a document verified again between pages finishes on
 * the run its first claims came from.
 */
export type VerificationGraphCursor = {
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  runId: RunId;
  afterPosition: number | null;
};

const cursorSchema = v.tuple([
  v.custom<string>(isUuidPaginationCursorPart),
  v.custom<string>(isUuidPaginationCursorPart),
  v.custom<string>(isUuidPaginationCursorPart),
  v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
]);

export const verificationGraphCursor = {
  encode: ({
    entityId,
    fileFieldId,
    runId,
    afterPosition,
  }: VerificationGraphCursor): string =>
    encodePaginationCursor([entityId, fileFieldId, runId, afterPosition]),
  decode: (cursor: string): VerificationGraphCursor | null => {
    const parts = decodePaginationCursor(cursor);
    const parsed = v.safeParse(cursorSchema, parts);
    if (!parsed.success) {
      return null;
    }
    const [entityId, fileFieldId, runId, afterPosition] = parsed.output;
    // The parts are the persisted ids this route issued; the schema has
    // checked their shape.
    return {
      entityId: brandPersistedEntityId(entityId.toLowerCase()),
      fileFieldId: brandPersistedFieldId(fileFieldId.toLowerCase()),
      runId: brandPersistedListVerificationRunId(runId.toLowerCase()),
      afterPosition,
    };
  },
};

type ReadVerificationGraphArgs = {
  tx: Pick<Transaction, "select" | "selectDistinctOn">;
  workspaceId: SafeId<"workspace">;
  listId: SafeId<"legalList">;
  cursor: VerificationGraphCursor | null;
  /** Claims this page may carry. */
  limit: number;
};

type StatementRow = {
  runId: RunId;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
};

const runs = legalListVerificationRuns;

/** The latest finished run of each document checked against the list, in
 *  document order, from the cursor on. */
const readStatementRows = async ({
  tx,
  workspaceId,
  listId,
  cursor,
}: Omit<ReadVerificationGraphArgs, "limit">): Promise<StatementRow[]> => {
  const after =
    cursor === null
      ? undefined
      : sql`(${runs.entityId}, ${runs.fileFieldId}) > (${cursor.entityId}::uuid, ${cursor.fileFieldId}::uuid)`;
  const rows = await tx
    .selectDistinctOn([runs.entityId, runs.fileFieldId], {
      runId: runs.id,
      entityId: runs.entityId,
      fileFieldId: runs.fileFieldId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        sql`${verificationRunListIdColumn} = ${listId}`,
        eq(runs.status, "completed"),
        after,
      ),
    )
    .orderBy(
      asc(runs.entityId),
      asc(runs.fileFieldId),
      desc(runs.createdAt),
      desc(runs.id),
    )
    .limit(VERIFICATION_LIMITS.GRAPH_STATEMENTS_PAGE_MAX + 1);
  if (cursor === null || cursor.afterPosition === null) {
    return rows;
  }
  // A page resumed inside a document finishes the run it started on, if
  // that run is still a finished run of this list's document.
  const resumed = await tx
    .select({
      runId: runs.id,
      entityId: runs.entityId,
      fileFieldId: runs.fileFieldId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, cursor.runId),
        eq(runs.workspaceId, workspaceId),
        eq(runs.entityId, cursor.entityId),
        eq(runs.fileFieldId, cursor.fileFieldId),
        sql`${verificationRunListIdColumn} = ${listId}`,
        eq(runs.status, "completed"),
      ),
    )
    .limit(1);
  return [...resumed, ...rows];
};

/** One run's claims a page takes: those after `after`, up to `upTo`. */
type ClaimRange = {
  runId: RunId;
  after: number | null;
  upTo: number | null;
};

type PagePlan = {
  statements: StatementRow[];
  ranges: ClaimRange[];
  /** Claims each run holds in all, for the statement's total. */
  totals: ReadonlyMap<RunId, number>;
  next: VerificationGraphCursor | null;
};

/**
 * Which claims of which documents this page carries: whole documents while
 * they fit the claim budget, then as much of the next as is left, so a page
 * never carries more than `limit` claims and never splits a document it
 * could have carried whole.
 */
const planPage = async ({
  tx,
  workspaceId,
  cursor,
  rows,
  limit,
}: {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  cursor: VerificationGraphCursor | null;
  rows: StatementRow[];
  limit: number;
}): Promise<PagePlan> => {
  const candidates = rows.slice(
    0,
    VERIFICATION_LIMITS.GRAPH_STATEMENTS_PAGE_MAX,
  );
  if (candidates.length === 0) {
    return { statements: [], ranges: [], totals: new Map(), next: null };
  }
  const resumeAfter = cursor?.afterPosition ?? null;
  // Only a run the statement read confirmed resumes; otherwise its document
  // was verified again or removed, and the page starts after it.
  const resumeRun =
    resumeAfter !== null && candidates.at(0)?.runId === cursor?.runId
      ? (cursor?.runId ?? null)
      : null;
  const counted = await tx
    .select({
      runId: legalListClaims.runId,
      total: sql<number>`count(*)::int`,
      remaining:
        resumeRun === null
          ? sql<number>`count(*)::int`
          : sql<number>`(count(*) filter (where not (${legalListClaims.runId} = ${resumeRun}::uuid and ${legalListClaims.position} <= ${resumeAfter})))::int`,
    })
    .from(legalListClaims)
    .where(
      and(
        eq(legalListClaims.workspaceId, workspaceId),
        inArray(
          legalListClaims.runId,
          candidates.map((row) => row.runId),
        ),
      ),
    )
    .groupBy(legalListClaims.runId)
    .limit(candidates.length);
  const totals = new Map(counted.map((row) => [row.runId, row.total]));
  const remainingOf = new Map(counted.map((row) => [row.runId, row.remaining]));

  const statements: StatementRow[] = [];
  const ranges: ClaimRange[] = [];
  let budget = limit;
  for (const row of candidates) {
    const after = row.runId === resumeRun ? resumeAfter : null;
    const remaining = remainingOf.get(row.runId) ?? 0;
    if (remaining <= budget) {
      statements.push(row);
      ranges.push({ runId: row.runId, after, upTo: null });
      budget -= remaining;
      continue;
    }
    if (budget === 0) {
      const previous = statements.at(-1) ?? panic("A page planned no rows");
      return {
        statements,
        ranges,
        totals,
        next: { ...previous, afterPosition: null },
      };
    }
    // The document does not fit: take what is left of the budget and
    // continue inside it on the next page.
    // db-await-in-loop: runs at most once per page; the loop returns right after it.
    const cut = (
      await tx
        .select({ position: legalListClaims.position })
        .from(legalListClaims)
        .where(
          and(
            eq(legalListClaims.workspaceId, workspaceId),
            eq(legalListClaims.runId, row.runId),
            after === null ? undefined : gt(legalListClaims.position, after),
          ),
        )
        .orderBy(asc(legalListClaims.position))
        .offset(budget - 1)
        .limit(1)
    ).at(0);
    const upTo = cut?.position ?? panic("A counted document lost its claims");
    statements.push(row);
    ranges.push({ runId: row.runId, after, upTo });
    return {
      statements,
      ranges,
      totals,
      next: { ...row, afterPosition: upTo },
    };
  }
  const more = rows.length > candidates.length;
  const last = statements.at(-1) ?? panic("A page planned no rows");
  return {
    statements,
    ranges,
    totals,
    next: more ? { ...last, afterPosition: null } : null,
  };
};

const rangeCondition = ({ runId, after, upTo }: ClaimRange) =>
  and(
    eq(legalListClaims.runId, runId),
    after === null ? undefined : gt(legalListClaims.position, after),
    upTo === null ? undefined : sql`${legalListClaims.position} <= ${upTo}`,
  );

/** The list's facts as they stand now, held ones included, in list order. */
const readListFacts = async ({
  tx,
  workspaceId,
  listId,
}: Pick<ReadVerificationGraphArgs, "tx" | "workspaceId" | "listId">) => {
  const rows = await tx
    .select({
      factEntityId: legalListItems.entityId,
      text: entities.name,
      occurredOn: legalListFactDetails.occurredOn,
      occurredOnPrecision: legalListFactDetails.occurredOnPrecision,
      evidenceKind: legalListFactDetails.evidenceKind,
      medium: legalListFactDetails.medium,
      confidence: legalListFactDetails.confidence,
      interpretationNote: legalListFactDetails.interpretationNote,
    })
    .from(legalListItems)
    .innerJoin(
      entities,
      and(
        eq(entities.id, legalListItems.entityId),
        eq(entities.workspaceId, legalListItems.workspaceId),
      ),
    )
    .leftJoin(
      legalListFactDetails,
      eq(legalListFactDetails.itemEntityId, legalListItems.entityId),
    )
    .where(
      and(
        eq(legalListItems.workspaceId, workspaceId),
        eq(legalListItems.listId, listId),
        eq(entities.listItemType, LIST_ITEM_TYPE.FACT),
      ),
    )
    .orderBy(asc(legalListItems.position), asc(legalListItems.entityId))
    .limit(VERIFICATION_LIMITS.GRAPH_FACTS_MAX + 1);
  const listed = rows.slice(0, VERIFICATION_LIMITS.GRAPH_FACTS_MAX);
  const sources = await readFactSources({
    tx,
    workspaceId,
    factIds: listed.map((fact) => fact.factEntityId),
  });
  return {
    overflow: rows.length > listed.length,
    facts: listed.map((fact): VerificationEvidenceFact => ({
      ...fact,
      sources:
        sources.get(fact.factEntityId) ??
        panic("A listed fact lost its source bucket"),
    })),
  };
};

export type ReadVerificationGraphOutcome =
  | { type: "list-not-found" }
  | {
      type: "read";
      graph: ReturnType<typeof buildVerificationGraph> & {
        listId: SafeId<"legalList">;
        /** The list holds more facts than the graph carries. */
        factOverflow: boolean;
        nextCursor: string | null;
      };
      /** The runs whose claims the page carries, for the read audit. */
      runs: {
        id: RunId;
        entityId: SafeId<"entity">;
        fileFieldId: SafeId<"field">;
        entityVersionId: SafeId<"entityVersion">;
        listId: SafeId<"legalList">;
        status: "completed";
      }[];
    };

type ClaimRow = Awaited<ReturnType<typeof readPageClaims>>[number];

/** The claims a page's plan names, in run then reading order. */
const readPageClaims = async ({
  tx,
  workspaceId,
  ranges,
  limit,
}: {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  ranges: readonly ClaimRange[];
  limit: number;
}) =>
  ranges.length === 0
    ? []
    : await tx
        .select({
          id: legalListClaims.id,
          runId: legalListClaims.runId,
          position: legalListClaims.position,
          text: legalListClaims.text,
          state: legalListClaims.state,
          score: legalListClaims.score,
          refs: legalListClaims.refs,
          recordConflict: legalListClaims.recordConflict,
          qualifiers: legalListClaims.qualifiers,
        })
        .from(legalListClaims)
        .where(
          and(
            eq(legalListClaims.workspaceId, workspaceId),
            or(...ranges.map(rangeCondition)),
          ),
        )
        .orderBy(asc(legalListClaims.runId), asc(legalListClaims.position))
        .limit(limit);

/** Each claim as its reviewers see it now, through the run read's owners. */
const presentClaims = (
  claimRows: readonly ClaimRow[],
  reviews: ReadonlyMap<ClaimId, ClaimReviewRecord>,
  standings: Awaited<ReturnType<typeof readFactStandings>>,
): GraphClaimInput[] =>
  claimRows.map((claim) => {
    const review = reviews.get(claim.id)?.review ?? null;
    const graded = gradeOf(claim, review);
    const seen = reviewedView(claim, review ?? EMPTY_CLAIM_REVIEW);
    const resolution = review?.recordConflictResolution ?? null;
    return {
      id: claim.id,
      runId: claim.runId,
      position: claim.position,
      text: claim.text,
      state: seen.state,
      refs: seen.refs,
      recordConflict: graded.recordConflict,
      governingFactId:
        resolution?.kind === "governed" ? resolution.factEntityId : null,
      reviewStatus: review?.status ?? null,
      qualifiers: qualifiersOfClaim(claim, review, standings).map(
        (qualifier) => qualifier.kind,
      ),
    };
  });

type GraphFactsArgs = {
  listFacts: readonly VerificationEvidenceFact[];
  pinned: ReadonlyMap<FactId, VerificationEvidenceFact>;
  claims: readonly GraphClaimInput[];
  standings: Awaited<ReturnType<typeof readFactStandings>>;
};

/** The list's facts, and any fact off the list a claim of the page still
 *  links, as its run read it. */
const graphFacts = ({
  listFacts,
  pinned,
  claims,
  standings,
}: GraphFactsArgs): GraphFactInput[] => {
  const listOrdinal = new Map(
    listFacts.map((fact, index) => [fact.factEntityId, index]),
  );
  const linked = new Set<FactId>(
    claims.flatMap((claim) => [
      ...claim.refs.map((ref) => ref.factEntityId),
      ...(claim.recordConflict?.factEntityIds ?? []),
    ]),
  );
  const offList = [...linked]
    .filter((factId) => !listOrdinal.has(factId))
    .map(
      (factId) =>
        pinned.get(factId) ??
        panic("A claim links a fact no run of the page read"),
    );
  // Runs pinned before document names were recorded name a source by its
  // document's current name, as the run read does.
  const documentNames = new Map(
    [...listFacts, ...pinned.values()].flatMap((fact) =>
      fact.sources.flatMap((source) =>
        source.sourceName === undefined
          ? []
          : [[source.sourceEntityId, source.sourceName] as const],
      ),
    ),
  );
  return [...listFacts, ...offList].map((fact) => ({
    factEntityId: fact.factEntityId,
    text: fact.text,
    occurredOn: fact.occurredOn,
    occurredOnPrecision: fact.occurredOnPrecision,
    standing:
      standings.get(fact.factEntityId) ?? panic("A graph fact has no standing"),
    listOrdinal: listOrdinal.get(fact.factEntityId) ?? null,
    sources: fact.sources.map((source) => ({
      documentId: source.sourceEntityId,
      documentName:
        source.sourceName ?? documentNames.get(source.sourceEntityId) ?? "",
      locator: source.locator,
    })),
  }));
};

export const readVerificationGraph = async ({
  tx,
  workspaceId,
  listId,
  cursor,
  limit,
}: ReadVerificationGraphArgs): Promise<ReadVerificationGraphOutcome> => {
  const list = await tx
    .select({ id: legalLists.id })
    .from(legalLists)
    .where(
      and(eq(legalLists.id, listId), eq(legalLists.workspaceId, workspaceId)),
    )
    .limit(1);
  if (list.length === 0) {
    return { type: "list-not-found" };
  }

  const rows = await readStatementRows({ tx, workspaceId, listId, cursor });
  const plan = await planPage({ tx, workspaceId, cursor, rows, limit });
  const runIds = plan.statements.map((statement) => statement.runId);
  const runById = new Map(
    (await readRunsWithEvidence({ tx, workspaceId, runIds })).map((run) => [
      run.id,
      run,
    ]),
  );
  const runOf = (runId: RunId) =>
    runById.get(runId) ?? panic("A planned run was not read");

  const claimRows = await readPageClaims({
    tx,
    workspaceId,
    ranges: plan.ranges,
    limit,
  });
  const reviews = await readClaimReviewsOfRuns({
    tx,
    workspaceId,
    runIds,
    claimIds: claimRows.map((claim) => claim.id),
  });

  // Every fact a page's claims can rest on, as each run (and its claims'
  // re-checks) read it; the first document's reading wins for the node.
  const pinned = new Map<FactId, VerificationEvidenceFact>();
  for (const runId of runIds) {
    const runReviews = new Map(
      claimRows
        .filter((claim) => claim.runId === runId)
        .flatMap((claim) => {
          const record = reviews.get(claim.id);
          return record === undefined ? [] : [[claim.id, record] as const];
        }),
    );
    for (const fact of factsWithRechecks(runOf(runId).evidence, runReviews)
      .facts) {
      if (!pinned.has(fact.factEntityId)) {
        pinned.set(fact.factEntityId, fact);
      }
    }
  }
  const listFacts = await readListFacts({ tx, workspaceId, listId });
  const evidence: VerificationEvidence = {
    listId,
    facts: [
      ...pinned.values(),
      ...listFacts.facts.filter((fact) => !pinned.has(fact.factEntityId)),
    ],
  };
  const standings = await readFactStandings({ tx, workspaceId, evidence });
  const claims = presentClaims(claimRows, reviews, standings);

  const statements: GraphStatementInput[] = plan.statements.map((statement) => {
    const run = runOf(statement.runId);
    return {
      runId: statement.runId,
      entityId: statement.entityId,
      fileFieldId: statement.fileFieldId,
      documentName: run.documentName,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      claimCount: plan.totals.get(statement.runId) ?? 0,
    };
  });

  return {
    type: "read",
    graph: {
      listId,
      ...buildVerificationGraph({
        statements,
        claims,
        facts: graphFacts({
          listFacts: listFacts.facts,
          pinned,
          claims,
          standings,
        }),
      }),
      factOverflow: listFacts.overflow,
      nextCursor:
        plan.next === null ? null : verificationGraphCursor.encode(plan.next),
    },
    runs: plan.statements.map((statement) => ({
      id: statement.runId,
      entityId: statement.entityId,
      fileFieldId: statement.fileFieldId,
      entityVersionId: runOf(statement.runId).entityVersionId,
      listId,
      status: "completed" as const,
    })),
  };
};
