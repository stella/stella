import {
  DEFAULT_OPERATOR_CONFIG,
  OPERATOR_REGISTRY,
  resolveOperator,
} from "./operators";
import type {
  Entity,
  OperatorConfig,
  OperatorType,
  RedactionResult,
} from "./types";

const WHITESPACE_RE = /\s+/g;
const PHONE_NOISE_RE = /[()\s-]/g;
const SPACE_DASH_RE = /[\s-]/g;

/**
 * Normalize entity text so that surface-form variations
 * of the same real-world value map to a single canonical
 * key. Lowercased emails, stripped phone formatting, etc.
 */
const normalizeEntityText = (label: string, text: string): string => {
  const upper = label.toUpperCase().replace(WHITESPACE_RE, "_");

  if (upper === "EMAIL_ADDRESS" || upper === "EMAIL") {
    return text.toLowerCase().trim();
  }
  if (upper === "PHONE_NUMBER" || upper === "PHONE") {
    return text.replace(PHONE_NOISE_RE, "");
  }
  if (
    upper === "IBAN" ||
    upper === "BANK_ACCOUNT_NUMBER" ||
    upper === "TAX_IDENTIFICATION_NUMBER" ||
    upper === "REGISTRATION_NUMBER"
  ) {
    return text.replace(SPACE_DASH_RE, "").toUpperCase();
  }
  if (upper === "PERSON" || upper === "ORGANIZATION" || upper === "ADDRESS") {
    return text.replace(WHITESPACE_RE, " ").toLowerCase().trim();
  }
  return text.trim();
};

/**
 * Build a stable mapping from entity text to numbered
 * placeholders. Same real-world value always maps to the
 * same placeholder (e.g., "Dr. Muller" and "Dr.  Muller"
 * both become [PERSON_1]).
 *
 * Placeholder format: [LABEL_N] where LABEL is uppercase
 * and N is a 1-based counter per label.
 */
export const buildPlaceholderMap = (
  entities: Entity[],
): Map<string, string> => {
  const counters = new Map<string, number>();
  const textLabelToPlaceholder = new Map<string, string>();
  const normalizedToPlaceholder = new Map<string, string>();

  const sorted = entities.toSorted((a, b) => a.start - b.start);

  for (const entity of sorted) {
    const compositeKey = `${entity.label}\0${entity.text}`;
    if (textLabelToPlaceholder.has(compositeKey)) {
      continue;
    }

    const labelKey = entity.label.toUpperCase().replace(WHITESPACE_RE, "_");
    const normalized = normalizeEntityText(entity.label, entity.text);
    const normalizedKey = `${labelKey}\0${normalized}`;
    const existing = normalizedToPlaceholder.get(normalizedKey);
    if (existing) {
      textLabelToPlaceholder.set(compositeKey, existing);
      continue;
    }

    const count = (counters.get(labelKey) ?? 0) + 1;
    counters.set(labelKey, count);

    const placeholder = `[${labelKey}_${count}]`;
    textLabelToPlaceholder.set(compositeKey, placeholder);
    normalizedToPlaceholder.set(normalizedKey, placeholder);
  }

  return textLabelToPlaceholder;
};

/**
 * Apply redactions to the source text, replacing each
 * confirmed entity span using the configured operator.
 *
 * Co-references are consistent: if the same text appears
 * multiple times, all occurrences get the same placeholder.
 */
export const redactText = (
  fullText: string,
  entities: Entity[],
  config: OperatorConfig = DEFAULT_OPERATOR_CONFIG,
): RedactionResult => {
  if (entities.length === 0) {
    return {
      redactedText: fullText,
      redactionMap: new Map(),
      operatorMap: new Map(),
      entityCount: 0,
    };
  }

  const placeholderMap = buildPlaceholderMap(entities);

  const sorted = entities.toSorted((a, b) => a.start - b.start);

  // Remove overlapping spans (keep first occurrence)
  const nonOverlapping: Entity[] = [];
  let lastEnd = 0;
  for (const entity of sorted) {
    if (entity.start >= lastEnd) {
      nonOverlapping.push(entity);
      lastEnd = entity.end;
    }
  }

  const parts: string[] = [];
  const redactionMap = new Map<string, string>();
  const operatorMap = new Map<string, OperatorType>();
  let cursor = 0;

  for (const entity of nonOverlapping) {
    if (entity.start > cursor) {
      parts.push(fullText.slice(cursor, entity.start));
    }

    const placeholder =
      placeholderMap.get(`${entity.label}\0${entity.text}`) ??
      `[${entity.label.toUpperCase().replace(/\s+/g, "_")}]`;

    const opType = resolveOperator(config, entity.label);
    const operator = OPERATOR_REGISTRY[opType];

    const replacement = operator.apply(
      entity.text,
      entity.label,
      placeholder,
      config.redactString,
    );

    parts.push(replacement);
    // operatorMap is keyed by the conceptual placeholder
    // ([LABEL_N]), not by the replacement text. For "redact"
    // operators the placeholder never appears in the output;
    // the map is only consulted via exportRedactionKey which
    // iterates redactionMap (replace entries only).
    operatorMap.set(placeholder, opType);

    // Only populate redactionMap for reversible operators
    if (
      operator.reversibility === "reversible" &&
      !redactionMap.has(placeholder)
    ) {
      redactionMap.set(placeholder, entity.text);
    }

    cursor = entity.end;
  }

  if (cursor < fullText.length) {
    parts.push(fullText.slice(cursor));
  }

  return {
    redactedText: parts.join(""),
    redactionMap,
    operatorMap,
    entityCount: nonOverlapping.length,
  };
};

/**
 * Serialize the redaction key to JSON for export.
 * Includes operator metadata so the export is self-describing.
 */
export const exportRedactionKey = (
  redactionMap: Map<string, string>,
  operatorMap: Map<string, OperatorType>,
): string => {
  const entries: Record<string, { original: string; operator: OperatorType }> =
    {};

  for (const [placeholder, value] of redactionMap) {
    entries[placeholder] = {
      original: value,
      operator: operatorMap.get(placeholder) ?? "replace",
    };
  }

  return JSON.stringify({ entries }, null, 2);
};

/**
 * De-anonymise text using a redaction key.
 * Replaces placeholders back with original values.
 * Only works for reversible operators (replace).
 */
export const deanonymise = (
  redactedText: string,
  redactionMap: Map<string, string>,
): string => {
  let result = redactedText;

  for (const [placeholder, original] of redactionMap) {
    result = result.replaceAll(placeholder, original);
  }

  return result;
};
