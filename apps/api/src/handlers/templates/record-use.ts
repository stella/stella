import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { templates } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

type RecordTemplateUseOptions = {
  tx: Transaction;
  templateId: SafeId<"template">;
};

/**
 * Bump a template's usage stats (`useCount`, `lastUsedAt`) after a
 * successful fill. Call inside the fill transaction so the bump is
 * atomic with the fill itself; org scoping comes from the caller's
 * RLS-scoped transaction. Best-effort metadata: callers should not
 * fail the fill if this update touches zero rows.
 */
export const recordTemplateUse = async ({
  tx,
  templateId,
}: RecordTemplateUseOptions): Promise<void> => {
  // audit: skip — usage-counter bookkeeping (useCount/lastUsedAt); the fill
  // operation that triggers this bump is audited by the calling handler.
  await tx
    .update(templates)
    .set({
      useCount: sql`${templates.useCount} + 1`,
      lastUsedAt: new Date(),
    })
    .where(eq(templates.id, templateId));
};
