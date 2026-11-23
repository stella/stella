import { infiniteQueryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { MAX_DICTATION_TERMS_PER_REQUEST } from "@stll/api-contract/dictation-vocabulary";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

const dictationVocabularyKeys = {
  all: (organizationId: string) =>
    ["organization-settings", "dictation-vocabulary", organizationId] as const,
  list: (organizationId: string, search: string) =>
    [...dictationVocabularyKeys.all(organizationId), "list", search] as const,
};

const PAGE_SIZE = 100;

const listPage = async (
  search: string,
  cursor: string | undefined,
  signal: AbortSignal,
) =>
  unwrapApiResponse(
    await api["organization-settings"]["dictation-vocabulary"].get({
      query: {
        limit: PAGE_SIZE,
        ...(search.length === 0 ? {} : { search }),
        ...(cursor === undefined ? {} : { cursor }),
      },
      fetch: { signal },
    }),
  );

type DictationVocabularyPage = Awaited<ReturnType<typeof listPage>>;
export type DictationVocabularyTerm = DictationVocabularyPage["items"][number];

/** The organization's words matching a search, a page at a time. */
export const dictationVocabularyOptions = (
  organizationId: string,
  search: string,
) =>
  resourceQueryOptions(
    infiniteQueryOptions({
      queryKey: dictationVocabularyKeys.list(organizationId, search),
      initialPageParam: stringCursorSeed(),
      queryFn: async ({ pageParam, signal }) =>
        await listPage(search, pageParam, signal),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    {
      resources: [RESOURCE_TYPE.ORGANIZATION],
      scope: { type: "organization", organizationId },
    },
  );

/** Requests of at most the API's batch size. */
const batches = <T>(items: readonly T[]): T[][] =>
  Array.from(
    { length: Math.ceil(items.length / MAX_DICTATION_TERMS_PER_REQUEST) },
    (_, index) =>
      items.slice(
        index * MAX_DICTATION_TERMS_PER_REQUEST,
        (index + 1) * MAX_DICTATION_TERMS_PER_REQUEST,
      ),
  );

const sum = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
};

/** How many of the words the list already holds, and how many it holds. */
export const checkDictationTerms = async (terms: readonly string[]) => {
  const checked = await Promise.all(
    batches(terms).map(
      async (batch) =>
        await invokeCapability(
          "organization-settings.dictation-vocabulary.check",
          async (request) =>
            unwrapApiResponse(
              await api["organization-settings"][
                "dictation-vocabulary"
              ].check.post({ terms: batch }, request),
            ),
        ),
    ),
  );
  return {
    listed: sum(checked.map(({ listed }) => listed)),
    total: Math.max(0, ...checked.map(({ total }) => total)),
  };
};

/** A batched write's outcome: what the batches that went through did, and
 *  the first batch failure, if any. */
export type DictationBatchFailure = { error: unknown } | null;

/**
 * Runs every batch to its end. A failed batch leaves the others' changes in
 * place, so the caller learns both what was done and what failed, and the
 * write still settles (and refreshes the list) once.
 */
const settleBatches = async <T, R>(
  items: readonly T[],
  run: (batch: T[]) => Promise<R>,
): Promise<{ done: R[]; failure: DictationBatchFailure }> => {
  const settled = await Promise.allSettled(batches(items).map(run));
  const done: R[] = [];
  let failure: DictationBatchFailure = null;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      done.push(outcome.value);
    } else {
      failure ??= { error: outcome.reason };
    }
  }
  return { done, failure };
};

/** Adds one request's words; the API takes them under the list's lock, so
 *  the limit holds. A failure rejects. */
const postTerms = async (terms: readonly string[]) =>
  await invokeCapability(
    "organization-settings.dictation-vocabulary.add",
    async (request) =>
      unwrapApiResponse(
        await api["organization-settings"]["dictation-vocabulary"].post(
          { terms: [...terms] },
          request,
        ),
      ),
  );

/** Adds one word: one request, so its failure is the write's. */
export const addDictationTerm = async (term: string) => await postTerms([term]);

/** Adds the words a batch at a time; returns how many were added, and the
 *  first batch that failed. */
export const addDictationTerms = async (terms: readonly string[]) => {
  const { done, failure } = await settleBatches(terms, postTerms);
  return { added: sum(done.map((result) => result.added)), failure };
};

/** Removes the words a batch at a time; returns how many were removed, and
 *  the first batch that failed. */
export const deleteDictationTerms = async (
  ids: readonly DictationVocabularyTerm["id"][],
) => {
  const { done, failure } = await settleBatches(
    ids,
    async (batch) =>
      await invokeCapability(
        "organization-settings.dictation-vocabulary.delete",
        async (request) =>
          unwrapApiResponse(
            await api["organization-settings"]["dictation-vocabulary"].delete(
              { ids: batch },
              request,
            ),
          ),
      ),
  );
  return { deleted: sum(done.map((result) => result.deleted)), failure };
};

export const exportDictationTerms = async () =>
  unwrapApiResponse(
    await api["organization-settings"]["dictation-vocabulary"].export.get(),
  ).terms;
