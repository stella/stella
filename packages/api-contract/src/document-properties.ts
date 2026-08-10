/**
 * The contract for a document's own embedded properties: what a DOCX, ODF or
 * PDF file records about itself (Author, Company, Producer, ...), as distinct
 * from what stella records about the document and from what AI extracted out
 * of its text.
 *
 * The key list lives here rather than in the API so the reader that produces
 * the values and the label map that renders them are bound to one source: a
 * new key cannot land without the UI failing to typecheck its `Record` of
 * labels.
 */

/**
 * Properties a person wrote, and the only ones an authoring application lets
 * them change. These carry intent — who owns the document, which client it
 * belongs to, whether it is still a draft — so they are what the panel shows.
 */
export const AUTHORED_DOCUMENT_PROPERTY_KEYS = [
  "title",
  "subject",
  "description",
  "keywords",
  "category",
  "contentStatus",
  "author",
  "lastModifiedBy",
  "company",
  "manager",
] as const;

/**
 * Facts the producing application generated about itself and about the bytes.
 * No authoring application offers a way to edit these, so neither does stella:
 * they render read-only, below the authored fields and behind a disclosure.
 * They are also routinely stale — a generator that never recomputes its
 * statistics leaves "0 words" on a document full of text — which is the second
 * reason they stay out of the way rather than leading the panel.
 */
export const GENERATED_DOCUMENT_PROPERTY_KEYS = [
  "createdAt",
  "modifiedAt",
  "lastPrintedAt",
  "revision",
  "editingMinutes",
  "application",
  "applicationVersion",
  "producer",
  "template",
  "language",
  "pages",
  "words",
  "characters",
  "paragraphs",
  "slides",
] as const;

/**
 * Property names, in display order. Formats map onto these where they mean the
 * same thing (OOXML `dc:creator`, PDF `Author` and ODF `meta:initial-creator`
 * are all `author`), so one label set covers every format.
 */
export const DOCUMENT_PROPERTY_KEYS = [
  ...AUTHORED_DOCUMENT_PROPERTY_KEYS,
  ...GENERATED_DOCUMENT_PROPERTY_KEYS,
] as const;

export type DocumentPropertyKey = (typeof DOCUMENT_PROPERTY_KEYS)[number];

export type AuthoredDocumentPropertyKey =
  (typeof AUTHORED_DOCUMENT_PROPERTY_KEYS)[number];

const AUTHORED_KEYS: ReadonlySet<string> = new Set(
  AUTHORED_DOCUMENT_PROPERTY_KEYS,
);

/** Whether this property is one a person authored, rather than a generated fact. */
export const isAuthoredDocumentPropertyKey = (
  key: DocumentPropertyKey,
): key is AuthoredDocumentPropertyKey => AUTHORED_KEYS.has(key);

/**
 * A value keeps its kind so the client formats it in the reader's locale (a
 * date as a date, a count as a number) instead of echoing the raw string the
 * producing application happened to write.
 */
export type DocumentPropertyValue =
  | { type: "text"; value: string }
  | { type: "date"; value: string }
  | { type: "count"; value: number }
  | { type: "minutes"; value: number };

export type DocumentProperty = {
  key: DocumentPropertyKey;
  value: DocumentPropertyValue;
};

/**
 * Either the properties or why there are none. A discriminated union rather
 * than an empty list: "this format carries no metadata", "the file is locked"
 * and "this document left every field blank" are different answers, and the
 * panel says which one it is instead of showing the same blank state for all.
 */
export type DocumentPropertiesResult =
  | {
      status: "available";
      properties: DocumentProperty[];
      /**
       * Whether this file's authored properties can be written back. Decided by
       * the server that would do the writing, not inferred by the client from
       * the MIME type, so the panel cannot offer an edit the endpoint refuses.
       */
      editable: boolean;
    }
  | { status: "unsupported-format" }
  | { status: "password-protected" }
  | { status: "too-large" }
  | { status: "unreadable" };

/** The `status` values a caller must handle, for exhaustive label maps. */
export type DocumentPropertiesStatus = DocumentPropertiesResult["status"];

/** Container layout a format's properties live in. */
export type DocumentContainerFormat = "ooxml" | "odf" | "pdf";

/**
 * Formats whose embedded properties can be read and removed. Declared here
 * rather than in the API so the client deciding whether to offer the action and
 * the server deciding whether to perform it read the same list: a hand-copied
 * mirror would let the menu offer a scrub the endpoint then refuses.
 */
export const DOCUMENT_PROPERTY_MIME_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.oasis.opendocument.presentation": "odf",
  "application/vnd.oasis.opendocument.spreadsheet": "odf",
  "application/vnd.oasis.opendocument.text": "odf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "ooxml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "ooxml",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "ooxml",
} as const satisfies Record<string, DocumentContainerFormat>;

const FORMAT_BY_MIME_TYPE = new Map<string, DocumentContainerFormat>(
  Object.entries(DOCUMENT_PROPERTY_MIME_TYPES),
);

/** The container layout for a MIME type, or null when it carries no properties. */
export const documentContainerFormat = (
  mimeType: string,
): DocumentContainerFormat | null => FORMAT_BY_MIME_TYPE.get(mimeType) ?? null;

/** Whether this format carries embedded properties worth reading or removing. */
export const hasDocumentProperties = (mimeType: string): boolean =>
  documentContainerFormat(mimeType) !== null;
