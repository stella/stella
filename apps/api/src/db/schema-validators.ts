import * as v from "valibot";

import {
  ENTITY_KINDS,
  REVIEW_FLAGS,
  REVIEW_FLAGS_MAX_ITEMS,
} from "@stll/api-contract";
import { apiDateSchema, apiDateTimeSchema } from "@stll/api-contract/api-date";

import type { JsonObject } from "@/api/lib/json-value";
import {
  positionRuleSchema,
  positionSeveritySchema,
  resolvedTiersSchema,
} from "@/api/lib/workflow/playbook-position-facets";

const v1 = v.literal(1);

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

const namedOptionColor = v.picklist([...NAMED_OPTION_COLORS]);

/** 6-character hex color (e.g. "FF0000"). */
const hexColor = v.pipe(v.string(), v.regex(/^[0-9A-Fa-f]{6}$/u));

/** Named preset or arbitrary hex color. */
const optionColor = v.union([namedOptionColor, hexColor]);

export type OptionColor = v.InferOutput<typeof optionColor>;

const fileType = v.literal("file");
const textType = v.literal("text");
const singleSelectType = v.literal("single-select");
const multiSelectType = v.literal("multi-select");
const dateType = v.literal("date");
const intType = v.literal("int");
const moneyType = v.literal("money");
const personType = v.literal("person");

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
 * (`currencyCodeSchema` in `@stll/api-contract/currency-code`) rejects lower case outright, but that column had a
 * migration to bring its rows along and this one is reached by clients that
 * were always free to send either case, so rejecting now would break writes
 * that used to work. Normalizing instead leaves nothing to migrate: display
 * resolves either case through `Intl` already, and every row written from here
 * on groups and compares as one currency rather than two.
 *
 * The transform only rewrites the output: `v.is` still accepts a stored
 * lower-case code, so the modules that validate an already-stored value are
 * unaffected.
 */
export const currencyCodeSchema = (description?: string) =>
  v.pipe(
    v.string(),
    v.length(3),
    v.regex(/^[A-Za-z]{3}$/u),
    v.transform((code) => code.toUpperCase()),
    v.metadata(description === undefined ? {} : { description }),
  );

const currencyCode = currencyCodeSchema();

export const entityKindSchema = v.picklist(ENTITY_KINDS);
export type { EntityKind } from "@stll/api-contract";

// No default: a request that omits this required field is a 400, never a
// silent "file". `schema-validators.test.ts` binds the members to `PROPERTY_CONTENT_TYPES`,
// so a new property type still has to be classified for find.
export const propertyContentTypeSchema = v.union([
  fileType,
  textType,
  singleSelectType,
  multiSelectType,
  dateType,
  intType,
  moneyType,
  personType,
]);

export type PropertyContentType = v.InferOutput<
  typeof propertyContentTypeSchema
>;

const filePropertyContentSchema = v.object({ version: v1, type: fileType });

const textPropertyContentSchema = v.object({ version: v1, type: textType });

const selectPropertyContentSchema = v.object({
  version: v1,
  type: v.union([singleSelectType, multiSelectType]),
  options: v.array(
    v.object({
      color: optionColor,
      value: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
    }),
  ),
  fallback: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1000))),
});

const datePropertyContentSchema = v.object({ version: v1, type: dateType });

const intPropertyContentSchema = v.object({ version: v1, type: intType });

// Money is not an int with a currency label: it is stored in minor units, so
// the two cannot share a column without a 100x bug waiting in every sum. The
// property's currency is the default new values take; null means each value
// carries its own.
const moneyPropertyContentSchema = v.object({
  version: v1,
  type: moneyType,
  currency: v.nullable(currencyCode),
});

const personPropertyContentSchema = v.object({ version: v1, type: personType });

/**
 * Property content an AI tool can produce a value for. A file is uploaded, a
 * money amount needs a currency the model has no way to choose, and a person
 * has to resolve to a workspace member; all three are entered by hand, so the
 * execution plan never schedules them and the prompt/validator switches below
 * have no branch for them.
 *
 * The same subset a case-law question column offers, which is why it is a
 * schema rather than a type-level `Exclude`: both boundaries parse against it.
 */
