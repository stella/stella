import { infiniteQueryOptions } from "@tanstack/react-query";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { MAX_DICTATION_TERMS_PER_REQUEST } from "@stll/api-contract/dictation-vocabulary";

import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { unwrapApiResponse } from "@/lib/errors/api";
import { stringCursorSeed } from "@/lib/infinite-query";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

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

/** Adds the words a batch at a time (the API takes each under the list's
 *  lock, so the limit holds); returns how many were added. */
export const addDictationTerms = async (terms: readonly string[]) => {
  const added = await Promise.all(
    batches(terms).map(
      async (batch) =>
        await invokeCapability(
          "organization-settings.dictation-vocabulary.add",
          async (request) =>
            unwrapApiResponse(
              await api["organization-settings"]["dictation-vocabulary"].post(
                { terms: batch },
                request,
              ),
            ),
        ),
    ),
  );
  return { added: sum(added.map((result) => result.added)) };
};

export const deleteDictationTerms = async (
  ids: readonly DictationVocabularyTerm["id"][],
) => {
  const deleted = await Promise.all(
    batches(ids).map(
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
    ),
  );
  return { deleted: sum(deleted.map((result) => result.deleted)) };
};

export const exportDictationTerms = async () =>
  unwrapApiResponse(
    await api["organization-settings"]["dictation-vocabulary"].export.get(),
  ).terms;
