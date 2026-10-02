import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { caseLawDecisionAliases } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

/** One-hop canonical identity, shared by UUID reads and publisher replay. */
export const canonicalDecisionIdSql = (
  id: SafeId<"caseLawDecision"> | Column,
): SQL<SafeId<"caseLawDecision">> =>
  sql`coalesce((SELECT ${caseLawDecisionAliases.canonicalDecisionId}
    FROM ${caseLawDecisionAliases}
    WHERE ${caseLawDecisionAliases.retiredDecisionId} = ${id}), ${id})`;
