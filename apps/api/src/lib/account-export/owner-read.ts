import { asc, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID,
  SETTING_ACCOUNT_EXPORT_USER_ID,
} from "@/api/db/rls";
import type { rootDb } from "@/api/db/root";
import { legalReaderAnnotations } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

type ReadAccountExportAnnotationPageOptions = {
  database: Pick<typeof rootDb, "transaction">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  where: SQL | undefined;
  limit: number;
};

/** Private notes use the export owner policy; claim rows also have cleanup
 * owner access, so the caller retains its organization and author predicates. */
export const readAccountExportAnnotationPage = async ({
  database,
  organizationId,
  userId,
  where,
  limit,
}: ReadAccountExportAnnotationPageOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    await tx.execute(sql`SELECT
      set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID)}', ${organizationId}, true),
      set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_USER_ID)}', ${userId}, true)`);
    return await tx
      .select()
      .from(legalReaderAnnotations)
      .where(where)
      .orderBy(asc(legalReaderAnnotations.id))
      .limit(limit);
  });
