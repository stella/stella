import { t } from "elysia";
import type { Static } from "elysia";

import {
  ENTITY_KINDS,
  REVIEW_FLAGS,
  REVIEW_FLAGS_MAX_ITEMS,
} from "@stll/api-contract";

import type { JsonObject } from "@/api/lib/json-value";
import {
  positionRuleSchema,
  positionSeveritySchema,
  resolvedTiersSchema,
} from "@/api/lib/workflow/playbook-position-facets";

const v1 = t.Literal(1);

/**
 * The sixteen preset colours a select option may carry.
 *
 * `@stll/ui`'s `option-color` module holds the same list, because it maps each
 * name to a CSS custom property. The kit is published and deliberately carries
 * no `@stll/*` runtime dependency, and this app must not import a React kit, so
 * neither side can derive from the other today; a name added here has to be
 * added there too, or the token resolves to the empty colour.
 */
const NAMED_OPTION_COLORS = [
  "red",
  "orange",
  "amber",
  "yellow",

  "lime",
  "green",
  "emerald",
  "teal",

  "cyan",
  "sky",
  "blue",
  "indigo",

  "violet",
  "purple",
  "fuchsia",
  "gray",
] as const;

const namedOptionColor = t.UnionEnum([...NAMED_OPTION_COLORS]);

/** 6-character hex color (e.g. "FF0000"). */
const hexColor = t.String({ pattern: "^[0-9A-Fa-f]{6}$" });

/** Named preset or arbitrary hex color. */
const optionColor = t.Union([namedOptionColor, hexColor]);

export type OptionColor = Static<typeof optionColor>;

const fileType = t.Literal("file");
const textType = t.Literal("text");
const singleSelectType = t.Literal("single-select");
const multiSelectType = t.Literal("multi-select");
const dateType = t.Literal("date");
const intType = t.Literal("int");
const moneyType = t.Literal("money");
const personType = t.Literal("person");

/**
 * ISO 4217 alphabetic code for a workspace money or int field, normalized to
 * upper case on the way in.
 *
 * Three *letters*, not three characters: a stored "A1C" satisfies a length
 * check and then makes Intl.NumberFormat throw the moment a column formats it.
 * An unknown-but-well-formed code ("ZZZ") is accepted, because Intl accepts it
 * too.
 *
 * Either case is ACCEPTED, upper case is STORED. Billing's own boundary
 * (`tCurrencyCode`) rejects lower case outright, but that column had a
 * migration to bring its rows along and this one is reached by clients that
 * were always free to send either case, so rejecting now would break writes
 * that used to work. Normalizing instead leaves nothing to migrate: display
 * resolves either case through `Intl` already, and every row written from here
 * on groups and compares as one currency rather than two.
 *
 * `Value.Check` sees through a transform to the string underneath, so the
 * modules that validate an already-stored value are unaffected.
 */
export const currencyCodeSchema = (description?: string) =>
  t
    .Transform(
      t.String({
        minLength: 3,
        maxLength: 3,
        pattern: "^[A-Za-z]{3}$",
        ...(description === undefined ? {} : { description }),
      }),
    )
    .Decode((code) => code.toUpperCase())
    .Encode((code) => code);

const currencyCode = currencyCodeSchema();

export const entityKindSchema = t.UnionEnum(ENTITY_KINDS);
export type { EntityKind } from "@stll/api-contract";

export const propertyContentTypeSchema = t.Union([
  fileType,
  textType,
  singleSelectType,
  multiSelectType,
  dateType,
  intType,
  moneyType,
  personType,
]);

export type PropertyContentType = Static<typeof propertyContentTypeSchema>;

export const propertyContentSchema = t.Union([
  t.Object({
    version: v1,
    type: fileType,
  }),
  t.Object({
    version: v1,
    type: textType,
  }),
  t.Object({
    version: v1,
    type: t.Union([singleSelectType, multiSelectType]),

    options: t.Array(
      t.Object({
        color: optionColor,
        value: t.String({ minLength: 1, maxLength: 1000 }),
      }),
    ),
    fallback: t.Nullable(t.String({ minLength: 1, maxLength: 1000 })),
  }),
  t.Object({
    version: v1,
    type: dateType,
  }),
  t.Object({
    version: v1,
    type: intType,
  }),
  // Money is not an int with a currency label: it is stored in minor units, so
  // the two cannot share a column without a 100x bug waiting in every sum. The
  // property's currency is the default new values take; null means each value
  // carries its own.
  t.Object({
    version: v1,
    type: moneyType,
    currency: t.Nullable(currencyCode),
  }),
  t.Object({
    version: v1,
    type: personType,
  }),
]);

