import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { templateFills, templates } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
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

type RecordTemplateFillOptions = {
  tx: Transaction;
  templateId: SafeId<"template">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** Output the caller produced (`docx`, `pdf`, `text`). */
  format: string;
  unmatchedCount: number;
  unusedCount: number;
  /** Records the `EXECUTE` audit event when present (chat tools may run without
   *  one); the fill row is always written. */
  recordAuditEvent?: AuditRecorder | undefined;
};

/**
 * Persist a template fill the way the REST fill routes do: a `template_fills`
 * row plus an `EXECUTE` audit event. The shared fill service records template
 * *use* (the counter) but, by design, leaves the fill row + audit to the
 * calling handler, so the chat and MCP `fill_template` tools call this to keep
 * agent-driven executions in the audit trail. Run inside the caller's
 * RLS-scoped transaction.
 */
export const recordTemplateFill = async ({
  tx,
  templateId,
  organizationId,
  userId,
  format,
  unmatchedCount,
  unusedCount,
  recordAuditEvent,
}: RecordTemplateFillOptions): Promise<void> => {
  const status = unmatchedCount > 0 ? "partial" : "success";
  await tx.insert(templateFills).values({
    organizationId,
    templateId,
    userId,
    format,
    status,
    unmatchedCount,
    unusedCount,
  });
  await recordAuditEvent?.(tx, {
    action: AUDIT_ACTION.EXECUTE,
    resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
    resourceId: templateId,
    workspaceId: null,
    metadata: { format, status, unmatchedCount },
  });
};
