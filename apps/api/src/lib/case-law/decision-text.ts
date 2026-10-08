// parser-output-unchanged: Text and publication absence sidecars change metadata only; canonical documents and replay comparison inputs are unchanged.
import { panic } from "better-result";

import {
  DECISION_HEADNOTE_KEYWORDS,
  SK_US_ECLI_AVAILABILITY_STATUSES,
  SK_COURTS_SOURCE_URL_STATUSES,
  type SkUsEcliAvailability,
  type SkCourtsSourceUrlStatus,
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_FIELD,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_METADATA_KEYS,
  TEXT_ABSENCE_REASON,
  parseDecisionTextAbsence,
  TEXT_FIELD_TYPE,
  type DecisionHeadnotePreview,
  type DecisionTextAbsenceEntry,
  type DecisionTextAbsenceParseResult,
  type DecisionTextFieldKey,
  type ReadDecisionTextFields,
  type TextAbsenceReason,
  type TextField,
} from "@stll/api-contract/case-law-text-field";

import {
  collapseDecisionHeadnote,
  normalizeDecisionHeadnote,
  normalizeDecisionKeywords,
} from "@/api/lib/case-law/decision-headnote";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
import {
  approveMetadataUrls,
  rehydrateMetadataUrls,
  META_URL_DIAGNOSTICS,
  type MetadataUrlSchema,
} from "@/api/lib/legal-search/metadata-urls";
import { isRecord } from "@/api/lib/type-guards";

export { DECISION_TEXT_FIELD, TEXT_ABSENCE_REASON, TEXT_FIELD_TYPE };
export type { DecisionHeadnotePreview, TextAbsenceReason, TextField };

export type DecisionTextFields = ReadDecisionTextFields;

const DECISION_TEXT_FIELD_KEY_SET = new Set<string>(DECISION_TEXT_FIELD_KEYS);

const isDecisionTextFieldKey = (key: string): key is DecisionTextFieldKey =>
  DECISION_TEXT_FIELD_KEY_SET.has(key);

export const absentTextField = (reason: TextAbsenceReason) => ({
  type: TEXT_FIELD_TYPE.ABSENT,
  reason,
});

export const absentDecisionTextFields = (
  reason: TextAbsenceReason,
): DecisionTextFields => ({
  [DECISION_TEXT_FIELD.ABSTRACT]: absentTextField(reason),
  [DECISION_TEXT_FIELD.HEADNOTE]: absentTextField(reason),
  [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: absentTextField(reason),
  [DECISION_TEXT_FIELD.SUMMARY]: absentTextField(reason),
});

export const presentTextField = (raw: string): TextField => {
  const text = raw.trim();
  if (text.length === 0) {
    return panic("Present decision text must contain text");
  }
  return { type: TEXT_FIELD_TYPE.PRESENT, text };
};

export const SOURCE_ABSENT_TEXT = Object.values(ADAPTER_MANIFESTS).flatMap(
  ({ key: adapter, placeholderPatterns }) =>
    placeholderPatterns.map(({ text }) => ({ adapter, text })),
);

export const absentTextComparison = (text: string): string =>
  text.replaceAll(/\s+/gu, " ").trim();

export const absentTextComparisonsFor = (
  adapter: AdapterKey,
): readonly string[] =>
  SOURCE_ABSENT_TEXT.filter((marker) => marker.adapter === adapter).map(
    ({ text }) => absentTextComparison(text),
  );

export const ADAPTERS_DECLARING_ABSENT_TEXT: readonly AdapterKey[] = [
  ...Object.values(ADAPTER_MANIFESTS)
    .filter(({ placeholderPatterns }) => placeholderPatterns.length > 0)
    .map(({ key }) => key),
];

const COMPARISONS_BY_ADAPTER = new Map<AdapterKey, ReadonlySet<string>>(
  ADAPTERS_DECLARING_ABSENT_TEXT.map((adapter) => [
    adapter,
    new Set(absentTextComparisonsFor(adapter)),
  ]),
);

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Whole values publishers print in a text cell to mean "nothing here". */
const FILLER_TOKENS: ReadonlySet<string> = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "x",
]);

/**
 * Whether a trimmed value is filler rather than prose, whatever the source:
 * nothing but punctuation or symbols, a stock filler token, or one character
 * repeated. Letters and digits of every script count as prose.
 */
