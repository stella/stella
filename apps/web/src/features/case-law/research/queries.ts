import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import type {
  CaseLawResearchAnswerType,
  CaseLawResearchDisposition,
  CaseLawResearchSavedQuery,
} from "@stll/api-contract";
import {
  publicCaseLawCountry,
  PUBLIC_CASE_LAW_COUNTRIES,
} from "@stll/api-contract/case-law-launch-readiness";

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
};

/** How often the cells are re-read while any of them is still pending. */
const ANSWERS_POLL_INTERVAL_MS = 2500;

/** Decisions per lookup request; the server caps the same way. */
const ANSWERS_LOOKUP_CHUNK = 200;

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

export type SavedQueryDecisionFilters =
  | { status: "available"; filters: DecisionListFilters }
  | { status: "unavailable" };

/** The saved query as the decision list/search query expects its filters. */
export const savedQueryToDecisionFilters = (
  savedQuery: CaseLawResearchSavedQuery,
): SavedQueryDecisionFilters => {
  const country =
    savedQuery.country === undefined
      ? (PUBLIC_CASE_LAW_COUNTRIES.at(0) ?? null)
      : publicCaseLawCountry(savedQuery.country);
  if (country === null) {
    return { status: "unavailable" };
  }

  return {
    status: "available",
    filters: {
      country,
      search: savedQuery.query,
      ...(savedQuery.court !== undefined && { court: savedQuery.court }),
      ...(savedQuery.dateFrom !== undefined && {
        dateFrom: savedQuery.dateFrom,
      }),
      ...(savedQuery.dateTo !== undefined && { dateTo: savedQuery.dateTo }),
      ...(savedQuery.decisionType !== undefined && {
        decisionType: savedQuery.decisionType,
      }),
      ...(savedQuery.language !== undefined && {
        language: savedQuery.language,
      }),
      ...(savedQuery.sourceId !== undefined && {
        sourceId: savedQuery.sourceId,
      }),
      // The order is part of what was saved, not a display preference: a
      // bounded search answers with a different first working set under a
      // different order, so a table saved under newest has to re-run that way.
      ...(savedQuery.sort !== undefined && { sort: savedQuery.sort }),
    },
  };
};

/** The current search, as the saved query a new research table stores. */
export const decisionFiltersToSavedQuery = (
  filters: DecisionListFilters & { search: string },
): CaseLawResearchSavedQuery => ({
  version: 1,
  query: filters.search,
  country: filters.country,
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
  ...(filters.sort !== undefined && { sort: filters.sort }),
});

// -- Organization question columns and their answers --
//
// A question column belongs to the organization, not to a table or a search:
// an answer is keyed by column and decision, so one answer serves every search
// that surfaces that decision. The table-scoped calls above belong to the
// retiring research tables and go with them.

type QuestionColumnsKey = { activeOrganizationId: string };

type QuestionAnswersKey = QuestionColumnsKey & {
  /** The decisions on the page, sorted, so the same page is the same key. */
  decisionIds: readonly string[];
};

export const questionColumnKeys = {
  all: ["case-law", "question-columns"],
  list: ({ activeOrganizationId }: QuestionColumnsKey) => [
    ...questionColumnKeys.all,
    "list",
    { activeOrganizationId },
  ],
  answers: ({ activeOrganizationId }: QuestionColumnsKey) => [
    ...questionColumnKeys.all,
    "answers",
    { activeOrganizationId },
  ],
  answersFor: ({ activeOrganizationId, decisionIds }: QuestionAnswersKey) => [
    ...questionColumnKeys.answers({ activeOrganizationId }),
    { decisionIds },
  ],
};

const listQuestionColumns = async (signal: AbortSignal) =>
  unwrapEden(await api.case.research.columns.get({ fetch: { signal } }));

/** Every question the organization asks, in the order the server keeps them. */
export const questionColumnsOptions = (key: QuestionColumnsKey) =>
  queryOptions({
    queryKey: questionColumnKeys.list(key),
    queryFn: async ({ signal }) => (await listQuestionColumns(signal)).items,
    staleTime: ROUTE_QUERY_STALE_TIME_MS,
  });

const lookupAnswers = async (
  decisionIds: readonly string[],
  signal: AbortSignal,
) =>
  unwrapEden(
    await api.case.research.answers.lookup.post(
      {
        decisionIds: decisionIds.map((decisionId) =>
          toSafeId<"caseLawDecision">(decisionId),
        ),
      },
      { fetch: { signal } },
    ),
  );

/**
 * The cells for the decisions on the page, every column at once. Polls while
 * any of them is pending, so a run's progress lands cell by cell.
 */
export const questionAnswersOptions = (key: QuestionAnswersKey) =>
  queryOptions({
    queryKey: questionColumnKeys.answersFor(key),
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        chunk(key.decisionIds, ANSWERS_LOOKUP_CHUNK).map(
          async (decisionIds) => await lookupAnswers(decisionIds, signal),
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

type QuestionColumnInput = {
  question: string;
  answerType: CaseLawResearchAnswerType;
};

export const createQuestionColumn = async (input: QuestionColumnInput) =>
  unwrapEden(await api.case.research.columns.post(input));

export const updateQuestionColumn = async ({
  columnId,
  ...input
}: QuestionColumnInput & { columnId: string }) =>
  unwrapEden(
    await api.case.research
      .columns({ columnId: toSafeId<"caseLawResearchColumn">(columnId) })
      .patch(input),
  );

export const deleteQuestionColumn = async (columnId: string) =>
  unwrapEden(
    await api.case.research
      .columns({ columnId: toSafeId<"caseLawResearchColumn">(columnId) })
      .delete(),
  );

type RunAnswersInput = {
  /** Absent: every question the organization asks. */
  columnIds?: readonly string[] | undefined;
  decisionIds: readonly string[];
  /** Answer again where an answer already stands. */
  force?: boolean | undefined;
};

/**
 * Queue the cells of one page, in one request. The largest page the search
 * offers is exactly the largest run the endpoint accepts, so a page is never
 * split; anything larger is the caller's mistake and the server says so,
 * rather than being silently cut here.
 */
export const runAnswers = async ({
  columnIds,
  decisionIds,
  force,
}: RunAnswersInput): Promise<{ queued: number }> =>
  unwrapEden(
    await api.case.research.answers.run.post({
      decisionIds: decisionIds.map((decisionId) =>
        toSafeId<"caseLawDecision">(decisionId),
      ),
      ...(columnIds !== undefined && {
        columnIds: columnIds.map((columnId) =>
          toSafeId<"caseLawResearchColumn">(columnId),
        ),
      }),
      ...(force !== undefined && { force }),
    }),
  );
