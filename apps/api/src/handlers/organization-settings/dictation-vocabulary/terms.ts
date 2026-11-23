import { and, count, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import {
  dictationTermKey,
  isStoredDictationTerm,
  MAX_DICTATION_TERM_LENGTH,
  MAX_DICTATION_TERMS_PER_REQUEST,
} from "@stll/api-contract/dictation-vocabulary";

import type { Transaction } from "@/api/db/root";
import { dictationVocabularyTerms } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { uniqueItems } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";

/** Words as an add or a check carries them: each stored as sent, once. */
export const dictationTermsBodySchema = v.strictObject({
  terms: v.pipe(
    v.array(
      v.pipe(
        v.string(),
        v.maxLength(MAX_DICTATION_TERM_LENGTH),
        v.check(
          isStoredDictationTerm,
          "A word must be trimmed, single-spaced, NFC and free of control characters",
        ),
      ),
    ),
    v.minLength(1),
    v.maxLength(MAX_DICTATION_TERMS_PER_REQUEST),
    uniqueItems(dictationTermKey),
  ),
});

/**
 * Serializes the writers of one organization's list, so the cap holds when
 * two administrators add words at once: the count a writer decides on
 * includes every committed sibling. Released at commit or rollback.
 */
export const lockOrganizationVocabulary = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await withAggregateLock({
    aggregate: "dictationVocabularyCapacity",
    id: { organizationId },
    tx,
  });
};

/** How many words the organization's list holds. */
export const countOrganizationTerms = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<number> => {
  const [row] = await tx
    .select({ words: count() })
    .from(dictationVocabularyTerms)
    .where(eq(dictationVocabularyTerms.organizationId, organizationId));
  return row?.words ?? 0;
};

/** The keys among `keys` the organization's list already holds. */
export const listedTermKeys = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  keys: readonly string[],
): Promise<Set<string>> =>
  new Set(
    (
      await tx
        .select({ key: dictationVocabularyTerms.termKey })
        .from(dictationVocabularyTerms)
        .where(
          and(
            eq(dictationVocabularyTerms.organizationId, organizationId),
            inArray(dictationVocabularyTerms.termKey, [...keys]),
          ),
        )
    ).map(({ key }) => key),
  );