export const aiExtractablePropertyContentSchema = v.union([
  textPropertyContentSchema,
  selectPropertyContentSchema,
  datePropertyContentSchema,
  intPropertyContentSchema,
]);

export type AiExtractablePropertyContent = v.InferOutput<
  typeof aiExtractablePropertyContentSchema
>;

export const propertyContentSchema = v.union([
  filePropertyContentSchema,
  textPropertyContentSchema,
  selectPropertyContentSchema,
  datePropertyContentSchema,
  intPropertyContentSchema,
  moneyPropertyContentSchema,
  personPropertyContentSchema,
]);

export type PropertyContent = v.InferOutput<typeof propertyContentSchema>;

export const isAiExtractablePropertyContent = (
  content: PropertyContent,
): content is AiExtractablePropertyContent =>
  content.type !== "file" &&
  content.type !== "money" &&
  content.type !== "person";

export const aiModelToolSchema = v.object({
  version: v1,
  type: v.literal("ai-model"),
  prompt: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
});
export type AIModelTool = v.InferOutput<typeof aiModelToolSchema>;

export const manualInputToolSchema = v.object({
  version: v1,
  type: v.literal("manual-input"),
});
export type ManualInputTool = v.InferOutput<typeof manualInputToolSchema>;

// A derived property whose value is the GRADE verdict for a playbook position.
// Computed after its ASK property extracts (it depends on `askPropertyId`):
// deterministically for `presence`/`propertyConstraint` (condition AST, no LLM)
// or via an LLM tier-match for `positionMatch`. `tiers` is the run-time snapshot
// of the resolved tiered ladder (ideal, ranked fallbacks, acceptable/red-line
// rules) the tier-match grading compares against.
export const playbookVerdictToolSchema = v.object({
  version: v1,
  type: v.literal("playbook-verdict"),
  askPropertyId: v.pipe(v.string(), v.uuid()),
  rule: positionRuleSchema,
  severity: positionSeveritySchema,
  tiers: resolvedTiersSchema,
});
export type PlaybookVerdictTool = v.InferOutput<
  typeof playbookVerdictToolSchema
>;

export const propertyToolSchema = v.union([
  aiModelToolSchema,
  manualInputToolSchema,
  playbookVerdictToolSchema,
]);

export type PropertyTool = v.InferOutput<typeof propertyToolSchema>;

/**
 * Why a derivative reached `failed`. `enqueue` means the job never entered the
 * queue, so nothing will ever pick the derivative up again and a reconciler
 * must retry it; `processing` means the worker ran and exhausted its attempts,
 * which is terminal; `too-large` means admission refused the source (bytes or
 * declared pixels over the derivative budget) before any conversion, which is
 * also terminal: the stored file is unchanged, so a retry would refuse again. Absent on rows written before the distinction existed:
 * those are read as terminal, because resurrecting a genuine processing
 * failure is the more expensive mistake.
 */
export const DERIVATIVE_FAILURE_REASON = {
  ENQUEUE: "enqueue",
  PROCESSING: "processing",
  TOO_LARGE: "too-large",
} as const;

export type DerivativeFailureReason =
  (typeof DERIVATIVE_FAILURE_REASON)[keyof typeof DERIVATIVE_FAILURE_REASON];

const conversionRefusalSchema = v.union([
  v.object({
    kind: v.literal("unsupported_encoding"),
    encoding: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  }),
  v.object({
    kind: v.literal("unsupported_reference"),
    format: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    element: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
    attribute: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  }),
  v.object({
    kind: v.literal("unsupported_field"),
    fieldType: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  }),
  v.object({
    kind: v.literal("legacy_format"),
    replacementExtension: v.picklist([".xlsx", ".pptx"]),
  }),
]);

