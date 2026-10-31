import * as v from "valibot";

import { apiDateSchema } from "./api-date";
import { TIME_ENTRY_ACTIVITY_GROUPS } from "./billing";
import { DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH } from "./desktop-time-entries";
import { uuidSchema } from "./uuid";

export const DESKTOP_BILLING_DRAFT_LIMITS = {
  entries: 20,
  identifierLength: 128,
  matterIdLength: 36,
  dateLength: 10,
  durationMinutes: 1440,
  flags: 20,
  operations: 20,
  splitParts: 20,
  steerLength: 2000,
  narrativeLength: 4000,
  evidenceItems: 20,
  nameLength: 512,
  guidelines: 20,
  codeLength: 20,
  matchedEarlierEntries: 20,
} as const;

const identifierSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.identifierLength),
);
const matterIdSchema = uuidSchema;
const dateSchema = v.pipe(
  apiDateSchema,
  v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.dateLength),
);
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
  v.maxValue(DESKTOP_BILLING_DRAFT_LIMITS.durationMinutes),
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
  entryId: identifierSchema,
  matterId: matterIdSchema,
  date: dateSchema,
  timezone: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  durationMinutes: durationSchema,
  appNames: v.pipe(v.array(nameSchema), v.maxLength(20)),
  evidence: v.optional(desktopBillingDraftEvidenceSchema),
});

const createBillingDraftResponseSchemas = (profile: "canonical" | "model") => {
  const identifier = profile === "canonical" ? identifierSchema : v.string();
  const matterId =
    profile === "canonical"
      ? matterIdSchema
      : v.pipe(
          v.string(),
          v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.matterIdLength),
        );
  const name = profile === "canonical" ? nameSchema : v.string();
  const narrative = profile === "canonical" ? narrativeSchema : v.string();
  const duration = profile === "canonical" ? durationSchema : v.number();
  const codeSchema =
    profile === "canonical"
      ? v.pipe(
          v.string(),
          v.minLength(1),
          v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.codeLength),
        )
      : v.string();
  const targetMatterNameSchema =
    profile === "canonical"
      ? v.pipe(v.string(), v.maxLength(DESKTOP_BILLING_DRAFT_LIMITS.nameLength))
      : v.string();
  const array = <Schema extends v.GenericSchema>(
    schema: Schema,
    { min, max }: { min?: number; max: number },
  ) => {
    if (profile === "model") {
      return v.array(schema);
    }
    if (min === undefined) {
      return v.pipe(v.array(schema), v.maxLength(max));
    }
    return v.pipe(v.array(schema), v.minLength(min), v.maxLength(max));
  };
  const desktopBillingDraftClassificationSchema = v.union([
    v.strictObject({
      type: v.literal("ledes"),
      taskCode: codeSchema,
      activityCode: codeSchema,
    }),
    v.strictObject({
      type: v.literal("activity_group"),
      activityGroup: v.picklist(TIME_ENTRY_ACTIVITY_GROUPS),
    }),
  ]);

  const desktopBillingDraftRuleRefSchema = v.strictObject({
    fileId: identifier,
    fileName: name,
    section: name,
  });

  const desktopBillingDraftFlagSchema = v.strictObject({
    text: narrative,
    ruleRef: desktopBillingDraftRuleRefSchema,
    fix: v.optional(v.literal("split")),
  });

  const splitPartSchema = v.strictObject({
    durationMinutes: duration,
    narrative,
    classification: desktopBillingDraftClassificationSchema,
    billable: v.boolean(),
  });

  const desktopBillingDraftOperationSchema = v.union([
    v.strictObject({ type: v.literal("rewrite"), narrative }),
    v.strictObject({
      type: v.literal("change_classification"),
      classification: desktopBillingDraftClassificationSchema,
    }),
    v.strictObject({ type: v.literal("set_billable"), billable: v.boolean() }),
    v.strictObject({
      type: v.literal("split"),
      parts: array(splitPartSchema, {
        min: 2,
        max: DESKTOP_BILLING_DRAFT_LIMITS.splitParts,
      }),
    }),
    v.strictObject({
      type: v.literal("merge"),
      entryIds: array(identifier, {
        min: 2,
        max: DESKTOP_BILLING_DRAFT_LIMITS.entries,
      }),
      narrative,
      classification: desktopBillingDraftClassificationSchema,
      billable: v.boolean(),
    }),
    v.strictObject({
      type: v.literal("move"),
      targetMatterId: matterId,
      targetMatterName: targetMatterNameSchema,
      durationMinutes: duration,
      narrative,
      classification: desktopBillingDraftClassificationSchema,
      billable: v.boolean(),
    }),
  ]);

  const desktopBillingDraftSchema = v.strictObject({
    entryId: identifier,
    narrative,
    classification: desktopBillingDraftClassificationSchema,
    flags: array(desktopBillingDraftFlagSchema, {
      max: DESKTOP_BILLING_DRAFT_LIMITS.flags,
    }),
    matchedEarlierEntryIds: array(identifier, {
      max: DESKTOP_BILLING_DRAFT_LIMITS.matchedEarlierEntries,
    }),
    operations: array(desktopBillingDraftOperationSchema, {
      max: DESKTOP_BILLING_DRAFT_LIMITS.operations,
    }),
  });

  const guidedResponseEntries = {
    drafts: array(desktopBillingDraftSchema, {
      min: 1,
      max: DESKTOP_BILLING_DRAFT_LIMITS.entries,
    }),
    checkedGuidelines: array(
      v.strictObject({ fileId: identifier, fileName: name }),
      { max: DESKTOP_BILLING_DRAFT_LIMITS.guidelines },
    ),
  };

  // A description only: no classification, guideline flags or operations.
  const desktopBillingPlainDraftSchema = v.strictObject({
    entryId: identifier,
    narrative,
    matchedEarlierEntryIds: array(identifier, {
      max: DESKTOP_BILLING_DRAFT_LIMITS.matchedEarlierEntries,
    }),
  });

  const plainResponseEntries = {
    drafts: array(desktopBillingPlainDraftSchema, {
      min: 1,
      max: DESKTOP_BILLING_DRAFT_LIMITS.entries,
    }),
  };

  return {
    desktopBillingDraftClassificationSchema,
    desktopBillingDraftRuleRefSchema,
    desktopBillingDraftFlagSchema,
    desktopBillingDraftOperationSchema,
    desktopBillingDraftSchema,
    guidedResponseEntries,
    plainResponseEntries,
  };
};

