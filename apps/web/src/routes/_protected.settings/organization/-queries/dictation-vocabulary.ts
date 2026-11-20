import { infiniteQueryOptions } from "@tanstack/react-query";

import { MAX_DICTATION_TERMS_PER_REQUEST } from "@stll/api-contract/dictation-vocabulary";

import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";

export const dictationVocabularyKeys = {
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

export type DictationVocabularyPage = Awaited<ReturnType<typeof listPage>>;
export type DictationVocabularyTerm = DictationVocabularyPage["items"][number];

/** The organization's words matching a search, a page at a time. */
export const dictationVocabularyOptions = (
  organizationId: string,
  search: string,
) =>
  infiniteQueryOptions({
    queryKey: dictationVocabularyKeys.list(organizationId, search),
    initialPageParam: stringCursorSeed(),
    queryFn: async ({ pageParam, signal }) =>
      await listPage(search, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** Requests of at most the API's batch size, in order. */
const batches = <T>(items: readonly T[]): T[][] => {
  const result: T[][] = [];
  for (
    let start = 0;
    start < items.length;
    start += MAX_DICTATION_TERMS_PER_REQUEST
  ) {
    result.push(items.slice(start, start + MAX_DICTATION_TERMS_PER_REQUEST));
  }
  return result;
};

/** How many of the words the list already holds, and how many it holds. */
export const checkDictationTerms = async (terms: readonly string[]) => {
  let listed = 0;
  let total = 0;
  for (const batch of batches(terms)) {
    const response =
      // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- ordered batches, so the first failure stops the rest
      await api["organization-settings"]["dictation-vocabulary"].check.post({
        terms: batch,
      });
    const checked = unwrapApiResponse(response);
    listed += checked.listed;
    total = checked.total;
  }
  return { listed, total };
};

/** Adds the words batch by batch; returns how many were added. */
export const addDictationTerms = async (terms: readonly string[]) => {
  let added = 0;
  for (const batch of batches(terms)) {
    const response =
      // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- ordered batches: each add checks the list's limit against the batches before it, and the first failure stops the rest
      await api["organization-settings"]["dictation-vocabulary"].post({
        terms: batch,
      });
    added += unwrapApiResponse(response).added;
  }
  return { added };
};

export const deleteDictationTerms = async (
  ids: readonly DictationVocabularyTerm["id"][],
) => {
  let deleted = 0;
  for (const batch of batches(ids)) {
    const response =
      // oxlint-disable-next-line no-network-await-in-loop/no-network-await-in-loop -- ordered batches, so the first failure stops the rest
      await api["organization-settings"]["dictation-vocabulary"].delete({
        ids: batch,
      });
    deleted += unwrapApiResponse(response).deleted;
  }
  return { deleted };
};

export const exportDictationTerms = async () =>
  unwrapApiResponse(
    await api["organization-settings"]["dictation-vocabulary"].export.get(),
  ).terms;