export type PropertyContent = Static<typeof propertyContentSchema>;

/**
 * Property content an AI tool can produce a value for. A file is uploaded, a
 * money amount needs a currency the model has no way to choose, and a person
 * has to resolve to a workspace member; all three are entered by hand, so the
 * execution plan never schedules them and the prompt/validator switches below
 * have no branch for them.
 */
export type AiExtractablePropertyContent = Exclude<
  PropertyContent,
  { type: "file" | "money" | "person" }
>;

export const isAiExtractablePropertyContent = (
  content: PropertyContent,
): content is AiExtractablePropertyContent =>
  content.type !== "file" &&
  content.type !== "money" &&
  content.type !== "person";

export const aiModelToolSchema = t.Object({
  version: v1,
  type: t.Literal("ai-model"),
  prompt: t.String({ minLength: 1, maxLength: 1000 }),
});
export type AIModelTool = Static<typeof aiModelToolSchema>;

export const manualInputToolSchema = t.Object({
  version: v1,
  type: t.Literal("manual-input"),
});
export type ManualInputTool = Static<typeof manualInputToolSchema>;

// A derived property whose value is the GRADE verdict for a playbook position.
// Computed after its ASK property extracts (it depends on `askPropertyId`):
// deterministically for `presence`/`propertyConstraint` (condition AST, no LLM)
// or via an LLM tier-match for `positionMatch`. `tiers` is the run-time snapshot
// of the resolved tiered ladder (ideal, ranked fallbacks, acceptable/red-line
// rules) the tier-match grading compares against.
export const playbookVerdictToolSchema = t.Object({
  version: v1,
  type: t.Literal("playbook-verdict"),
  askPropertyId: t.String({ format: "uuid" }),
  rule: positionRuleSchema,
  severity: positionSeveritySchema,
  tiers: resolvedTiersSchema,
});
export type PlaybookVerdictTool = Static<typeof playbookVerdictToolSchema>;

export const propertyToolSchema = t.Union([
  aiModelToolSchema,
  manualInputToolSchema,
  playbookVerdictToolSchema,
]);

export type PropertyTool = Static<typeof propertyToolSchema>;

/**
 * One AI (or manual) column bound to a playbook. `sourceId` is a
 * stable, client-supplied UUID that survives edits so applying a
 * playbook twice maps a bundle column back to the same materialized
 * property instead of duplicating it. `prompt` is empty for
 * manual-input columns.
 */
export const playbookBundleColumnSchema = t.Object({
  sourceId: t.String({ format: "uuid" }),
  name: t.String({ minLength: 1, maxLength: 256 }),
  content: propertyContentSchema,
  prompt: t.String({ maxLength: 1000 }),
});
export type PlaybookBundleColumn = Static<typeof playbookBundleColumnSchema>;

export const playbookBundleSchema = t.Array(playbookBundleColumnSchema, {
  maxItems: 100,
});
export type PlaybookBundle = Static<typeof playbookBundleSchema>;

/**
 * Why a derivative reached `failed`. `enqueue` means the job never entered the
 * queue, so nothing will ever pick the derivative up again and a reconciler
 * must retry it; `processing` means the worker ran and exhausted its attempts,
 * which is terminal. Absent on rows written before the distinction existed:
 * those are read as terminal, because resurrecting a genuine processing
 * failure is the more expensive mistake.
 */
export const DERIVATIVE_FAILURE_REASON = {
  ENQUEUE: "enqueue",
  PROCESSING: "processing",
} as const;

export type DerivativeFailureReason =
  (typeof DERIVATIVE_FAILURE_REASON)[keyof typeof DERIVATIVE_FAILURE_REASON];

/** Shared by both derivatives so their state machines cannot drift apart. */
const derivativeStateSchema = t.Union([
  t.Object({
    status: t.Literal("not-required"),
  }),
  t.Object({
    status: t.Literal("pending"),
  }),
  t.Object({
    status: t.Literal("ready"),
  }),
  t.Object({
    status: t.Literal("failed"),
    reason: t.Optional(
      t.Union([
        t.Literal(DERIVATIVE_FAILURE_REASON.ENQUEUE),
        t.Literal(DERIVATIVE_FAILURE_REASON.PROCESSING),
      ]),
    ),
  }),
]);

