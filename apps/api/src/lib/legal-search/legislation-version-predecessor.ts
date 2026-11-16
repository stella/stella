import { and, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { legislationDocuments } from "@/api/db/schema";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";

import {
  eligibleExpression,
  isDated,
  legislationVersionRef,
  precedesInHistory,
} from "./legislation-validity-window";

/** The predecessor and its revision are read in the same statement as the target. */
export const legislationVersionPredecessorQuery = (
  tx: LegislationReadTransaction,
) => {
  const previous = alias(legislationDocuments, "summary_previous");
  return tx
    .select({ id: previous.id, payloadRevision: previous.payloadRevision })
    .from(previous)
    .where(
      and(
        isDated(legislationVersionRef(legislationDocuments)),
        eligibleExpression(legislationVersionRef(legislationDocuments)),
        eq(previous.sourceId, legislationDocuments.sourceId),
        eq(previous.eli, legislationDocuments.eli),
        eq(previous.language, legislationDocuments.language),
        isDated(legislationVersionRef(previous)),
        eligibleExpression(legislationVersionRef(previous)),
        precedesInHistory(
          { ref: legislationVersionRef(previous), id: previous.id },
          {
            ref: legislationVersionRef(legislationDocuments),
            id: legislationDocuments.id,
          },
        ),
      ),
    )
    .orderBy(desc(previous.versionValidFrom), desc(previous.id))
    .limit(1);
};