const isFillerText = (text: string): boolean => {
  if (!LETTER_OR_DIGIT.test(text)) {
    return true;
  }
  const compact = text.replaceAll(/\s+/gu, "").toLowerCase();
  if (FILLER_TOKENS.has(compact)) {
    return true;
  }
  const [first, ...rest] = compact;
  return rest.length > 0 && rest.every((character) => character === first);
};

export const sourceTextField = (
  adapter: AdapterKey,
  raw: string | null | undefined,
): TextField => {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED);
  }
  if (
    isFillerText(text) ||
    COMPARISONS_BY_ADAPTER.get(adapter)?.has(absentTextComparison(text)) ===
      true
  ) {
    return absentTextField(TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER);
  }
  return presentTextField(text);
};

export const storeTextField = (field: TextField): string | undefined => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.PRESENT:
      return field.text;
    case TEXT_FIELD_TYPE.ABSENT:
      return undefined;
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

const ECLI_ABSENCE_REASON_BY_STATUS = {
  published: undefined,
  not_published: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  not_stated: undefined,
} as const satisfies Record<
  SkUsEcliAvailability["status"],
  TextAbsenceReason | undefined
>;

const SOURCE_URL_ABSENCE_REASON_BY_STATUS = {
  published: undefined,
  "not-published-by-source": TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  "rejected-url": TEXT_ABSENCE_REASON.PARSE_FAILED,
  "detail-unavailable": undefined,
} as const satisfies Record<
  SkCourtsSourceUrlStatus,
  TextAbsenceReason | undefined
>;

const isEcliAvailabilityStatus = (
  status: unknown,
): status is SkUsEcliAvailability["status"] =>
  SK_US_ECLI_AVAILABILITY_STATUSES.some((candidate) => candidate === status);

const isSourceUrlStatus = (
  status: unknown,
): status is SkCourtsSourceUrlStatus =>
  SK_COURTS_SOURCE_URL_STATUSES.some((candidate) => candidate === status);

type StoreDecisionTextFieldsOptions = {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

const checkDecisionTextMetadata = (metadata: Record<string, unknown>): void => {
  for (const key of DECISION_TEXT_METADATA_KEYS) {
    if (Object.hasOwn(metadata, key)) {
      return panic(`Decision text must use the textFields contract: ${key}`);
    }
  }
};

type StoredDecisionMetadataProjectionOptions = {
  type: "stored";
  schema: unknown;
};

const isStoredMetadataProjection = (
  value: unknown,
): value is StoredDecisionMetadataProjectionOptions =>
  isRecord(value) &&
  value["type"] === "stored" &&
  Object.hasOwn(value, "schema");

export function checkedDecisionMetadata<Value extends Record<string, unknown>>(
  metadata: Value,
): Value;
export function checkedDecisionMetadata<Value extends Record<string, unknown>>(
  metadata: Value,
  schema: NoInfer<MetadataUrlSchema<Value>>,
): Record<string, unknown>;
export function checkedDecisionMetadata(
  metadata: Record<string, unknown>,
  options: StoredDecisionMetadataProjectionOptions,
): Record<string, unknown>;
export function checkedDecisionMetadata<Value extends Record<string, unknown>>(
  metadata: Value,
  schema?:
    | NoInfer<MetadataUrlSchema<Value>>
    | StoredDecisionMetadataProjectionOptions,
): Value | Record<string, unknown> {
  checkDecisionTextMetadata(metadata);
  if (isStoredMetadataProjection(schema)) {
    return rehydrateMetadataUrls(metadata, schema.schema);
  }
  if (Object.hasOwn(metadata, META_URL_DIAGNOSTICS)) {
    return panic(
      `Publisher metadata cannot use the reserved key: ${META_URL_DIAGNOSTICS}`,
    );
  }
  return schema === undefined
    ? metadata
    : approveMetadataUrls(metadata, schema);
}

export const storeDecisionTextFields = ({
  metadata,
  textFields,
}: StoreDecisionTextFieldsOptions): Record<string, unknown> => {
  // URL diagnostics are generated before the internal text-field projection;
  // publisher keys are reserved by checkedDecisionMetadata at the producer.
  checkDecisionTextMetadata(metadata);
  // Spreading an index-signature record beside a computed key drops the index
  // signature from the inferred type; the stored row is an open record.
  const stored: Record<string, unknown> = {
    ...metadata,
    [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
      DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  };
  const absent: DecisionTextAbsenceEntry[] = [];
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const field = textFields[key];
    const value = storeTextField(field);
    if (value !== undefined) {
      stored[key] = value;
      continue;
    }
    if (field.type === TEXT_FIELD_TYPE.ABSENT) {
      absent.push({ field: key, reason: field.reason });
    }
  }
  const ecliAvailability = metadata["ecliAvailability"];
  if (ecliAvailability !== undefined) {
    if (
      !isRecord(ecliAvailability) ||
      !isEcliAvailabilityStatus(ecliAvailability["status"])
    ) {
      return panic("ECLI availability must carry a publisher status");
    }
    const reason = ECLI_ABSENCE_REASON_BY_STATUS[ecliAvailability["status"]];
    if (reason !== undefined) {
      absent.push({ field: "ecli", reason });
    }
  }
  const sourceUrlStatus = metadata["sourceUrlStatus"];
  if (sourceUrlStatus !== undefined) {
    if (!isSourceUrlStatus(sourceUrlStatus)) {
      return panic("Unhandled source URL publication status");
    }
    if (
      sourceUrlStatus === "rejected-url" &&
      typeof metadata["statedSourceUrl"] !== "string"
    ) {
      return panic("Rejected publisher URLs must retain their stated value");
    }
    const reason = SOURCE_URL_ABSENCE_REASON_BY_STATUS[sourceUrlStatus];
    if (reason !== undefined) {
      absent.push({ field: "sourceUrl", reason });
    }
  }
  if (absent.length > 0) {
    stored[DECISION_TEXT_ABSENCE_METADATA_KEY] = absent;
  }
  return stored;
};

export const readTextField = (value: unknown): TextField => {
  if (value === null || value === undefined) {
    return absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED);
  }
  return presentTextField(value);
};

