import { Result } from "better-result";
import { count, desc, eq, max } from "drizzle-orm";

import {
  dictationTermKey,
  MAX_ORGANIZATION_DICTATION_TERMS,
} from "@stll/api-contract/dictation-vocabulary";
import { MAX_TRANSCRIPTION_VOCABULARY_TERMS } from "@stll/api-contract/transcription";

import type { Transaction } from "@/api/db/root";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { dictationVocabularyTerms } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { boundedAll } from "@/api/lib/db/bounded-all";
import {
  buildVocabularyIndex,
  selectVocabulary,
} from "@/api/lib/dictation/vocabulary-index";
import type { VocabularyIndex } from "@/api/lib/dictation/vocabulary-index";

/**
 * The organization's dictation words as a dictation reads them. A model
 * never gets the whole list: cleanup gets the words its transcript seems to
 * mention (`vocabulary-index.ts`), transcription, which has no text yet, the
 * newest words that fit its hint.
 */

/** How many organization words one cleanup gets, after the speaker's own. */
export const CLEANUP_ORGANIZATION_TERMS = 150;

/** Indexes kept in memory, by the number of words they hold. */
const MAX_CACHED_TERMS = 4 * MAX_ORGANIZATION_DICTATION_TERMS;

type CachedIndex = { version: string; index: VocabularyIndex };

const cachedIndexes = new Map<SafeId<"organization">, CachedIndex>();
let cachedTerms = 0;

const remember = (
  organizationId: SafeId<"organization">,
  entry: CachedIndex,
) => {
  const replaced = cachedIndexes.get(organizationId);
  if (replaced !== undefined) {
    cachedIndexes.delete(organizationId);
    cachedTerms -= replaced.index.size;
  }
  cachedIndexes.set(organizationId, entry);
  cachedTerms += entry.index.size;
  // The least recently used indexes go first; the newest always stays.
  for (const [oldest, { index }] of cachedIndexes) {
    if (cachedTerms <= MAX_CACHED_TERMS || oldest === organizationId) {
      break;
    }
    cachedIndexes.delete(oldest);
    cachedTerms -= index.size;
  }
};

/** Forgets every cached index; for tests. */
export const forgetOrganizationVocabularyIndexes = () => {
  cachedIndexes.clear();
  cachedTerms = 0;
};

/**
 * The list's version: how many words it holds and when the newest was
 * added. Every add moves the newest, every delete the count, so a cached
 * index is rebuilt after any change on any API task.
 */
const readVersion = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<string> => {
  const [row] = await tx
    .select({
      words: count(),
      newest: max(dictationVocabularyTerms.createdAt),
    })
    .from(dictationVocabularyTerms)
    .where(eq(dictationVocabularyTerms.organizationId, organizationId));
  return `${row?.words ?? 0}:${row?.newest?.toISOString() ?? ""}`;
};

const readNewestFirst = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  limit: number,
): Promise<string[]> =>
  (
    await tx
      .select({ term: dictationVocabularyTerms.term })
      .from(dictationVocabularyTerms)
      .where(eq(dictationVocabularyTerms.organizationId, organizationId))
      .orderBy(
        desc(dictationVocabularyTerms.createdAt),
        desc(dictationVocabularyTerms.id),
      )
      .limit(limit)
  ).map(({ term }) => term);

/** The organization's index, from memory while the list is unchanged. */
const readIndex = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<VocabularyIndex> => {
  const version = await readVersion(tx, organizationId);
  const cached = cachedIndexes.get(organizationId);
  if (cached?.version === version) {
    remember(organizationId, cached);
    return cached.index;
  }
  const terms = await boundedAll({
    invariant:
      "MAX_ORGANIZATION_DICTATION_TERMS, enforced under a lock by organization-settings/dictation-vocabulary/add.ts",
    max: MAX_ORGANIZATION_DICTATION_TERMS,
    table: "dictation_vocabulary_terms",
    query: async (limit) => await readNewestFirst(tx, organizationId, limit),
  });
  const index = buildVocabularyIndex(terms);
  remember(organizationId, { version, index });
  return index;
};

/** Words in order, each once by its key, at most `limit`. */
export const mergeDictationTerms = (
  lists: readonly (readonly string[])[],
  limit: number,
): string[] => {
  const merged = new Map<string, string>();
  for (const list of lists) {
    for (const term of list) {
      if (merged.size === limit) {
        return [...merged.values()];
      }
      const key = dictationTermKey(term);
      if (!merged.has(key)) {
        merged.set(key, term);
      }
    }
  }
  return [...merged.values()];
};

type OrganizationVocabularyOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
};

type CleanupVocabularyOptions = OrganizationVocabularyOptions & {
  /** The text the model cleans up. */
  transcript: string;
  /** The speaker's own words, which come first. */
  personal?: readonly string[] | undefined;
};

/**
 * The words one cleanup gets: the speaker's own first, then at most
 * `CLEANUP_ORGANIZATION_TERMS` of the organization's words this transcript
 * seems to mention. Call it once per text sent to the model; its cost grows
 * with the transcript's length, not with the list's.
 */
export const readCleanupVocabulary = async ({
  safeDb,
  organizationId,
  transcript,
  personal = [],
}: CleanupVocabularyOptions): Promise<Result<string[], SafeDbError>> =>
  (await safeDb(async (tx) => await readIndex(tx, organizationId))).map(
    (index) =>
      mergeDictationTerms(
        [
          personal,
          selectVocabulary(index, transcript, CLEANUP_ORGANIZATION_TERMS),
        ],
        personal.length + CLEANUP_ORGANIZATION_TERMS,
      ),
  );

type TranscriptionVocabularyOptions = OrganizationVocabularyOptions & {
  /** The request's own words (the speaker's, then its matter's). */
  first: readonly string[];
};

/**
 * The words one audio chunk's transcription gets. There is no text yet to
 * choose by, so after the request's own words come the organization's
 * newest, up to the transcription limit. Words added last are the ones an
 * administrator is working on now; the matter's own names already come
 * with the request.
 */
export const readTranscriptionVocabulary = async ({
  safeDb,
  organizationId,
  first,
}: TranscriptionVocabularyOptions): Promise<Result<string[], SafeDbError>> => {
  const kept = mergeDictationTerms([first], MAX_TRANSCRIPTION_VOCABULARY_TERMS);
  const room = MAX_TRANSCRIPTION_VOCABULARY_TERMS - kept.length;
  if (room === 0) {
    return Result.ok(kept);
  }
  return (
    await safeDb(
      async (tx) =>
        // Read a little more than fits: some may repeat the request's own.
        await readNewestFirst(tx, organizationId, room + kept.length),
    )
  ).map((newest) =>
    mergeDictationTerms([kept, newest], MAX_TRANSCRIPTION_VOCABULARY_TERMS),
  );
};
