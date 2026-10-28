import { Result, TaggedError } from "better-result";
import { inArray } from "drizzle-orm";

import type { UiLocale } from "@stll/locales";

import { caseLawWithdrawalStatus } from "@/api/db/schema";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

import {
  decisionReferencesIn,
  WithdrawnCopyProjection,
} from "./withdrawn-copy-projection";
import labels from "./withdrawn-decision-labels.gen.json";

labels satisfies Record<UiLocale, string>;

export class CaseLawWithdrawalReadError extends TaggedError(
  "CaseLawWithdrawalReadError",
)<{ message: string; cause: unknown }> {}

type ReadWithdrawnCopiesOptions = {
  values: unknown;
  decisionIds?: readonly string[];
  locale?: UiLocale;
  caseLawDb?: CaseLawPublicReadDb;
};

/** One bounded lookup, independent of tenant storage and publication filters. */
export const readWithdrawnCopies = async ({
  values,
  decisionIds = [],
  locale = "en",
  caseLawDb = caseLawPublicReadDb,
}: ReadWithdrawnCopiesOptions) => {
  const references = decisionReferencesIn(values);
  for (const id of decisionIds) {
    references.add(id.toLowerCase());
  }
  const ids = [...references].map(brandPersistedCaseLawDecisionId);
  if (ids.length === 0) {
    return Result.ok(new WithdrawnCopyProjection([], labels[locale]));
  }
  return await Result.tryPromise({
    try: async () => {
      const rows = await caseLawDb((tx) =>
        tx
          .select({ decisionId: caseLawWithdrawalStatus.decisionId })
          .from(caseLawWithdrawalStatus)
          .where(inArray(caseLawWithdrawalStatus.decisionId, ids))
          .limit(ids.length),
      );
      return new WithdrawnCopyProjection(
        rows.map(({ decisionId }) => decisionId),
        labels[locale],
      );
    },
    catch: (cause) =>
      new CaseLawWithdrawalReadError({
        message: "Reading decision withdrawal status failed",
        cause,
      }),
  });
};