/** Shared by both derivatives so their state machines cannot drift apart. */
const derivativeStateSchema = v.union([
  v.object({ status: v.literal("not-required") }),
  v.object({ status: v.literal("pending") }),
  v.object({ status: v.literal("ready") }),
  v.object({
    status: v.literal("failed"),
    conversionRefusal: v.exactOptional(conversionRefusalSchema),
    reason: v.exactOptional(
      v.union([
        v.literal(DERIVATIVE_FAILURE_REASON.ENQUEUE),
        v.literal(DERIVATIVE_FAILURE_REASON.PROCESSING),
        v.literal(DERIVATIVE_FAILURE_REASON.TOO_LARGE),
      ]),
    ),
  }),
]);

export const fieldContentSchema = v.union([
  v.object({ version: v1, type: v.literal("error") }),
  v.object({ version: v1, type: v.literal("pending") }),
  v.object({ version: v1, type: v.literal("unsupported") }),
  v.object({
    version: v1,
    type: v.literal("file"),
    id: v.pipe(v.string(), v.uuid()),
    fileName: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    mimeType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
    sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
    encrypted: v.boolean(),
    sha256Hex: v.pipe(v.string(), v.minLength(64), v.maxLength(64)),
    pdfFileId: v.nullable(v.pipe(v.string(), v.uuid())),
    pdfDerivative: v.exactOptional(derivativeStateSchema),
    thumbnailFileId: v.exactOptional(v.nullable(v.pipe(v.string(), v.uuid()))),
    // ThumbHash-rendered `data:image/png;base64,...` blur of the source
    // image (~400-700 bytes); rendered directly in an <img src>.
    placeholder: v.exactOptional(v.pipe(v.string(), v.maxLength(2048))),
    thumbnailDerivative: v.exactOptional(derivativeStateSchema),
    scanWarnings: v.exactOptional(
      v.array(v.pipe(v.string(), v.maxLength(256))),
    ),
  }),
  v.object({
    version: v1,
    type: v.literal("text"),
    value: v.pipe(v.string(), v.minLength(1)),
  }),
  v.object({
    version: v1,
    type: v.literal("single-select"),
    value: v.nullable(v.pipe(v.string(), v.minLength(1))),
  }),
  v.object({
    version: v1,
    type: v.literal("multi-select"),
    value: v.array(v.pipe(v.string(), v.minLength(1))),
  }),
  v.object({
    version: v1,
    type: v.literal("date"),
    value: v.nullable(apiDateSchema),
  }),
  v.object({
    version: v1,
    type: v.literal("int"),
    value: v.pipe(v.number(), v.integer()),
    currency: v.nullable(currencyCode),
  }),
  v.object({
    version: v1,
    type: v.literal("money"),
    // Minor units ("cents"), so arithmetic stays exact.
    amountCents: v.pipe(v.number(), v.integer()),
    currency: currencyCode,
  }),
  v.object({
    version: v1,
    type: v.literal("person"),
    // Null when the person is named but not a workspace member.
    userId: v.nullable(v.pipe(v.string(), v.maxLength(128))),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    image: v.nullable(v.pipe(v.string(), v.maxLength(2048))),
  }),
  v.object({
    version: v1,
    type: v.literal("clip"),
    url: v.pipe(v.string(), v.maxLength(2048)),
    snippet: v.exactOptional(v.pipe(v.string(), v.maxLength(10_000))),
    citation: v.exactOptional(v.pipe(v.string(), v.maxLength(1000))),
    jurisdiction: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
    sourceType: v.exactOptional(v.pipe(v.string(), v.maxLength(64))),
  }),
]);

export type FieldContent = v.InferOutput<typeof fieldContentSchema>;

const cellLockReasonSchema = v.picklist(["manual-edit", "explicit"]);