export const fieldContentSchema = t.Union([
  t.Object({
    version: v1,
    type: t.Literal("error"),
  }),
  t.Object({
    version: v1,
    type: t.Literal("pending"),
  }),
  t.Object({
    version: v1,
    type: t.Literal("unsupported"),
  }),
  t.Object({
    version: v1,
    type: t.Literal("file"),
    id: t.String({ format: "uuid" }),
    fileName: t.String({ minLength: 1, maxLength: 256 }),
    mimeType: t.String({ minLength: 1, maxLength: 255 }),
    sizeBytes: t.Integer({ minimum: 0 }),
    encrypted: t.Boolean(),
    sha256Hex: t.String({ minLength: 64, maxLength: 64 }),
    pdfFileId: t.Nullable(t.String({ format: "uuid" })),
    pdfDerivative: t.Optional(derivativeStateSchema),
    thumbnailFileId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
    // ThumbHash-rendered `data:image/png;base64,...` blur of the source
    // image (~400-700 bytes); rendered directly in an <img src>.
    placeholder: t.Optional(t.String({ maxLength: 2048 })),
    thumbnailDerivative: t.Optional(derivativeStateSchema),
    scanWarnings: t.Optional(t.Array(t.String({ maxLength: 256 }))),
  }),
  t.Object({
    version: v1,
    type: t.Literal("text"),
    value: t.String({ minLength: 1 }),
  }),
  t.Object({
    version: v1,
    type: t.Literal("single-select"),
    value: t.Nullable(t.String({ minLength: 1 })),
  }),
  t.Object({
    version: v1,
    type: t.Literal("multi-select"),
    value: t.Array(t.String({ minLength: 1 })),
  }),
  t.Object({
    version: v1,
    type: t.Literal("date"),
    value: t.Nullable(t.String({ format: "date" })),
  }),
  t.Object({
    version: v1,
    type: t.Literal("int"),
    value: t.Integer(),
    currency: t.Nullable(currencyCode),
  }),
  t.Object({
    version: v1,
    type: t.Literal("money"),
    // Minor units ("cents"), so arithmetic stays exact.
    amountCents: t.Integer(),
    currency: currencyCode,
  }),
  t.Object({
    version: v1,
    type: t.Literal("person"),
    // Null when the person is named but not a workspace member.
    userId: t.Nullable(t.String({ maxLength: 128 })),
    name: t.String({ minLength: 1, maxLength: 256 }),
    image: t.Nullable(t.String({ maxLength: 2048 })),
  }),
  t.Object({
    version: v1,
    type: t.Literal("clip"),
    url: t.String({ maxLength: 2048 }),
    snippet: t.Optional(t.String({ maxLength: 10_000 })),
    citation: t.Optional(t.String({ maxLength: 1000 })),
    jurisdiction: t.Optional(t.String({ maxLength: 128 })),
    sourceType: t.Optional(t.String({ maxLength: 64 })),
  }),
]);

export type FieldContent = Static<typeof fieldContentSchema>;

const cellLockReasonSchema = t.UnionEnum(["manual-edit", "explicit"]);

export const cellMetadataSchema = t.Object({
  version: v1,
  // One flag vocabulary for every reviewed thing (see `REVIEW_FLAGS`), so a
  // cell and a review finding cannot drift into two sets of the same idea.
  manualFlags: t.Array(t.UnionEnum([...REVIEW_FLAGS]), {
    maxItems: REVIEW_FLAGS_MAX_ITEMS,
  }),
  // Keyed by flag; only the flags actually set appear, so the key stays a
  // plain string rather than a total record over the vocabulary.
  flagProvenance: t.Optional(
    t.Record(
      t.String({ minLength: 1, maxLength: 64 }),
      t.Object({
        addedBy: t.String({ minLength: 1 }),
        addedAt: t.String({ format: "date-time" }),
      }),
    ),
  ),
  locked: t.Optional(t.Boolean()),
  lockProvenance: t.Optional(
    t.Object({
      lockedBy: t.String({ minLength: 1 }),
      lockedAt: t.String({ format: "date-time" }),
      reason: cellLockReasonSchema,
    }),
  ),
});