/** Publisher classifications stay distinct from publisher prose. */
export const readDecisionKeywords = (value: unknown) => {
  const classification = normalizeDecisionKeywords(value);
  return classification === null
    ? null
    : ({
        type: DECISION_HEADNOTE_KEYWORDS,
        items: classification.items,
        omitted: classification.omitted,
      } as const);
};

type ReadDecisionHeadnoteOptions = {
  /** The publisher's sentence, as the row's SQL read it. */
  headnote: unknown;
  /** Internal presentation budget; the default remains the compact row. */
  maxChars?: number;
  /** The terms they filed the decision under, where they wrote no sentence. */
  keywords: unknown;
};

/**
 * What a row shows above everything else: the publisher's sentence, or — where
 * they wrote none — the terms they filed the decision under, as terms. The two
 * stay apart all the way to the cell, because a row that draws a
 * classification as prose reads a filing card as an argument.
 */
export const readDecisionHeadnote = ({
  headnote,
  keywords,
  maxChars,
}: ReadDecisionHeadnoteOptions): DecisionHeadnotePreview => {
  const field = readTextField(headnote);
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT: {
      const classification = readDecisionKeywords(keywords);
      return classification ?? field;
    }
    case TEXT_FIELD_TYPE.PRESENT: {
      const preview = normalizeDecisionHeadnote(field.text, maxChars);
      return preview === null
        ? absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED)
        : {
            type: TEXT_FIELD_TYPE.PRESENT,
            text: preview.text,
            truncated: preview.truncated,
          };
    }
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

/**
 * The same publisher summary, whole: what a reader asks for when the row's
 * preview stops mid-sentence. Read from the same value the preview is cut
 * from, so the two can never be two different texts.
 */
export const readWholeDecisionHeadnote = (value: unknown): TextField => {
  const field = readTextField(value);
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    case TEXT_FIELD_TYPE.PRESENT: {
      const text = collapseDecisionHeadnote(field.text);
      return text === null
        ? absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED)
        : { type: TEXT_FIELD_TYPE.PRESENT, text };
    }
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

type SplitStoredDecisionTextMetadataResult = {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

export const readStoredDecisionTextAbsence = (
  storedMetadata: Record<string, unknown> | null,
): DecisionTextAbsenceParseResult =>
  parseDecisionTextAbsence(
    storedMetadata?.[DECISION_TEXT_ABSENCE_METADATA_KEY],
  );

type ReadStoredTextFieldOptions = {
  absence: DecisionTextAbsenceParseResult;
  field: DecisionTextFieldKey;
  value: unknown;
};

const readStoredTextField = ({
  absence,
  field,
  value,
}: ReadStoredTextFieldOptions): TextField => {
  if (absence.type === "invalid") {
    return absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED);
  }
  const reason = absence.entries.find((entry) => entry.field === field)?.reason;
  return reason === undefined ? readTextField(value) : absentTextField(reason);
};

