import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUPS } from "./billing";

export const DESKTOP_BILLING_DRAFT_LIMITS = {
  entries: 20,
  steerLength: 2000,
  narrativeLength: 4000,
  evidenceItems: 20,
  nameLength: 512,
  guidelines: 20,
  codeLength: 20,
} as const;

const identifierSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const matterIdSchema = v.pipe(v.string(), v.uuid());
const steeringTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.steerLength),
  v.regex(/^[\P{Cc}\n\t]*$/u),
);
const nameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.nameLength),
);
const narrativeSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.narrativeLength),
);
const durationSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(1440),
);

export const desktopBillingDraftEvidenceSchema = v.strictObject({
  documentNames: v.pipe(
    v.array(nameSchema),
    v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems),
  ),
  emailSubjects: v.pipe(
    v.array(nameSchema),
    v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.evidenceItems),
  ),
});

export const desktopBillingDraftEntrySchema = v.strictObject({
  matterId: matterIdSchema,
  date: v.pipe(v.string(), v.isoDate()),
  timezone: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  durationMinutes: durationSchema,
  appNames: v.pipe(v.array(nameSchema), v.maxLength(20)),
  evidence: v.optional(desktopBillingDraftEvidenceSchema),
});

export const desktopBillingDraftClassificationSchema = v.union([
  v.strictObject({
    type: v.literal("ledes"),
    taskCode: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.codeLength),
    ),
    activityCode: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.codeLength),
    ),
  }),
  v.strictObject({
    type: v.literal("activity_group"),
    activityGroup: v.picklist(TIME_ENTRY_ACTIVITY_GROUPS),
  }),
]);

export const desktopBillingDraftRuleRefSchema = v.strictObject({
  fileId: identifierSchema,
  fileName: nameSchema,
  section: nameSchema,
});

export const desktopBillingDraftFlagSchema = v.strictObject({
  text: narrativeSchema,
  ruleRef: desktopBillingDraftRuleRefSchema,
  fix: v.optional(v.literal("split")),
});

const splitPartSchema = v.strictObject({
  durationMinutes: durationSchema,
  narrative: narrativeSchema,
  classification: desktopBillingDraftClassificationSchema,
  billable: v.boolean(),
});

export const desktopBillingDraftOperationSchema = v.union([
  v.strictObject({ type: v.literal("rewrite"), narrative: narrativeSchema }),
  v.strictObject({
    type: v.literal("change_classification"),
    classification: desktopBillingDraftClassificationSchema,
  }),
  v.strictObject({ type: v.literal("set_billable"), billable: v.boolean() }),
  v.strictObject({
    type: v.literal("split"),
    parts: v.pipe(v.array(splitPartSchema), v.minLength(2), v.maxLength(20)),
  }),
  v.strictObject({
    type: v.literal("merge"),
    entryIds: v.pipe(
      v.array(identifierSchema),
      v.minLength(2),
      v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.entries),
    ),
    narrative: narrativeSchema,
    classification: desktopBillingDraftClassificationSchema,
    billable: v.boolean(),
  }),
  v.strictObject({
    type: v.literal("move"),
    targetMatterId: matterIdSchema,
    durationMinutes: durationSchema,
    narrative: narrativeSchema,
    classification: desktopBillingDraftClassificationSchema,
    billable: v.boolean(),
  }),
]);

export const desktopBillingDraftSchema = v.strictObject({
  entryId: identifierSchema,
  narrative: narrativeSchema,
  classification: desktopBillingDraftClassificationSchema,
  flags: v.pipe(v.array(desktopBillingDraftFlagSchema), v.maxLength(20)),
  matchedEarlierEntryIds: v.pipe(v.array(identifierSchema), v.maxLength(20)),
  operations: v.pipe(
    v.array(desktopBillingDraftOperationSchema),
    v.maxLength(20),
  ),
});

export const desktopBillingDraftResponseSchema = v.strictObject({
  drafts: v.pipe(
    v.array(desktopBillingDraftSchema),
    v.minLength(1),
    v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.entries),
  ),
  checkedGuidelines: v.pipe(
    v.array(
      v.strictObject({
        fileId: identifierSchema,
        fileName: nameSchema,
      }),
    ),
    v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.guidelines),
  ),
});

export const desktopBillingDraftRequestSchema = v.pipe(
  v.strictObject({
    entries: v.pipe(
      v.array(desktopBillingDraftEntrySchema),
      v.minLength(1),
      v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.entries),
    ),
    steer: v.optional(steeringTextSchema),
    previousResult: v.optional(desktopBillingDraftResponseSchema),
  }),
  v.check(
    (request) =>
      request.previousResult === undefined || request.steer !== undefined,
    "Previous drafts require a steering instruction",
  ),
);

export const desktopBillingDraftSettingsRequestSchema = v.pipe(
  v.strictObject({
    consent: v.optional(v.picklist(["granted", "revoked"])),
    preference: v.optional(v.nullable(steeringTextSchema)),
  }),
  v.check(
    (request) =>
      request.consent !== undefined || request.preference !== undefined,
    "A consent or preference update is required",
  ),
);

export const desktopBillingDraftSettingsResponseSchema = v.strictObject({
  organizationMode: v.picklist(["enabled", "disabled"]),
  consent: v.picklist(["granted", "revoked"]),
  preference: v.nullable(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.steerLength),
    ),
  ),
});

export type DesktopBillingDraftRequest = v.InferOutput<
  typeof desktopBillingDraftRequestSchema
>;
export type DesktopBillingDraftResponse = v.InferOutput<
  typeof desktopBillingDraftResponseSchema
>;
export type DesktopBillingDraft = v.InferOutput<
  typeof desktopBillingDraftSchema
>;
export type DesktopBillingDraftOperation = v.InferOutput<
  typeof desktopBillingDraftOperationSchema
>;
export type DesktopBillingDraftClassification = v.InferOutput<
  typeof desktopBillingDraftClassificationSchema
>;
export type DesktopBillingDraftSettingsRequest = v.InferOutput<
  typeof desktopBillingDraftSettingsRequestSchema
>;
export type DesktopBillingDraftSettingsResponse = v.InferOutput<
  typeof desktopBillingDraftSettingsResponseSchema
>;
