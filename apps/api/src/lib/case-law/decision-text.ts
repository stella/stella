import { panic } from "better-result";

import {
  DECISION_TEXT_FIELD,
  DECISION_TEXT_FIELD_KEYS,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
  type DecisionTextFieldKey,
  type ReadDecisionTextFields,
  type TextAbsenceReason,
  type TextField,
} from "@stll/api-contract/case-law-text-field";

import { normalizeDecisionHeadnote } from "@/api/lib/case-law/decision-headnote";
import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import type { AdapterKey } from "@/api/lib/legal-search/ingestion-constants";

export {
  DECISION_TEXT_FIELD,
  DECISION_TEXT_FIELD_KEYS,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
  TEXT_FIELD_TYPE,
};
export type {
  DecisionTextFieldKey,
  ReadDecisionTextFields,
  TextAbsenceReason,
  TextField,
};

export type DecisionTextFields = ReadDecisionTextFields;

const DECISION_TEXT_FIELD_KEY_SET = new Set<string>(DECISION_TEXT_FIELD_KEYS);

export const isDecisionTextFieldKey = (
  key: string,
): key is DecisionTextFieldKey => DECISION_TEXT_FIELD_KEY_SET.has(key);

export const absentTextField = (reason: TextAbsenceReason): TextField => ({
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

type StoreDecisionTextFieldsOptions = {
  metadata: Record<string, unknown>;
  textFields: DecisionTextFields;
};

export const checkedDecisionMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  for (const key of DECISION_TEXT_FIELD_KEYS) {
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
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const field = textFields[key];
    const value = storeTextField(field);
    if (value !== undefined) {
      stored[key] = value;
    }
  }
  return stored;
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
  const merged = { ...incomingMetadata };
  if (storedMetadata === null) {
    return merged;
  }
  for (const key of DECISION_TEXT_FIELD_KEYS) {
    const field = textFields[key];
    if (
      field.type !== TEXT_FIELD_TYPE.ABSENT ||
      field.reason !== TEXT_ABSENCE_REASON.PARSE_FAILED ||
      !Object.hasOwn(storedMetadata, key)
    ) {
      continue;
    }
    merged[key] = storedMetadata[key];
  }
  return merged;
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

export const readDecisionHeadnote = (value: unknown): TextField => {
  const field = readTextField(value);
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return field;
    case TEXT_FIELD_TYPE.PRESENT: {
      const text = normalizeDecisionHeadnote(field.text);
      return text === null
        ? absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED)
        : presentTextField(text);
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

export const splitStoredDecisionTextMetadata = (
  storedMetadata: Record<string, unknown>,
): SplitStoredDecisionTextMetadataResult => {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(storedMetadata)) {
    if (isDecisionTextFieldKey(key)) {
      continue;
    }
    metadata[key] = value;
  }
  return {
    metadata,
    textFields: {
      [DECISION_TEXT_FIELD.ABSTRACT]: readTextField(
        storedMetadata[DECISION_TEXT_FIELD.ABSTRACT],
      ),
      [DECISION_TEXT_FIELD.HEADNOTE]: readTextField(
        storedMetadata[DECISION_TEXT_FIELD.HEADNOTE],
      ),
      [DECISION_TEXT_FIELD.LEGAL_SENTENCE]: readTextField(
        storedMetadata[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
      ),
      [DECISION_TEXT_FIELD.SUMMARY]: readTextField(
        storedMetadata[DECISION_TEXT_FIELD.SUMMARY],
      ),
    },
  };
};

export const readDecisionTextMetadata = (
  storedMetadata: Record<string, unknown> | null,
): SplitStoredDecisionTextMetadataResult =>
  splitStoredDecisionTextMetadata(storedMetadata ?? {});
