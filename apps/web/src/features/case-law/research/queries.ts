import { queryOptions } from "@tanstack/react-query";

import {
  questionSuggestionBody,
  researchRunBatches,
} from "@/features/case-law/research/question-columns.logic";
import type { QuestionColumnInput } from "@/features/case-law/research/question-columns.logic";
import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { ROUTE_QUERY_STALE_TIME_MS } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";

/**
 * The organization's question columns and their answers.
 *
 * The question library belongs to the organization; each search picks which of
 * its questions to show (`search-questions.logic`). An answer is keyed by
 * column and decision, so one answer serves every search that shows that
 * question beside that decision.
 */

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

/**
 * The flat body the endpoint takes. The kind and its options travel as
 * separate fields there, the way a property's do, so the content shape is
 * unpacked once here rather than at each call site.
 */
const toColumnBody = ({ content, question }: QuestionColumnInput) => ({
  question,
  answerType: content.type,
  ...(content.type === "single-select" || content.type === "multi-select"
    ? { options: content.options }
    : {}),
});

export const createQuestionColumn = async (input: QuestionColumnInput) =>
  unwrapEden(await api.case.research.columns.post(toColumnBody(input)));

export const updateQuestionColumn = async ({
  columnId,
  ...input
}: QuestionColumnInput & { columnId: string }) =>
  unwrapEden(
    await api.case.research
      .columns({ columnId: toSafeId<"caseLawResearchColumn">(columnId) })
      .patch(toColumnBody(input)),
  );

/**
 * One drafted or refined question wording. The search the column is being
 * added to travels with it, so the suggestion targets those decisions; the
 * server reads them itself from the ids the body names.
 */
export const suggestQuestionPrompt = async (
  input: Parameters<typeof questionSuggestionBody>[0],
) => {
  const { decisionIds, ...body } = questionSuggestionBody(input);
  return unwrapEden(
    await api.case.research.columns["suggest-prompt"].post({
      ...body,
      decisionIds: decisionIds.map((decisionId) =>
        toSafeId<"caseLawDecision">(decisionId),
      ),
    }),
  );
};

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
 * Queue the cells of a run set. One request for a page, whose largest size is
 * exactly the largest run the endpoint accepts; a saved table that has loaded
 * several pages is split, because the endpoint refuses a longer list outright.
 *
 * The batches name disjoint sets of decisions, so they are independent
 * requests and go together, the way the answer lookup above splits its own.
 */
export const runAnswers = async ({
  columnIds,
  decisionIds,
  force,
}: RunAnswersInput): Promise<{ queued: number }> => {
  const results = await Promise.all(
    researchRunBatches(decisionIds).map(
      async (batch) =>
        unwrapEden(
          await api.case.research.answers.run.post({
            decisionIds: batch.map((decisionId) =>
              toSafeId<"caseLawDecision">(decisionId),
            ),
            ...(columnIds !== undefined && {
              columnIds: columnIds.map((columnId) =>
                toSafeId<"caseLawResearchColumn">(columnId),
              ),
            }),
            ...(force !== undefined && { force }),
          }),
        ).queued,
    ),
  );
  return { queued: results.reduce((total, queued) => total + queued, 0) };
};