const canonicalBillingDraftSchemas =
  createBillingDraftResponseSchemas("canonical");
const modelBillingDraftSchemas = createBillingDraftResponseSchemas("model");

export const {
  desktopBillingDraftClassificationSchema,
  desktopBillingDraftRuleRefSchema,
  desktopBillingDraftFlagSchema,
  desktopBillingDraftOperationSchema,
  desktopBillingDraftSchema,
} = canonicalBillingDraftSchemas;

/** Drafts checked against the organization's bound billing guideline files,
 * with billing classifications, guideline flags and reviewable operations. */
export const desktopBillingGuidedDraftResponseSchema = v.strictObject({
  mode: v.literal("guided"),
  ...canonicalBillingDraftSchemas.guidedResponseEntries,
});

/** Descriptions drafted without guideline files: no classification, flags,
 * operations or checked guidelines exist in this shape. */
export const desktopBillingPlainDraftResponseSchema = v.strictObject({
  mode: v.literal("plain"),
  ...canonicalBillingDraftSchemas.plainResponseEntries,
});

// A union, not a variant: native response validation reads `anyOf` and
// refuses `oneOf`. The `mode` literal still discriminates both branches.
export const desktopBillingDraftResponseSchema = v.union([
  desktopBillingGuidedDraftResponseSchema,
  desktopBillingPlainDraftResponseSchema,
]);

/** Compact model grammar; every generated result must pass the canonical
 * schema once the server names its mode. */
export const desktopBillingDraftModelResponseSchema = v.strictObject(
  modelBillingDraftSchemas.guidedResponseEntries,
);

/** Compact model grammar for plain descriptions. */
export const desktopBillingPlainDraftModelResponseSchema = v.strictObject(
  modelBillingDraftSchemas.plainResponseEntries,
);

/** The caller's own earlier entries a draft cites, so the review can show
 * what "consistent with" refers to without a second request. */
export const desktopBillingDraftEarlierEntrySchema = v.strictObject({
  id: identifierSchema,
  dateWorked: dateSchema,
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
      v.check(
        (entries) =>
          new Set(entries.map(({ entryId }) => entryId)).size ===
          entries.length,
        "Selected entry identifiers must be unique",
      ),
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

/** Opaque server revision of the caller's own settings; `null` before the
 * first write. */
const billingDraftSettingsRevisionSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
);

/** A withdrawal carries no revision, so it applies whatever the caller last
 * read. A grant or a preference change applies only to the revision it was
 * made on. */
export const desktopBillingDraftSettingsRequestSchema = v.variant("type", [
  v.strictObject({ type: v.literal("withdraw_consent") }),
  v.strictObject({
    type: v.literal("grant_consent"),
    revision: v.nullable(billingDraftSettingsRevisionSchema),
  }),
  v.strictObject({
    type: v.literal("set_preference"),
    revision: v.nullable(billingDraftSettingsRevisionSchema),
    preference: v.nullable(steeringTextSchema),
  }),
]);

export const desktopBillingDraftSettingsResponseSchema = v.strictObject({
  revision: v.nullable(billingDraftSettingsRevisionSchema),
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

/** Every write leaves the caller's row in place, so its answer always names
 * a revision. */
export const desktopBillingDraftSettingsUpdateResponseSchema = v.strictObject({
  ...desktopBillingDraftSettingsResponseSchema.entries,
  revision: billingDraftSettingsRevisionSchema,
});

export type DesktopBillingDraftRequest = v.InferOutput<
  typeof desktopBillingDraftRequestSchema
>;
export type DesktopBillingDraftResponse = v.InferOutput<
  typeof desktopBillingDraftResponseSchema
>;
export type DesktopBillingGuidedDraftResponse = v.InferOutput<
  typeof desktopBillingGuidedDraftResponseSchema
>;
export type DesktopBillingPlainDraftResponse = v.InferOutput<
  typeof desktopBillingPlainDraftResponseSchema
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
export type DesktopBillingDraftClassification = v.InferOutput<
  typeof desktopBillingDraftClassificationSchema
>;
export type DesktopBillingDraftSettingsRequest = v.InferOutput<
  typeof desktopBillingDraftSettingsRequestSchema
>;
export type DesktopBillingDraftSettingsResponse = v.InferOutput<
  typeof desktopBillingDraftSettingsResponseSchema
>;
