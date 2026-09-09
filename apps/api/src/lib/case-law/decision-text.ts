import { panic } from "better-result";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_FIELD,
  DECISION_TEXT_FIELD_KEYS,
  DECISION_TEXT_METADATA_KEYS,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
  type DecisionHeadnotePreview,
  type DecisionTextFieldKey,
  type ReadDecisionTextFields,
  type TextAbsenceReason,
  type TextField,
} from "@stll/api-contract/case-law-text-field";

import { normalizeDecisionHeadnote } from "@/api/lib/case-law/decision-headnote";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";
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

export const sourceTextField = (
  adapter: AdapterKey,
  raw: string | null | undefined,
): TextField => {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return absentTextField(TEXT_ABSENCE_REASON.NOT_PUBLISHED);
  }
  if (
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

type StoredTextAbsenceReason = Exclude<
  TextAbsenceReason,
  typeof TEXT_ABSENCE_REASON.NOT_PUBLISHED
>;

type StoredTextAbsence = {
  readonly field: DecisionTextFieldKey;
  readonly reason: StoredTextAbsenceReason;
};

const isStoredTextAbsenceReason = (
  reason: unknown,
): reason is StoredTextAbsenceReason =>
  typeof reason === "string" &&
  TEXT_ABSENCE_REASONS.some((candidate) => candidate === reason) &&
  reason !== TEXT_ABSENCE_REASON.NOT_PUBLISHED;

type StoreDecisionTextFieldsOptions = {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

export const checkedDecisionMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  for (const key of DECISION_TEXT_METADATA_KEYS) {
    if (Object.hasOwn(metadata, key)) {
      return panic(`Decision text must use the textFields contract: ${key}`);
    }
  }
  return metadata;
};

export const storeDecisionTextFields = ({
  metadata,
  textFields,
}: StoreDecisionTextFieldsOptions): Record<string, unknown> => {
  const stored = { ...checkedDecisionMetadata(metadata) };
  const absent: StoredTextAbsence[] = [];
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const field = textFields[key];
    const value = storeTextField(field);
    if (value !== undefined) {
      stored[key] = value;
      continue;
    }
    if (
      field.type === TEXT_FIELD_TYPE.ABSENT &&
      isStoredTextAbsenceReason(field.reason)
    ) {
      absent.push({ field: key, reason: field.reason });
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

export const readDecisionHeadnote = (
  value: unknown,
): DecisionHeadnotePreview => {
  const field = readTextField(value);
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    case TEXT_FIELD_TYPE.PRESENT: {
      const preview = normalizeDecisionHeadnote(field.text);
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

type SplitStoredDecisionTextMetadataResult = {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

type StoredTextAbsenceParseResult =
  | { readonly type: "invalid" }
  | { readonly type: "valid"; readonly entries: readonly StoredTextAbsence[] };

const parseStoredTextAbsence = (
  value: unknown,
): StoredTextAbsenceParseResult => {
  if (value === undefined) {
    return { type: "valid", entries: [] };
  }
  if (!Array.isArray(value)) {
    return { type: "invalid" };
  }
  const entries: StoredTextAbsence[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || Object.keys(entry).length !== 2) {
      return { type: "invalid" };
    }
    const field = entry["field"];
    const reason = entry["reason"];
    if (
      typeof field !== "string" ||
      !isDecisionTextFieldKey(field) ||
      !isStoredTextAbsenceReason(reason) ||
      entries.some((candidate) => candidate.field === field)
    ) {
      return { type: "invalid" };
    }
    entries.push({ field, reason });
  }
  return { type: "valid", entries };
};

export const readStoredDecisionTextAbsence = (
  storedMetadata: Record<string, unknown> | null,
): StoredTextAbsenceParseResult =>
  parseStoredTextAbsence(storedMetadata?.[DECISION_TEXT_ABSENCE_METADATA_KEY]);

type ReadStoredTextFieldOptions = {
  absence: StoredTextAbsenceParseResult;
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
        key !== DECISION_TEXT_ABSENCE_METADATA_KEY,
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
): SplitStoredDecisionTextMetadataResult =>
  splitStoredDecisionTextMetadata(storedMetadata ?? {});