export type CellMetadata = Static<typeof cellMetadataSchema>;

export const boundingBoxesSchema = t.Object({
  version: v1,
  boxes: t.Array(
    t.Object({
      pageNumber: t.Number(),
      yMin: t.Number(),
      xMin: t.Number(),
      yMax: t.Number(),
      xMax: t.Number(),
    }),
    { minItems: 1 },
  ),
});

export type BoundingBoxes = Static<typeof boundingBoxesSchema>;
export type BoundingBox = BoundingBoxes["boxes"][number];

// -- Billing schemas --

export const bankAccountSchema = t.Object({
  iban: t.Optional(t.String({ maxLength: 34 })),
  bic: t.Optional(t.String({ maxLength: 11 })),
  accountNumber: t.Optional(t.String({ maxLength: 64 })),
  bankName: t.Optional(t.String({ maxLength: 256 })),
  currency: t.Optional(currencyCode),
});

export type BankAccount = Static<typeof bankAccountSchema>;

export const billingAddressSchema = t.Object({
  line1: t.Optional(t.String({ maxLength: 512 })),
  line2: t.Optional(t.String({ maxLength: 512 })),
  city: t.Optional(t.String({ maxLength: 256 })),
  state: t.Optional(t.String({ maxLength: 256 })),
  postalCode: t.Optional(t.String({ maxLength: 32 })),
  country: t.Optional(t.String({ maxLength: 128 })),
});

export type BillingAddress = Static<typeof billingAddressSchema>;

// -- Contact schemas --

export const contactEmailSchema = t.Object({
  type: t.UnionEnum(["work", "personal", "other"]),
  address: t.String({ format: "email", maxLength: 320 }),
  isPrimary: t.Boolean(),
  label: t.Optional(t.String({ maxLength: 128 })),
});

export type ContactEmail = Static<typeof contactEmailSchema>;

export const contactPhoneSchema = t.Object({
  type: t.UnionEnum(["mobile", "office", "home", "fax", "other"]),
  number: t.String({ minLength: 1, maxLength: 32 }),
  isPrimary: t.Boolean(),
  label: t.Optional(t.String({ maxLength: 128 })),
});

export type ContactPhone = Static<typeof contactPhoneSchema>;

export const contactDataBoxSchema = t.Object({
  id: t.String({ pattern: "^[A-Za-z0-9]{7}$" }),
  isPrimary: t.Boolean(),
  label: t.Optional(t.String({ maxLength: 128 })),
});

export type ContactDataBox = Static<typeof contactDataBoxSchema>;

export const contactCustomFieldSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 64 }),
  label: t.String({ minLength: 1, maxLength: 128 }),
  value: t.String({ maxLength: 2000 }),
});

export type ContactCustomField = Static<typeof contactCustomFieldSchema>;

const contactMetadataFields = {
  dataBoxes: t.Optional(t.Array(contactDataBoxSchema, { maxItems: 20 })),
  customFields: t.Optional(t.Array(contactCustomFieldSchema, { maxItems: 50 })),
};

export const contactMetadataSchema = t.Object(contactMetadataFields);

export type ContactMetadata = Static<typeof contactMetadataSchema>;

export const contactPersistedMetadataSchema = t.Object({
  version: t.Literal(1),
  ...contactMetadataFields,
  custom: t.Optional(t.Record(t.String(), t.Unknown())),
});

export type ContactPersistedMetadata = ContactMetadata & {
  version: 1;
  custom?: JsonObject;
};

export const contactAddressSchema = t.Object({
  type: t.UnionEnum([
    "office",
    "mailing",
    "billing",
    "service",
    "home",
    "other",
  ]),
  line1: t.String({ maxLength: 512 }),
  line2: t.Optional(t.String({ maxLength: 512 })),
  city: t.Optional(t.String({ maxLength: 256 })),
  state: t.Optional(t.String({ maxLength: 256 })),
  postalCode: t.Optional(t.String({ maxLength: 32 })),
  country: t.Optional(t.String({ maxLength: 128 })),
  isPrimary: t.Boolean(),
  label: t.Optional(t.String({ maxLength: 128 })),
});

export type ContactAddress = Static<typeof contactAddressSchema>;
