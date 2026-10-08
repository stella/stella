import { panic, Result } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { InferSelectModel } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  parsePlainDate,
  parseTimeZoneId,
  Temporal,
  todayFor,
} from "@stll/time";
import type { TimeZoneId } from "@stll/time";

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
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import type { MANAGED_AI_RESIDENCIES } from "@/api/lib/chat/ai-data-policy";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";
import {
  effectiveOrganizationTimeZone,
  organizationTimeZoneColumns,
  TIME_ZONE_ID_MAX_LENGTH,
} from "@/api/lib/organization-time-zone";

import { resolveMemoryExtractionEnabledAt } from "./memory-extraction-consent";

const documentProcessingModeSchema = t.Union([
  t.Literal(DOCUMENT_PROCESSING_MODE.OFF),
  t.Literal(DOCUMENT_PROCESSING_MODE.SEARCHABLE_TEXT),
]);

// The literal list mirrors MANAGED_AI_RESIDENCIES: a member on one side only
// fails to compile here.
const managedAIResidencySchema = t.Union([t.Literal("eu"), t.Literal("us")]);
type ManagedAIResidencyValue = (typeof MANAGED_AI_RESIDENCIES)[number];
type ManagedAIResidencySchemaValue = Static<typeof managedAIResidencySchema>;
type MissingManagedAIResidencySchemaValue = Exclude<
  ManagedAIResidencyValue,
  ManagedAIResidencySchemaValue
>;
type UnexpectedManagedAIResidencySchemaValue = Exclude<
  ManagedAIResidencySchemaValue,
  ManagedAIResidencyValue
>;

true satisfies MissingManagedAIResidencySchemaValue extends never
  ? true
  : never;
true satisfies UnexpectedManagedAIResidencySchemaValue extends never
  ? true
  : never;

const updateOrganizationSettingsBodySchema = t.Object({
  documentProcessingMode: t.Optional(documentProcessingModeSchema),
  matterNumberPattern: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  matterNumberPadding: t.Optional(t.Integer({ minimum: 1, maximum: 6 })),
  promptCachingEnabled: t.Optional(t.Boolean()),
  managedAIResidency: t.Optional(managedAIResidencySchema),
  memoryExtractionEnabled: t.Optional(t.Boolean()),
  timeMinimumUnitMinutes: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
  timeEditWindowDays: t.Optional(t.Integer({ minimum: 0 })),
  timeLockedThroughMonth: t.Optional(t.Nullable(t.String({ format: "date" }))),
  timeNarrativeRequired: t.Optional(t.Boolean()),
  timeZone: t.Optional(
    t.Nullable(
      t.String({
        minLength: 1,
        maxLength: TIME_ZONE_ID_MAX_LENGTH,
        description:
          "IANA time zone whose calendar decides the organization's day " +
          "(e.g. Europe/Prague), or null to derive it from the primary " +
          "practice jurisdiction again",
      }),
    ),
  ),
});

const config = {
  description:
    "Change the organization's general settings: document processing mode, " +
    "matter-number pattern and padding, prompt caching, memory " +
    "extraction, time policy, and time zone. Only the fields you pass are written and the matter-number " +
    "pattern is validated against its padding first. Turning document " +
    "processing off is refused while an automatic run is still going. " +
    "Practice jurisdictions are set through " +
    "organization-settings.practice-jurisdictions.update.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "covered", by: "manage_organization" },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

export type UpdateOrganizationSettingsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateOrganizationSettingsBodySchema>;
  /** The instant the lock-month check reads the organization's day at. */
  now?: Temporal.Instant;
};

type UpdateBody = UpdateOrganizationSettingsProps["body"];
type NormalizedUpdateBody = Omit<UpdateBody, "timeZone"> & {
  timeZone?: TimeZoneId | null;
};
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
    | "timeZone"
    | "practiceJurisdictions"
  >;

const timeZoneAuditChanges = (
  body: NormalizedUpdateBody,
  existing: Pick<ExistingGeneralSettings, "timeZone"> | undefined,
) =>
  body.timeZone !== undefined && body.timeZone !== (existing?.timeZone ?? null)
    ? { timeZone: { old: existing?.timeZone ?? null, new: body.timeZone } }
    : {};

const organizationSettingsAuditChanges = (
  body: NormalizedUpdateBody,
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
  ...timeZoneAuditChanges(body, existing),
});

/**
 * The body with its zone in the tz database's spelling, which is what gets
 * stored, audited and echoed; `null` when the zone is not one the runtime
 * knows.
 */
