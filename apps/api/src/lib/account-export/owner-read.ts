import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID,
  SETTING_ACCOUNT_EXPORT_USER_ID,
} from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { legalReaderAnnotations } from "@/api/db/schema";
import type { AnyDrizzle } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";

/** The read needs only these two capabilities, so every Postgres driver's
 * transaction (production and test databases alike) satisfies it. */
export type AccountExportReadTransaction = Pick<Transaction, "select"> & {
  execute: (query: SQLWrapper | string) => PromiseLike<unknown>;
};

type ReadAccountExportAnnotationPageOptions = {
  database: AnyDrizzle<AccountExportReadTransaction>;
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
      set_config(${SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID}, ${organizationId}, true),
      set_config(${SETTING_ACCOUNT_EXPORT_USER_ID}, ${userId}, true)`);
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
