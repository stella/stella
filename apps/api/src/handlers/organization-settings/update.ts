import { Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { parsePlainDate, Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  DOCUMENT_PROCESSING_MODE,
  DEFAULT_DOCUMENT_PROCESSING_MODE,
  DEFAULT_TIME_EDIT_WINDOW_DAYS,
  DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  DEFAULT_TIME_NARRATIVE_REQUIRED,
  documentProcessingRuns,
  organizationSettings,
} from "@/api/db/schema";
import {
  DEFAULT_MANAGED_AI_RESIDENCY,
  MANAGED_AI_RESIDENCIES,
} from "@/api/lib/ai-data-policy";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";

import { resolveMemoryExtractionEnabledAt } from "./memory-extraction-consent";

const documentProcessingModeSchema = t.Union([
  t.Literal(DOCUMENT_PROCESSING_MODE.OFF),
  t.Literal(DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT),
]);

const updateOrganizationSettingsBodySchema = t.Object({
  documentProcessingMode: t.Optional(documentProcessingModeSchema),
  matterNumberPattern: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  matterNumberPadding: t.Optional(t.Integer({ minimum: 1, maximum: 6 })),
  promptCachingEnabled: t.Optional(t.Boolean()),
  managedAIResidency: t.Optional(
    t.Union(MANAGED_AI_RESIDENCIES.map((region) => t.Literal(region))),
  ),
  memoryExtractionEnabled: t.Optional(t.Boolean()),
  timeMinimumUnitMinutes: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
  timeEditWindowDays: t.Optional(t.Integer({ minimum: 0 })),
  timeLockedThroughMonth: t.Optional(t.Nullable(t.String({ format: "date" }))),
  timeNarrativeRequired: t.Optional(t.Boolean()),
});

const config = {
  description:
    "Change the organization's general settings: document processing mode, " +
    "matter-number pattern and padding, prompt caching, memory " +
    "extraction, and time policy. Only the fields you pass are written and the matter-number " +
    "pattern is validated against its padding first. Turning document " +
    "processing off is refused while an automatic run is still going. " +
    "Practice jurisdictions are set through " +
    "organization-settings.practice-jurisdictions.update.",
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

type UpdateBody = UpdateOrganizationSettingsProps["body"];
type ExistingTimePolicy = Pick<
  InferSelectModel<typeof organizationSettings>,
  | "timeMinimumUnitMinutes"
  | "timeEditWindowDays"
  | "timeLockedThroughMonth"
  | "timeNarrativeRequired"
>;

const timePolicyValues = (body: UpdateBody) => ({
  ...(body.timeMinimumUnitMinutes !== undefined
    ? { timeMinimumUnitMinutes: body.timeMinimumUnitMinutes }
    : {}),
  ...(body.timeEditWindowDays !== undefined
    ? { timeEditWindowDays: body.timeEditWindowDays }
    : {}),
  ...(body.timeLockedThroughMonth !== undefined
    ? { timeLockedThroughMonth: body.timeLockedThroughMonth }
    : {}),
  ...(body.timeNarrativeRequired !== undefined
    ? { timeNarrativeRequired: body.timeNarrativeRequired }
    : {}),
});

const timePolicyAuditChanges = (
  body: UpdateBody,
  existing: ExistingTimePolicy | undefined,
) => ({
  ...(body.timeMinimumUnitMinutes !== undefined &&
  body.timeMinimumUnitMinutes !==
    (existing?.timeMinimumUnitMinutes ?? DEFAULT_TIME_MINIMUM_UNIT_MINUTES)
    ? {
        timeMinimumUnitMinutes: {
          old:
            existing?.timeMinimumUnitMinutes ??
            DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
          new: body.timeMinimumUnitMinutes,
        },
      }
    : {}),
  ...(body.timeEditWindowDays !== undefined &&
  body.timeEditWindowDays !==
    (existing?.timeEditWindowDays ?? DEFAULT_TIME_EDIT_WINDOW_DAYS)
    ? {
        timeEditWindowDays: {
          old: existing?.timeEditWindowDays ?? DEFAULT_TIME_EDIT_WINDOW_DAYS,
          new: body.timeEditWindowDays,
        },
      }
    : {}),
  ...(body.timeLockedThroughMonth !== undefined &&
  body.timeLockedThroughMonth !== (existing?.timeLockedThroughMonth ?? null)
    ? {
        timeLockedThroughMonth: {
          old: existing?.timeLockedThroughMonth ?? null,
          new: body.timeLockedThroughMonth,
        },
      }
    : {}),
  ...(body.timeNarrativeRequired !== undefined &&
  body.timeNarrativeRequired !==
    (existing?.timeNarrativeRequired ?? DEFAULT_TIME_NARRATIVE_REQUIRED)
    ? {
        timeNarrativeRequired: {
          old:
            existing?.timeNarrativeRequired ?? DEFAULT_TIME_NARRATIVE_REQUIRED,
          new: body.timeNarrativeRequired,
        },
      }
    : {}),
});

type ExistingGeneralSettings = ExistingTimePolicy &
  Pick<
    InferSelectModel<typeof organizationSettings>,
    | "managedAIResidency"
    | "promptCachingEnabled"
    | "documentProcessingMode"
    | "memoryExtractionEnabled"
  >;

const organizationSettingsAuditChanges = (
  body: UpdateBody,
  existing: ExistingGeneralSettings | undefined,
) => ({
  ...(body.matterNumberPattern !== undefined ||
  body.matterNumberPadding !== undefined
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
  ...(body.managedAIResidency !== undefined &&
  body.managedAIResidency !==
    (existing?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY)
    ? {
        managedAIResidency: {
          old: existing?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY,
          new: body.managedAIResidency,
        },
      }
    : {}),
  ...(body.promptCachingEnabled !== undefined &&
  body.promptCachingEnabled !== (existing?.promptCachingEnabled ?? true)
    ? {
        promptCachingEnabled: {
          old: existing?.promptCachingEnabled ?? true,
          new: body.promptCachingEnabled,
        },
      }
    : {}),
  ...(body.documentProcessingMode !== undefined &&
  body.documentProcessingMode !==
    (existing?.documentProcessingMode ?? DEFAULT_DOCUMENT_PROCESSING_MODE)
    ? {
        documentProcessingMode: {
          old:
            existing?.documentProcessingMode ??
            DEFAULT_DOCUMENT_PROCESSING_MODE,
          new: body.documentProcessingMode,
        },
      }
    : {}),
  ...(body.memoryExtractionEnabled !== undefined &&
  body.memoryExtractionEnabled !== (existing?.memoryExtractionEnabled ?? false)
    ? {
        memoryExtractionEnabled: {
          old: existing?.memoryExtractionEnabled ?? false,
          new: body.memoryExtractionEnabled,
        },
      }
    : {}),
  ...timePolicyAuditChanges(body, existing),
});

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

  if (
    body.timeMinimumUnitMinutes !== undefined &&
    (body.timeMinimumUnitMinutes < 1 || 60 % body.timeMinimumUnitMinutes !== 0)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_time_minimum_unit",
        message: "timeMinimumUnitMinutes must be a positive divisor of 60",
      }),
    );
  }

  if (body.timeLockedThroughMonth) {
    const lockedThrough = parsePlainDate(body.timeLockedThroughMonth);
    if (
      lockedThrough === null ||
      lockedThrough.day !== lockedThrough.daysInMonth ||
      Temporal.PlainDate.compare(
        lockedThrough,
        Temporal.Now.plainDateISO("UTC"),
      ) >= 0
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_time_locked_month",
          message:
            "timeLockedThroughMonth must be the last day of a closed month",
        }),
      );
    }
  }

  const timePolicyUpdate = timePolicyValues(body);

  const updateOutcome = yield* Result.await(
    safeDb(async (tx) => {
      // Only touch optional settings when the body carries them; omission
      // keeps a concurrent toggle request from being clobbered by a stale read.
      const wantsManagedAIResidencyUpdate =
        body.managedAIResidency !== undefined;
      const wantsPromptCachingUpdate = body.promptCachingEnabled !== undefined;
      const wantsDocumentProcessingUpdate =
        body.documentProcessingMode !== undefined;
      const wantsMemoryExtractionUpdate =
        body.memoryExtractionEnabled !== undefined;
      const wantsTimePolicyUpdate = Object.keys(timePolicyUpdate).length > 0;
      const needsSerializedSettingsRead =
        wantsManagedAIResidencyUpdate ||
        wantsPromptCachingUpdate ||
        wantsDocumentProcessingUpdate ||
        wantsMemoryExtractionUpdate ||
        wantsTimePolicyUpdate;

      // Coordinate extraction consent changes with the background worker's
      // persistence transaction as well as concurrent settings requests.
      if (wantsMemoryExtractionUpdate) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
        );
      }

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
              memoryExtractionEnabled:
                organizationSettings.memoryExtractionEnabled,
              promptCachingEnabled: organizationSettings.promptCachingEnabled,
              managedAIResidency: organizationSettings.managedAIResidency,
              timeMinimumUnitMinutes:
                organizationSettings.timeMinimumUnitMinutes,
              timeEditWindowDays: organizationSettings.timeEditWindowDays,
              timeLockedThroughMonth:
                organizationSettings.timeLockedThroughMonth,
              timeNarrativeRequired: organizationSettings.timeNarrativeRequired,
            })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .limit(1)
            .for("update")
        : [];
      const existing = existingRows.at(0);
      const memoryExtractionEnabledAt =
        body.memoryExtractionEnabled === undefined
          ? undefined
          : resolveMemoryExtractionEnabledAt({
              currentEnabled: existing?.memoryExtractionEnabled ?? false,
              nextEnabled: body.memoryExtractionEnabled,
              now: new Date(),
            });

      if (body.documentProcessingMode === DOCUMENT_PROCESSING_MODE.OFF) {
        const runningAutomaticOcrRuns = await tx
          .select({ id: documentProcessingRuns.id })
          .from(documentProcessingRuns)
          .where(
            and(
              eq(documentProcessingRuns.organizationId, organizationId),
              eq(documentProcessingRuns.kind, "ocr"),
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
          ...(wantsManagedAIResidencyUpdate
            ? { managedAIResidency: body.managedAIResidency }
            : {}),
          ...(wantsPromptCachingUpdate
            ? { promptCachingEnabled: body.promptCachingEnabled }
            : {}),
          ...(wantsDocumentProcessingUpdate
            ? { documentProcessingMode: body.documentProcessingMode }
            : {}),
          ...(wantsMemoryExtractionUpdate
            ? {
                memoryExtractionEnabled: body.memoryExtractionEnabled,
                ...(memoryExtractionEnabledAt !== undefined
                  ? { memoryExtractionEnabledAt }
                  : {}),
              }
            : {}),
          ...timePolicyUpdate,
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
            ...(wantsManagedAIResidencyUpdate
              ? { managedAIResidency: body.managedAIResidency }
              : {}),
            ...(wantsPromptCachingUpdate
              ? { promptCachingEnabled: body.promptCachingEnabled }
              : {}),
            ...(wantsDocumentProcessingUpdate
              ? { documentProcessingMode: body.documentProcessingMode }
              : {}),
            ...(wantsMemoryExtractionUpdate
              ? {
                  memoryExtractionEnabled: body.memoryExtractionEnabled,
                  ...(memoryExtractionEnabledAt !== undefined
                    ? { memoryExtractionEnabledAt }
                    : {}),
                }
              : {}),
            ...timePolicyUpdate,
            updatedAt: new Date(),
          },
        });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
        resourceId: organizationId,
        changes: organizationSettingsAuditChanges(body, existing),
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
    ...(body.managedAIResidency !== undefined
      ? { managedAIResidency: body.managedAIResidency }
      : {}),
    ...(body.promptCachingEnabled !== undefined
      ? { promptCachingEnabled: body.promptCachingEnabled }
      : {}),
    ...(body.documentProcessingMode !== undefined
      ? { documentProcessingMode: body.documentProcessingMode }
      : {}),
    ...(body.memoryExtractionEnabled !== undefined
      ? { memoryExtractionEnabled: body.memoryExtractionEnabled }
      : {}),
    ...timePolicyUpdate,
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