const normalizeTimeZone = ({
  timeZone,
  ...otherSettings
}: UpdateBody): NormalizedUpdateBody | null => {
  if (timeZone === undefined || timeZone === null) {
    return timeZone === null
      ? { ...otherSettings, timeZone: null }
      : otherSettings;
  }
  const parsed = parseTimeZoneId(timeZone);
  return parsed === null ? null : { ...otherSettings, timeZone: parsed };
};

const invalidLockedMonth = () =>
  Result.err(
    new HandlerError({
      status: 400,
      code: "invalid_time_locked_month",
      message:
        "timeLockedThroughMonth must be the last day of a month that has " +
        "ended in the organization's time zone",
    }),
  );

/**
 * The zone a lock month is judged in: the zone this request sets, else the
 * stored one, else the jurisdiction default. A request that changes both is
 * judged in its new zone, the one the lock will be read in afterwards.
 */
const lockMonthZone = (
  requested: TimeZoneId | null | undefined,
  existing:
    | Pick<ExistingGeneralSettings, "timeZone" | "practiceJurisdictions">
    | undefined,
): TimeZoneId =>
  effectiveOrganizationTimeZone({
    timeZone:
      requested === undefined ? (existing?.timeZone ?? null) : requested,
    practiceJurisdictions: arrayOrEmpty(existing?.practiceJurisdictions),
  });

type IsClosedMonthOptions = {
  lockedThrough: Temporal.PlainDate;
  zone: TimeZoneId;
  now: Temporal.Instant;
};

/** A month is closed once its last day is before the organization's today. */
const isClosedMonth = ({
  lockedThrough,
  zone,
  now,
}: IsClosedMonthOptions): boolean =>
  Temporal.PlainDate.compare(lockedThrough, todayFor(zone, now)) < 0;

// Shared org-settings update logic reused by the HTTP handler and the
// `manage_organization` MCP tool, so both emit the identical audit event and
// enforce the matter-pattern/padding pairing and pattern validation. Only the
// non-secret settings live here; provider-secret writes are separate,
// dashboard-only endpoints (mcp: internal).
export const updateOrganizationSettingsHandler = async function* ({
  safeDb,
  organizationId,
  recordAuditEvent,
  body: requestBody,
  now = Temporal.Now.instant(),
}: UpdateOrganizationSettingsProps) {
  const body = normalizeTimeZone(requestBody);
  if (body === null) {
    return Result.err(
      new HandlerError({
        status: 400,
        code: "invalid_time_zone",
        message:
          "timeZone must be an IANA time zone such as Europe/Prague or " +
          "America/New_York; fixed offsets like +01:00 are not accepted",
      }),
    );
  }
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

  const lockedThrough = body.timeLockedThroughMonth
    ? parsePlainDate(body.timeLockedThroughMonth)
    : null;
  if (
    body.timeLockedThroughMonth &&
    (lockedThrough === null || lockedThrough.day !== lockedThrough.daysInMonth)
  ) {
    return invalidLockedMonth();
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
      const wantsTimeZoneUpdate = body.timeZone !== undefined;
      const needsSerializedSettingsRead =
        wantsManagedAIResidencyUpdate ||
        wantsPromptCachingUpdate ||
        wantsDocumentProcessingUpdate ||
        wantsMemoryExtractionUpdate ||
        wantsTimePolicyUpdate ||
        wantsTimeZoneUpdate;

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
              ...organizationTimeZoneColumns,
            })
            .from(organizationSettings)
            .where(eq(organizationSettings.organizationId, organizationId))
            .limit(1)
            .for("update")
        : [];
      const existing = existingRows.at(0);
      if (
        lockedThrough !== null &&
        !isClosedMonth({
          lockedThrough,
          zone: lockMonthZone(body.timeZone, existing),
          now,
        })
      ) {
        return { type: "invalid_locked_month" } as const;
      }
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
          ...(wantsTimeZoneUpdate ? { timeZone: body.timeZone } : {}),
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
            timeMinimumUnitMinutes: timePolicyUpdate.timeMinimumUnitMinutes,
            timeEditWindowDays: timePolicyUpdate.timeEditWindowDays,
            timeLockedThroughMonth: timePolicyUpdate.timeLockedThroughMonth,
            timeNarrativeRequired: timePolicyUpdate.timeNarrativeRequired,
            ...(wantsTimeZoneUpdate ? { timeZone: body.timeZone } : {}),
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

  switch (updateOutcome.type) {
    case "automatic_ocr_running":
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "Wait for document processing to finish before disabling OCR",
        }),
      );
    case "invalid_locked_month":
      return invalidLockedMonth();
    case "updated":
      break;
    default:
      updateOutcome satisfies never;
      return panic("Unhandled organization settings update outcome");
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
    ...(body.timeZone !== undefined ? { timeZone: body.timeZone } : {}),
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
