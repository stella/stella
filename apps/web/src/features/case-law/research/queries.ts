import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type {
  CaseLawResearchAnswerType,
  CaseLawResearchDisposition,
  CaseLawResearchSavedQuery,
} from "@stll/api-contract";

import type { DecisionListFilters } from "@/features/case-law/queries/decisions";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { nullableStringCursorSeed } from "@/lib/infinite-query";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

const RESEARCH_TABLES_PAGE_SIZE = 50;

type ResearchTablesListKey = { activeOrganizationId: string };
type ResearchTableKey = { activeOrganizationId: string; tableId: string };

/** Keyed by organization: a member sees a different set in each firm. */
export const researchTableKeys = {
  all: ["case-law", "research-tables"],
  list: ({ activeOrganizationId }: ResearchTablesListKey) => [
    ...researchTableKeys.all,
    "list",
    { activeOrganizationId },
  ],
  detail: ({ activeOrganizationId, tableId }: ResearchTableKey) => [
    ...researchTableKeys.all,
    "detail",
    { activeOrganizationId, tableId },
  ],
  answers: ({ activeOrganizationId, tableId }: ResearchTableKey) => [
    ...researchTableKeys.all,
    "answers",
    { activeOrganizationId, tableId },
  ],
  answersFor: ({
    activeOrganizationId,
    decisionIds,
    tableId,
  }: ResearchAnswersKey) => [
    ...researchTableKeys.answers({ activeOrganizationId, tableId }),
    { decisionIds },
  ],
};

type ResearchAnswersKey = ResearchTableKey & {
  /** The decisions on screen, sorted, so the same set is the same key. */
  decisionIds: readonly string[];
};

/** How often the cells are re-read while any of them is still pending. */
const ANSWERS_POLL_INTERVAL_MS = 2500;

/** Decisions per lookup request; the server caps the same way. */
const ANSWERS_LOOKUP_CHUNK = 200;

/** Decisions per run request; the server caps the same way. */
const RUN_CHUNK = 100;

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
};

