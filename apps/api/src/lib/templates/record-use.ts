import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { templateFills, templates } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { templateFillStatus } from "@/api/lib/templates/template-fill-completion";
import type { FillDiagnostics } from "@/api/lib/templates/template-fill-completion";

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

/** The audit action a recorded fill is logged under: `EXECUTE` for a fill
 *  that produces a document or text, `DOWNLOAD` for a stored template filled
 *  straight into a download. */
type TemplateFillAuditAction =
  | typeof AUDIT_ACTION.EXECUTE
  | typeof AUDIT_ACTION.DOWNLOAD;

type RecordedFill = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** Output the caller produced (`docx`, `pdf`, `text`). */
  format: string;
  /** The fill's diagnostics: the recorded status is their completion
   *  decision, and the recorded counts are read from them. */
  diagnostics: FillDiagnostics;
};

type StoredTemplateFill = RecordedFill & {
  templateId: SafeId<"template">;
  workspaceId?: SafeId<"workspace"> | undefined;
  entityId?: SafeId<"entity"> | undefined;
  entityVersionId?: SafeId<"entityVersion"> | undefined;
  /** Records the audit event when present (chat tools may run without one);
   *  the fill row is always written. */
  recordAuditEvent?: AuditRecorder | undefined;
  /** Defaults to `EXECUTE`. */
  auditAction?: TemplateFillAuditAction | undefined;
};

/** A template uploaded with the request and never stored: the row is an
 *  analytics count without a template, and there is no template resource to
 *  audit against. */
type UploadedTemplateFill = RecordedFill & {
  templateId: null;
  workspaceId?: never;
  entityId?: never;
  entityVersionId?: never;
  recordAuditEvent?: never;
  auditAction?: never;
};

type RecordTemplateFillOptions = StoredTemplateFill | UploadedTemplateFill;

/**
 * Persist a template fill: a `template_fills` row plus, for a stored
 * template, its audit event (`EXECUTE` unless the caller downloads). The
 * shared fill service records template *use* (the counter) but leaves the
 * fill row + audit to the caller; every fill surface (REST fills and
 * downloads, chat and MCP `fill_template`) records through here, so the row
 * status and the audit metadata are the same for all of them. Run inside the
 * caller's RLS-scoped transaction.
 */
export const recordTemplateFill = async (
  options: RecordTemplateFillOptions,
): Promise<void> => {
  const { tx, organizationId, userId, format, diagnostics } = options;
  const status = templateFillStatus(diagnostics);
  const unmatchedCount = diagnostics.unmatchedPlaceholders.length;
  await tx.insert(templateFills).values({
    organizationId,
    ...(options.templateId !== null && { templateId: options.templateId }),
    userId,
    format,
    status,
    unmatchedCount,
    unusedCount: diagnostics.unusedValues.length,
    structureErrors:
      diagnostics.structureErrors.length > 0
        ? [...diagnostics.structureErrors]
        : null,
  });
  if (options.templateId === null) {
    // An uploaded template is not a stored resource: the row is an
    // analytics count only.
    return;
  }
  const { templateId, workspaceId, entityId, entityVersionId } = options;
  await options.recordAuditEvent?.(tx, {
    action: options.auditAction ?? AUDIT_ACTION.EXECUTE,
    resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
    resourceId: templateId,
    workspaceId: workspaceId ?? null,
    metadata: {
      format,
      status,
      unmatchedCount,
      aiFieldErrorCount: diagnostics.aiFieldErrors.length,
      undecidedConditionCount: diagnostics.undecidedConditions.length,
      ...(entityId !== undefined && { entityId }),
      ...(entityVersionId !== undefined && { entityVersionId }),
    },
  });
};

type TemplateExecutionRecorders = {
  recordTemplateUse: typeof recordTemplateUse;
  recordTemplateFill: typeof recordTemplateFill;
};

const defaultTemplateExecutionRecorders = {
  recordTemplateUse,
  recordTemplateFill,
} satisfies TemplateExecutionRecorders;

type RecordTemplateExecutionOptions = Omit<StoredTemplateFill, "tx"> & {
  scopedDb: ScopedDb;
  recorders?: TemplateExecutionRecorders | undefined;
};

/**
 * Record a transient fill (one returned as text, not persisted) in one
 * transaction: the use-count bump, the fill row and the `EXECUTE` audit event.
 * The chat and MCP `fill_template` tools fill with `useRecording: "caller"` and
 * return the rendered text only once this commits, so an agent never receives
 * a fill the audit trail lacks; on failure nothing is written and the caller
 * returns an error instead of the text.
 */
export const recordTemplateExecution = async ({
  scopedDb,
  recorders = defaultTemplateExecutionRecorders,
  ...fill
}: RecordTemplateExecutionOptions) =>
  await Result.tryPromise(
    async () =>
      await scopedDb(async (tx) => {
        await recorders.recordTemplateUse({ tx, templateId: fill.templateId });
        await recorders.recordTemplateFill({ tx, ...fill });
      }),
  );
