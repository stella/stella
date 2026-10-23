import { and, asc, eq, sql } from "drizzle-orm";
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
  extraWhere: SQL | undefined;
  limit: number;
};

/** Every export read binds the organization and author independently of
 * the caller's extra filters, alongside the export owner policy. */
export const readAccountExportAnnotationPage = async ({
  database,
  organizationId,
  userId,
  extraWhere,
  limit,
}: ReadAccountExportAnnotationPageOptions) =>
  await withAggregateTransaction(database, async (tx) => {
    await tx.execute(sql`SELECT
      set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID)}', ${organizationId}, true),
      set_config('${sql.raw(SETTING_ACCOUNT_EXPORT_USER_ID)}', ${userId}, true)`);
    return await tx
      .select()
      .from(legalReaderAnnotations)
      .where(
        and(
          eq(legalReaderAnnotations.organizationId, organizationId),
          eq(legalReaderAnnotations.userId, userId),
          extraWhere,
        ),
      )
      .orderBy(asc(legalReaderAnnotations.id))
      .limit(limit);
  });
