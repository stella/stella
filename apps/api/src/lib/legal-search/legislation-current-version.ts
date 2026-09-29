import { sql } from "drizzle-orm";

import { legislationDocuments } from "@/api/db/schema";
import {
  isVersionOfWorkAt,
  legislationVersionRow,
} from "@/api/lib/legal-search/legislation-validity-window";

/**
 * The version each Work's present-day reads show, over `legislation_documents`
 * itself. The listing, the shelf and search's one-hit-per-act collapse all
 * read this one definition, so they cannot disagree about which version of an
 * act is the current one.
 */
export const isCurrentVersionOfWork = isVersionOfWorkAt(
  legislationVersionRow(legislationDocuments),
  sql`CURRENT_DATE`,
);