export const researchTablesInfiniteOptions = (key: ResearchTablesListKey) =>
  infiniteQueryOptions({
    queryKey: researchTableKeys.list(key),
    queryFn: async ({ pageParam, signal }) => {
      const response = await api.case.research.get({
        query: {
          limit: RESEARCH_TABLES_PAGE_SIZE,
          ...(pageParam !== null && { cursor: pageParam }),
        },
        fetch: { signal },
      });
      return unwrapEden(response);
    },
    initialPageParam: nullableStringCursorSeed(),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

export const researchTableOptions = (key: ResearchTableKey) =>
  queryOptions({
    queryKey: researchTableKeys.detail(key),
    queryFn: async ({ signal }) => {
      const response = await api.case
        .research({ tableId: toSafeId<"caseLawResearchTable">(key.tableId) })
        .get({ fetch: { signal } });
      return unwrapEden(response);
    },
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

const researchTableApi = (tableId: string) =>
  api.case.research({ tableId: toSafeId<"caseLawResearchTable">(tableId) });

/**
 * The cells for the decisions on screen, every column at once. Bounded by what
 * the table shows rather than by everything it ever answered; polls while any
 * of those cells is pending, so a run's progress shows as it lands.
 */
export const researchAnswersOptions = (key: ResearchAnswersKey) =>
  queryOptions({
    queryKey: researchTableKeys.answersFor(key),
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        chunk(key.decisionIds, ANSWERS_LOOKUP_CHUNK).map(
          async (decisionIds) =>
            await lookupResearchAnswers(key.tableId, decisionIds, signal),
        ),
      );
      return pages.flatMap((page) => page.items);
    },
    enabled: key.decisionIds.length > 0,
    refetchInterval: (query) =>
      query.state.data?.some((answer) => answer.state === "pending")
        ? ANSWERS_POLL_INTERVAL_MS
        : false,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

const lookupResearchAnswers = async (
  tableId: string,
  decisionIds: readonly string[],
  signal: AbortSignal,
) =>
  unwrapEden(
    await researchTableApi(tableId).answers.lookup.post(
      {
        decisionIds: decisionIds.map((decisionId) =>
          toSafeId<"caseLawDecision">(decisionId),
        ),
      },
      { fetch: { signal } },
    ),
  );

export type ResearchAnswer = Awaited<
  ReturnType<typeof lookupResearchAnswers>
>["items"][number];

type ResearchColumnInput = {
  tableId: string;
  question: string;
  answerType: CaseLawResearchAnswerType;
};

export const createResearchColumn = async ({
  answerType,
  question,
  tableId,
}: ResearchColumnInput) =>
  unwrapEden(
    await researchTableApi(tableId).columns.post({ answerType, question }),
  );

export const updateResearchColumn = async ({
  answerType,
  columnId,
  question,
  tableId,
}: ResearchColumnInput & { columnId: string }) =>
  unwrapEden(
    await researchTableApi(tableId)
      .columns({ columnId: toSafeId<"caseLawResearchColumn">(columnId) })
      .patch({ answerType, question }),
  );

export const deleteResearchColumn = async ({
  columnId,
  tableId,
}: {
  columnId: string;
  tableId: string;
}) =>
  unwrapEden(
    await researchTableApi(tableId)
      .columns({ columnId: toSafeId<"caseLawResearchColumn">(columnId) })
      .delete(),
  );

/**
 * What a run covers: every column, filling only the cells that have no
 * answer yet, or one column, answered again from scratch.
 */
export type RunResearchAnswersScope =
  | { scope: "table" }
  | { scope: "column"; columnId: string };

type RunResearchAnswersInput = RunResearchAnswersScope & {
  tableId: string;
  decisionIds: readonly string[];
};

/**
 * Queue answers for every decision given, in server-sized batches submitted
 * one after another so a large table is never silently cut at the first batch.
 */
export const runResearchAnswers = async (
  input: RunResearchAnswersInput,
): Promise<{ queued: number }> => {
  let queued = 0;
  for (const batch of chunk(input.decisionIds, RUN_CHUNK)) {
    const decisionIds = batch.map((decisionId) =>
      toSafeId<"caseLawDecision">(decisionId),
    );
    const body =
      input.scope === "table"
        ? { decisionIds }
        : {
            decisionIds,
            columnIds: [toSafeId<"caseLawResearchColumn">(input.columnId)],
            force: true,
          };
    const table = researchTableApi(input.tableId);
    const response = await table.answers.run.post(body);
    queued += unwrapEden(response).queued;
  }
  return { queued };
};

export const renameResearchTable = async (tableId: string, name: string) =>
  unwrapEden(await researchTableApi(tableId).patch({ name }));

export const deleteResearchTable = async (tableId: string) =>
  unwrapEden(await researchTableApi(tableId).delete());

type SetResearchTableDecisionInput = {
  tableId: string;
  decisionId: string;
  /** Null clears the pin or exclusion, leaving the saved query to decide. */
  disposition: CaseLawResearchDisposition | null;
};

export const setResearchTableDecision = async ({
  decisionId: rawDecisionId,
  disposition,
  tableId,
}: SetResearchTableDecisionInput) => {
  const table = researchTableApi(tableId);
  const decisionId = toSafeId<"caseLawDecision">(rawDecisionId);
  return disposition === null
    ? unwrapEden(await table.decisions({ decisionId }).delete())
    : unwrapEden(await table.decisions.put({ decisionId, disposition }));
};

export type ResearchTableDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof researchTableOptions>["queryFn"]>>
>;

export type ResearchColumn = ResearchTableDetail["columns"][number];

export type ResearchTableSummary = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof researchTablesInfiniteOptions>["queryFn"]>
  >
>["items"][number];

/** The saved query as the decision list/search query expects its filters. */
export const savedQueryToDecisionFilters = (
  savedQuery: CaseLawResearchSavedQuery,
): DecisionListFilters => ({
  search: savedQuery.query,
  ...(savedQuery.country !== undefined && { country: savedQuery.country }),
  ...(savedQuery.court !== undefined && { court: savedQuery.court }),
  ...(savedQuery.dateFrom !== undefined && { dateFrom: savedQuery.dateFrom }),
  ...(savedQuery.dateTo !== undefined && { dateTo: savedQuery.dateTo }),
  ...(savedQuery.decisionType !== undefined && {
    decisionType: savedQuery.decisionType,
  }),
  ...(savedQuery.language !== undefined && { language: savedQuery.language }),
  ...(savedQuery.sourceId !== undefined && { sourceId: savedQuery.sourceId }),
});

/** The current search, as the saved query a new research table stores. */
export const decisionFiltersToSavedQuery = (
  filters: DecisionListFilters & { search: string },
): CaseLawResearchSavedQuery => ({
  version: 1,
  query: filters.search,
  ...(filters.country !== undefined && { country: filters.country }),
  ...(filters.court !== undefined && { court: filters.court }),
  ...(filters.dateFrom !== undefined && { dateFrom: filters.dateFrom }),
  ...(filters.dateTo !== undefined && { dateTo: filters.dateTo }),
  ...(filters.decisionType !== undefined && {
    decisionType: filters.decisionType,
  }),
  ...(filters.language !== undefined && { language: filters.language }),
  ...(filters.sourceId !== undefined && {
    sourceId: toSafeId<"caseLawSource">(filters.sourceId),
  }),
});
