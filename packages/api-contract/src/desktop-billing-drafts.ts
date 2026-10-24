import * as v from "valibot";

import {
  DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH,
  desktopTimeEntryClassificationSchema,
} from "./desktop-time-entries";

export const DESKTOP_BILLING_DRAFT_LIMITS = {
  entries: 20,
  steerLength: 2000,
  narrativeLength: 4000,
  evidenceItems: 20,
  nameLength: 512,
  guidelines: 20,
  matchedEarlierEntries: 20,
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
  windowTitles: v.pipe(
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
  classification: desktopTimeEntryClassificationSchema,
  billable: v.boolean(),
});

export const desktopBillingDraftOperationSchema = v.union([
  v.strictObject({ type: v.literal("rewrite"), narrative: narrativeSchema }),
  v.strictObject({
    type: v.literal("change_classification"),
    classification: desktopTimeEntryClassificationSchema,
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
    classification: desktopTimeEntryClassificationSchema,
    billable: v.boolean(),
  }),
  v.strictObject({
    type: v.literal("move"),
    targetMatterId: matterIdSchema,
    targetMatterName: v.pipe(v.string(), v.maxLength(512)),
    durationMinutes: durationSchema,
    narrative: narrativeSchema,
    classification: desktopTimeEntryClassificationSchema,
    billable: v.boolean(),
  }),
]);

export const desktopBillingDraftSchema = v.strictObject({
  entryId: identifierSchema,
  narrative: narrativeSchema,
  classification: desktopTimeEntryClassificationSchema,
  flags: v.pipe(v.array(desktopBillingDraftFlagSchema), v.maxLength(20)),
  matchedEarlierEntryIds: v.pipe(
    v.array(identifierSchema),
    v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.matchedEarlierEntries),
  ),
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

/** The caller's own earlier entries a draft cites, so the review can show
 * what "consistent with" refers to without a second request. */
export const desktopBillingDraftEarlierEntrySchema = v.strictObject({
  id: identifierSchema,
  dateWorked: v.pipe(v.string(), v.isoDate()),
  durationMinutes: durationSchema,
  narrative: v.pipe(
    v.string(),
    v.maxLength(DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH),
  ),
});

/** What the endpoint returns: the model's result, which a steering request
 * sends back unchanged as `previousResult`, and the cited earlier entries. */
export const desktopBillingDraftReviewSchema = v.strictObject({
  result: desktopBillingDraftResponseSchema,
  earlierEntries: v.pipe(
    v.array(desktopBillingDraftEarlierEntrySchema),
    v.maxLength(
      DESKTOP_BILLING_DRAFT_LIMITS.entries *
        DESKTOP_BILLING_DRAFT_LIMITS.matchedEarlierEntries,
    ),
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
export type DesktopBillingDraftReview = v.InferOutput<
  typeof desktopBillingDraftReviewSchema
>;
export type DesktopBillingDraft = v.InferOutput<
  typeof desktopBillingDraftSchema
>;
export type DesktopBillingDraftOperation = v.InferOutput<
  typeof desktopBillingDraftOperationSchema
>;
export type DesktopBillingDraftSettingsRequest = v.InferOutput<
  typeof desktopBillingDraftSettingsRequestSchema
>;
export type DesktopBillingDraftSettingsResponse = v.InferOutput<
  typeof desktopBillingDraftSettingsResponseSchema
>;
