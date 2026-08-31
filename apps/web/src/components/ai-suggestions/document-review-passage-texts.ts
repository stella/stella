/**
 * The words behind reference passages, by id.
 *
 * Every review surface — a streamed proposal, a run's findings, a playbook
 * position — carries passage ids only: the text lives in the matter the
 * reference belongs to and reaches a reader through that matter's own row
 * security. A surface that draws quotes therefore asks for the words here,
 * and asks for all of its ids at once, so a list of twenty cards costs one
 * request rather than twenty.
 */

import { useMemo } from "react";

import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { api } from "@/lib/api";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

/** The endpoint's cap on one body. A surface holding more ids than this is
 *  read in as many requests as it takes, still under one cache entry. */
const PASSAGE_READ_BATCH = DOCUMENT_REVIEW_LIMITS.passageReadMax;

/**
 * What a surface knows about the words behind its passages.
 *
 * `pending` is the difference between "not read yet" and "not readable": an
 * id absent from a settled answer is one whose matter this reader cannot
 * open, which the surfaces say out loud, while an id absent from a read still
 * in flight is nothing to say anything about.
 */
export type ReferencePassageTexts = {
  readonly textById: ReadonlyMap<string, string>;
  readonly pending: boolean;
};

/** The ids as the cache reads them: deduplicated and ordered, so two surfaces
 *  quoting the same passages in different orders share one entry. */
export const passageTextIds = (ids: readonly string[]): string[] =>
  [...new Set(ids)].toSorted();

export const documentReviewPassageTextKeys = {
  all: ["document-review-passage-texts"] as const,
  list: (ids: readonly string[]) =>
    [...documentReviewPassageTextKeys.all, ids] as const,
};

const fetchPassageTexts = async (
  ids: readonly string[],
  signal: AbortSignal,
) => {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += PASSAGE_READ_BATCH) {
    batches.push(ids.slice(start, start + PASSAGE_READ_BATCH));
  }
  const pages = await Promise.all(
    batches.map(async (batch) =>
      unwrapEden(
        await api["document-reviews"].passages.post(
          {
            ids: batch.map((id) =>
              toSafeId<"documentReviewReferencePassage">(id),
            ),
          },
          { fetch: { signal } },
        ),
      ),
    ),
  );
  return pages.flatMap((page) => page.passages);
};

type PassageTextRow = { id: string; text: string };

const textByIdOf = (
  passages: readonly PassageTextRow[],
): ReadonlyMap<string, string> =>
  new Map(passages.map((passage) => [passage.id, passage.text]));

/**
 * The words for one surface's passages. Keyed by the id list itself, because
 * that list is the question: a proposal that has streamed twelve positions is
 * asking something the answer for eleven does not contain.
 */
export const documentReviewPassageTextsOptions = (ids: readonly string[]) => {
  const keyIds = passageTextIds(ids);
  return queryOptions({
    queryKey: documentReviewPassageTextKeys.list(keyIds),
    queryFn: async ({ signal }) => await fetchPassageTexts(keyIds, signal),
    select: textByIdOf,
    // A passage id names one immutable quote of one pinned version. Nothing
    // about it can change under the reader, so nothing is worth re-reading.
    staleTime: Number.POSITIVE_INFINITY,
    enabled: keyIds.length > 0,
    // A streaming proposal grows its id list position by position, and each
    // longer list is a different question. Keeping the shorter answer on
    // screen while the longer one is in flight is what stops the quotes
    // already being read from blanking on every frame.
    placeholderData: keepPreviousData,
  });
};

/** One quoted block as the passage components read it. */
export type QuotedPassage = { blockId: string; text: string };

/**
 * The passages this reader may actually see, in the order they were pinned.
 * One whose words did not come back is dropped rather than drawn as an empty
 * quote; a group that loses every passage that way says so instead.
 */
export const quotedPassages = (
  passages: readonly { readonly id: string; readonly blockId: string }[],
  textById: ReadonlyMap<string, string>,
): QuotedPassage[] => {
  const quoted: QuotedPassage[] = [];
  for (const passage of passages) {
    const text = textById.get(passage.id);
    if (text !== undefined) {
      quoted.push({ blockId: passage.blockId, text });
    }
  }
  return quoted;
};

/**
 * The words for every passage on one surface. Callers pass the whole surface's
 * passages — all positions of a proposal, all findings of a run — so the list
 * is read once for the list, never once per card.
 */
export const useReferencePassageTexts = (
  passages: readonly { readonly id: string }[],
): ReferencePassageTexts => {
  const ids = passageTextIds(passages.map((passage) => passage.id));
  const { data, isError } = useQuery(documentReviewPassageTextsOptions(ids));
  // One stable empty map per hook instance: a fresh Map each render would hand
  // every consumer a new identity while nothing has loaded.
  const empty = useMemo(() => new Map<string, string>(), []);
  return {
    // A failed read is a settled one: the words are not on screen, and saying
    // so is better than a column that never resolves.
    pending: ids.length > 0 && data === undefined && !isError,
    textById: data ?? empty,
  };
};
