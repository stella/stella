import { sql } from "drizzle-orm";

import { db } from "@/api/db";
import { clauses } from "@/api/db/schema";
import type { ClauseBody } from "./types";

/**
 * Concatenate all paragraph `text` fields from a clause body
 * into a single string for search indexing.
 */
const bodyToPlainText = (body: ClauseBody): string =>
  body
    .filter((p) => !p.isDirective)
    .map((p) => p.text)
    .join(" ");

/**
 * Recompute and persist the tsvector search column for a
 * single clause. Called after create and update.
 */
export const updateSearchVector = async (
  clauseId: string,
  title: string,
  description: string | null | undefined,
  body: ClauseBody,
) => {
  const bodyText = bodyToPlainText(body);

  await db
    .update(clauses)
    .set({
      searchVector: sql`to_tsvector(
        'english',
        ${title} || ' ' ||
        coalesce(${description ?? null}, '') || ' ' ||
        ${bodyText}
      )`,
    })
    .where(sql`${clauses.id} = ${clauseId}`);
};
