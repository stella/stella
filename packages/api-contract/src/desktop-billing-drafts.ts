import * as v from "valibot";

import { apiDateSchema } from "./api-date";
import {
  createDesktopTimeEntryClassificationSchema,
  DESKTOP_TIME_ENTRY_CODE_MAX_LENGTH,
  DESKTOP_TIME_ENTRY_NARRATIVE_MAX_LENGTH,
} from "./desktop-time-entries";
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
  codeLength: DESKTOP_TIME_ENTRY_CODE_MAX_LENGTH,
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
  const desktopBillingDraftClassificationSchema =
    createDesktopTimeEntryClassificationSchema(profile);

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

  const desktopBillingDraftResponseSchema = v.strictObject({
    drafts: array(desktopBillingDraftSchema, {
      min: 1,
      max: DESKTOP_BILLING_DRAFT_LIMITS.entries,
    }),
    checkedGuidelines: array(
      v.strictObject({ fileId: identifier, fileName: name }),
      { max: DESKTOP_BILLING_DRAFT_LIMITS.guidelines },
    ),
  });

  return {
    desktopBillingDraftRuleRefSchema,
    desktopBillingDraftFlagSchema,
    desktopBillingDraftOperationSchema,
    desktopBillingDraftSchema,
    desktopBillingDraftResponseSchema,
  };
};

export const {
  desktopBillingDraftRuleRefSchema,
  desktopBillingDraftFlagSchema,
  desktopBillingDraftOperationSchema,
  desktopBillingDraftSchema,
  desktopBillingDraftResponseSchema,
} = createBillingDraftResponseSchemas("canonical");

/** Compact model grammar; every generated result must pass the canonical schema. */
export const desktopBillingDraftModelResponseSchema =
  createBillingDraftResponseSchemas("model").desktopBillingDraftResponseSchema;

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
      // Drafts refer back to entries by identifier, so a repeated one is
      // refused before any model runs.
      v.check(
        (entries) =>
          new Set(entries.map(({ entryId }) => entryId)).size ===
          entries.length,
        "Entry identifiers must be unique",
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
