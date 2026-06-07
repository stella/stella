import { t } from "elysia";
import type { Static } from "elysia";

import type { JsonObject } from "@/api/lib/json-value";

const v1 = t.Literal(1);

const namedOptionColor = t.UnionEnum([
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
]);

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

export const entityKindSchema = t.UnionEnum([
  "document",
  "folder",
  "task",
  "message",
  "link",
]);
export type EntityKind = Static<typeof entityKindSchema>;

export const propertyContentTypeSchema = t.Union([
  fileType,
  textType,
  singleSelectType,
  multiSelectType,
  dateType,
  intType,
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
]);

export type PropertyContent = Static<typeof propertyContentSchema>;

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

export const propertyToolSchema = t.Union([
  aiModelToolSchema,
  manualInputToolSchema,
]);

export type PropertyTool = Static<typeof propertyToolSchema>;

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
    pdfDerivative: t.Optional(
      t.Union([
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
        }),
      ]),
    ),
    thumbnailFileId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
    // ThumbHash-rendered `data:image/png;base64,...` blur of the source
    // image (~400-700 bytes); rendered directly in an <img src>.
    placeholder: t.Optional(t.String({ maxLength: 2048 })),
    thumbnailDerivative: t.Optional(
      t.Union([
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
        }),
      ]),
    ),
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
    currency: t.Nullable(t.String({ minLength: 3, maxLength: 3 })),
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
  manualFlags: t.Array(t.String({ minLength: 1, maxLength: 64 }), {
    maxItems: 16,
  }),
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

export const propertyConditionSchema = t.Union([
  t.Object({
    version: v1,
    type: t.Literal("string"),
    operator: t.UnionEnum(["eq"]),
    value: t.String({ minLength: 1, maxLength: 1000 }),
  }),
  t.Object({
    version: v1,
    type: t.Literal("string-array"),
    operator: t.UnionEnum(["contains-every"]),
    value: t.Array(t.String({ minLength: 1, maxLength: 1000 }), {
      minItems: 1,
    }),
  }),
]);

export type PropertyCondition = Static<typeof propertyConditionSchema>;

// -- Billing schemas --

export const bankAccountSchema = t.Object({
  iban: t.Optional(t.String({ maxLength: 34 })),
  bic: t.Optional(t.String({ maxLength: 11 })),
  accountNumber: t.Optional(t.String({ maxLength: 64 })),
  bankName: t.Optional(t.String({ maxLength: 256 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 3 })),
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