const cellMetadataSchema = v.object({
  version: v1,
  // One flag vocabulary for every reviewed thing (see `REVIEW_FLAGS`), so a
  // cell and a review finding cannot drift into two sets of the same idea.
  manualFlags: v.pipe(
    v.array(v.picklist([...REVIEW_FLAGS])),
    v.maxLength(REVIEW_FLAGS_MAX_ITEMS),
  ),
  // Keyed by flag; only the flags actually set appear, so the key stays a
  // plain string rather than a total record over the vocabulary.
  flagProvenance: v.exactOptional(
    v.record(
      v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
      v.object({
        addedBy: v.pipe(v.string(), v.minLength(1)),
        addedAt: apiDateTimeSchema,
      }),
    ),
  ),
  locked: v.exactOptional(v.boolean()),
  lockProvenance: v.exactOptional(
    v.object({
      lockedBy: v.pipe(v.string(), v.minLength(1)),
      lockedAt: apiDateTimeSchema,
      reason: cellLockReasonSchema,
    }),
  ),
});

export type CellMetadata = v.InferOutput<typeof cellMetadataSchema>;

const boundingBoxesSchema = v.object({
  version: v1,
  boxes: v.pipe(
    v.array(
      v.object({
        pageNumber: v.number(),
        yMin: v.number(),
        xMin: v.number(),
        yMax: v.number(),
        xMax: v.number(),
      }),
    ),
    v.minLength(1),
  ),
});

export type BoundingBoxes = v.InferOutput<typeof boundingBoxesSchema>;
export type BoundingBox = BoundingBoxes["boxes"][number];

// -- Billing schemas --

export const bankAccountSchema = v.object({
  iban: v.exactOptional(v.pipe(v.string(), v.maxLength(34))),
  bic: v.exactOptional(v.pipe(v.string(), v.maxLength(11))),
  accountNumber: v.exactOptional(v.pipe(v.string(), v.maxLength(64))),
  bankName: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  currency: v.exactOptional(currencyCode),
});

export type BankAccount = v.InferOutput<typeof bankAccountSchema>;

export const billingAddressSchema = v.object({
  line1: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  line2: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  city: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  state: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  postalCode: v.exactOptional(v.pipe(v.string(), v.maxLength(32))),
  country: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export type BillingAddress = v.InferOutput<typeof billingAddressSchema>;

// -- Contact schemas --

export const contactEmailSchema = v.object({
  type: v.picklist(["work", "personal", "other"]),
  address: v.pipe(v.string(), v.email(), v.maxLength(320)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export type ContactEmail = v.InferOutput<typeof contactEmailSchema>;

export const contactPhoneSchema = v.object({
  type: v.picklist(["mobile", "office", "home", "fax", "other"]),
  number: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export type ContactPhone = v.InferOutput<typeof contactPhoneSchema>;

export const contactDataBoxSchema = v.object({
  id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9]{7}$/u)),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export type ContactDataBox = v.InferOutput<typeof contactDataBoxSchema>;

export const contactCustomFieldSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  value: v.pipe(v.string(), v.maxLength(2000)),
});

export type ContactCustomField = v.InferOutput<typeof contactCustomFieldSchema>;

const contactMetadataFields = {
  dataBoxes: v.exactOptional(
    v.pipe(v.array(contactDataBoxSchema), v.maxLength(20)),
  ),
  customFields: v.exactOptional(
    v.pipe(v.array(contactCustomFieldSchema), v.maxLength(50)),
  ),
};

export const contactMetadataSchema = v.object(contactMetadataFields);

export type ContactMetadata = v.InferOutput<typeof contactMetadataSchema>;

export type ContactPersistedMetadata = ContactMetadata & {
  version: 1;
  custom?: JsonObject;
};

export const contactAddressSchema = v.object({
  type: v.picklist([
    "office",
    "mailing",
    "billing",
    "service",
    "home",
    "other",
  ]),
  line1: v.pipe(v.string(), v.maxLength(512)),
  line2: v.exactOptional(v.pipe(v.string(), v.maxLength(512))),
  city: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  state: v.exactOptional(v.pipe(v.string(), v.maxLength(256))),
  postalCode: v.exactOptional(v.pipe(v.string(), v.maxLength(32))),
  country: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
  isPrimary: v.boolean(),
  label: v.exactOptional(v.pipe(v.string(), v.maxLength(128))),
});

export type ContactAddress = v.InferOutput<typeof contactAddressSchema>;
