import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import {
  DOCUMENT_PROCESSING_MODE,
  DEFAULT_DOCUMENT_PROCESSING_MODE,
  documentProcessingRuns,
  organizationSettings,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";

const documentProcessingModeSchema = t.Union([
  t.Literal(DOCUMENT_PROCESSING_MODE.OFF),
  t.Literal(DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT),
]);

const updateOrganizationSettingsBodySchema = t.Object({
  documentProcessingMode: t.Optional(documentProcessingModeSchema),
  matterNumberPattern: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  matterNumberPadding: t.Optional(t.Integer({ minimum: 1, maximum: 6 })),
  promptCachingEnabled: t.Optional(t.Boolean()),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "covered", by: "manage_organization" },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

export type UpdateOrganizationSettingsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateOrganizationSettingsBodySchema>;
};

// Shared org-settings update logic reused by the HTTP handler and the
// `manage_organization` MCP tool, so both emit the identical audit event and
// enforce the matter-pattern/padding pairing and pattern validation. Only the
// non-secret settings live here; provider-secret writes are separate,
// dashboard-only endpoints (mcp: internal).
export const updateOrganizationSettingsHandler = async function* ({
  safeDb,
  organizationId,
  recordAuditEvent,
  body,
}: UpdateOrganizationSettingsProps) {
  const matterPattern = body.matterNumberPattern;
  const matterPadding = body.matterNumberPadding;
  const wantsMatterUpdate =
    matterPattern !== undefined || matterPadding !== undefined;

  if (
    wantsMatterUpdate &&
    (matterPattern === undefined || matterPadding === undefined)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "matterNumberPattern and matterNumberPadding must be sent together",
      }),
    );
  }

  if (matterPattern !== undefined && matterPadding !== undefined) {
    const validation = validatePattern(matterPattern, matterPadding);

    if (Result.isError(validation)) {
      return Result.err(
        new HandlerError({ status: 400, message: validation.error.message }),
      );
    }
  }

  const updateOutcome = yield* Result.await(
    safeDb(async (tx) => {
      // Only touch promptCachingEnabled when the body carries it;
      // omitting optional settings from the upsert set keeps a concurrent
      // toggle request from being clobbered by a stale read.
      const wantsPromptCachingUpdate = body.promptCachingEnabled !== undefined;
      const wantsDocumentProcessingUpdate =
        body.documentProcessingMode !== undefined;
      const needsSerializedSettingsRead =
        wantsPromptCachingUpdate || wantsDocumentProcessingUpdate;
      if (needsSerializedSettingsRead) {
        // Ensure there is a row to lock. Concurrent first-time updates block
        // on the unique organization key here, then read the committed
        // predecessor below; an absent optional settings row cannot bypass
        // audit serialization.
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
          })
          .onConflictDoNothing({
            target: organizationSettings.organizationId,
          });
      }
      const existingRows = needsSerializedSettingsRead
        ? await tx
            .select({
              documentProcessingMode:
                organizationSettings.documentProcessingMode,
              promptCachingEnabled: organizationSettings.promptCachingEnabled,
            })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .limit(1)
            .for("update")
        : [];
      const existing = existingRows.at(0);

      if (body.documentProcessingMode === DOCUMENT_PROCESSING_MODE.OFF) {
        const runningAutomaticOcrRuns = await tx
          .select({ id: documentProcessingRuns.id })
          .from(documentProcessingRuns)
          .where(
            and(
              eq(documentProcessingRuns.organizationId, organizationId),
              eq(documentProcessingRuns.status, "running"),
              inArray(documentProcessingRuns.requestSource, [
                "upload",
                "repair",
              ]),
            ),
          )
          .limit(1);
        if (runningAutomaticOcrRuns.at(0)) {
          return { type: "automatic_ocr_running" } as const;
        }
      }

      // Insert path needs schema defaults for any required column
      // the body did not carry. Matter columns are NOT NULL with
      // schema defaults — Drizzle infers them when omitted.
      await tx
        .insert(organizationSettings)
        .values({
          id: createSafeId<"organizationSettings">(),
          organizationId,
          ...(wantsMatterUpdate
            ? {
                matterNumberPattern: body.matterNumberPattern,
                matterNumberPadding: body.matterNumberPadding,
              }
            : {}),
          ...(wantsPromptCachingUpdate
            ? { promptCachingEnabled: body.promptCachingEnabled }
            : {}),
          ...(wantsDocumentProcessingUpdate
            ? { documentProcessingMode: body.documentProcessingMode }
            : {}),
        })
        .onConflictDoUpdate({
          target: organizationSettings.organizationId,
          set: {
            ...(wantsMatterUpdate
              ? {
                  matterNumberPattern: body.matterNumberPattern,
                  matterNumberPadding: body.matterNumberPadding,
                }
              : {}),
            ...(wantsPromptCachingUpdate
              ? { promptCachingEnabled: body.promptCachingEnabled }
              : {}),
            ...(wantsDocumentProcessingUpdate
              ? { documentProcessingMode: body.documentProcessingMode }
              : {}),
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: organizationId,
        changes: {
          ...(wantsMatterUpdate
            ? {
                matterNumberPattern: {
                  old: null,
                  new: body.matterNumberPattern,
                },
                matterNumberPadding: {
                  old: null,
                  new: body.matterNumberPadding,
                },
              }
            : {}),
          ...(wantsPromptCachingUpdate &&
          body.promptCachingEnabled !== (existing?.promptCachingEnabled ?? true)
            ? {
                promptCachingEnabled: {
                  old: existing?.promptCachingEnabled ?? true,
                  new: body.promptCachingEnabled,
                },
              }
            : {}),
          ...(wantsDocumentProcessingUpdate &&
          body.documentProcessingMode !==
            (existing?.documentProcessingMode ??
              DEFAULT_DOCUMENT_PROCESSING_MODE)
            ? {
                documentProcessingMode: {
                  old:
                    existing?.documentProcessingMode ??
                    DEFAULT_DOCUMENT_PROCESSING_MODE,
                  new: body.documentProcessingMode,
                },
              }
            : {}),
        },
      });
      return { type: "updated" } as const;
    }),
  );

  if (updateOutcome.type === "automatic_ocr_running") {
    return Result.err(
      new HandlerError({
        status: 409,
        message: "Wait for document processing to finish before disabling OCR",
      }),
    );
  }

  return Result.ok({
    ...(body.matterNumberPattern !== undefined
      ? { matterNumberPattern: body.matterNumberPattern }
      : {}),
    ...(body.matterNumberPadding !== undefined
      ? { matterNumberPadding: body.matterNumberPadding }
      : {}),
    ...(body.promptCachingEnabled !== undefined
      ? { promptCachingEnabled: body.promptCachingEnabled }
      : {}),
    ...(body.documentProcessingMode !== undefined
      ? { documentProcessingMode: body.documentProcessingMode }
      : {}),
  });
};

const updateOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    return yield* updateOrganizationSettingsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateOrganizationSettings;