export const splitStoredDecisionTextMetadata = (
  storedMetadata: Record<string, unknown>,
): SplitStoredDecisionTextMetadataResult => {
  const absence = readStoredDecisionTextAbsence(storedMetadata);
  const metadata = Object.fromEntries(
    Object.entries(storedMetadata).filter(
      ([key]) =>
        !isDecisionTextFieldKey(key) &&
        key !== DECISION_TEXT_ABSENCE_METADATA_KEY &&
        key !== DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
    ),
  );
  return {
    metadata,
    textFields: {
      [DECISION_TEXT_FIELD.ABSTRACT]: readStoredTextField({
        absence,
        field: DECISION_TEXT_FIELD.ABSTRACT,
        value: storedMetadata[DECISION_TEXT_FIELD.ABSTRACT],
      }),
      [DECISION_TEXT_FIELD.HEADNOTE]: readStoredTextField({
        absence,
        field: DECISION_TEXT_FIELD.HEADNOTE,
        value: storedMetadata[DECISION_TEXT_FIELD.HEADNOTE],
      }),
      [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: readStoredTextField({
        absence,
        field: DECISION_TEXT_FIELD.LEGAL_SENTENCE,
        value: storedMetadata[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
      }),
      [DECISION_TEXT_FIELD.SUMMARY]: readStoredTextField({
        absence,
        field: DECISION_TEXT_FIELD.SUMMARY,
        value: storedMetadata[DECISION_TEXT_FIELD.SUMMARY],
      }),
    },
  };
};

type PreserveStoredTextAfterParseFailureOptions = {
  incomingMetadata: Record<string, unknown>;
  storedMetadata: Record<string, unknown> | null;
  textFields: DecisionTextFields;
};

export const preserveStoredTextAfterParseFailure = ({
  incomingMetadata,
  storedMetadata,
  textFields,
}: PreserveStoredTextAfterParseFailureOptions): Record<string, unknown> => {
  const incoming = splitStoredDecisionTextMetadata(incomingMetadata);
  if (storedMetadata === null) {
    return storeDecisionTextFields({
      metadata: incoming.metadata,
      textFields,
    });
  }
  const stored = splitStoredDecisionTextMetadata(storedMetadata);
  const preserve = (key: DecisionTextFieldKey): TextField => {
    const field = textFields[key];
    return field.type === TEXT_FIELD_TYPE.ABSENT &&
      field.reason === TEXT_ABSENCE_REASON.PARSE_FAILED
      ? stored.textFields[key]
      : field;
  };
  const preserved = storeDecisionTextFields({
    metadata: incoming.metadata,
    textFields: {
      [DECISION_TEXT_FIELD.ABSTRACT]: preserve(DECISION_TEXT_FIELD.ABSTRACT),
      [DECISION_TEXT_FIELD.HEADNOTE]: preserve(DECISION_TEXT_FIELD.HEADNOTE),
      [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: preserve(
        DECISION_TEXT_FIELD.LEGAL_SENTENCE,
      ),
      [DECISION_TEXT_FIELD.SUMMARY]: preserve(DECISION_TEXT_FIELD.SUMMARY),
    },
  });
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const incomingField = textFields[key];
    const storedField = stored.textFields[key];
    if (
      incomingField.type === TEXT_FIELD_TYPE.ABSENT &&
      incomingField.reason === TEXT_ABSENCE_REASON.PARSE_FAILED &&
      storedField.type === TEXT_FIELD_TYPE.ABSENT &&
      storedField.reason === TEXT_ABSENCE_REASON.PARSE_FAILED &&
      Object.hasOwn(storedMetadata, key)
    ) {
      preserved[key] = storedMetadata[key];
    }
  }
  return preserved;
};

export const readDecisionTextMetadata = (
  storedMetadata: Record<string, unknown> | null,
): SplitStoredDecisionTextMetadataResult => {
  const { metadata, textFields } = splitStoredDecisionTextMetadata(
    storedMetadata ?? {},
  );
  return {
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(([key]) => key !== META_URL_DIAGNOSTICS),
    ),
    textFields,
  };
};
