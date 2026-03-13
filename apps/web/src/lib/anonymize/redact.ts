import type { Entity, RedactionResult } from "./types";

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
 * same placeholder (e.g., "Dr. Müller" and "Dr.  Müller"
 * both become [PERSON_1]).
 *
 * Placeholder format: [LABEL_N] where LABEL is uppercase
 * and N is a 1-based counter per label.
 */
const buildPlaceholderMap = (entities: Entity[]): Map<string, string> => {
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
 * confirmed entity span with a stable placeholder.
 *
 * Co-references are consistent: if the same text appears
 * multiple times, all occurrences get the same placeholder.
 */
export const redactText = (
  fullText: string,
  entities: Entity[],
): RedactionResult => {
  if (entities.length === 0) {
    return {
      redactedText: fullText,
      redactionMap: new Map(),
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
  let cursor = 0;

  for (const entity of nonOverlapping) {
    if (entity.start > cursor) {
      parts.push(fullText.slice(cursor, entity.start));
    }

    const placeholder =
      placeholderMap.get(`${entity.label}\0${entity.text}`) ??
      `[${entity.label.toUpperCase().replace(/\s+/g, "_")}]`;
    parts.push(placeholder);
    cursor = entity.end;
  }

  if (cursor < fullText.length) {
    parts.push(fullText.slice(cursor));
  }

  // Build reverse map: placeholder -> original text (first-seen wins)
  const redactionMap = new Map<string, string>();
  for (const [compositeKey, placeholder] of placeholderMap) {
    if (!redactionMap.has(placeholder)) {
      const originalText = compositeKey.slice(compositeKey.indexOf("\0") + 1);
      redactionMap.set(placeholder, originalText);
    }
  }

  return {
    redactedText: parts.join(""),
    redactionMap,
    entityCount: nonOverlapping.length,
  };
};

/**
 * Serialize the redaction key to JSON for export.
 * This enables authorised de-anonymisation.
 */
export const exportRedactionKey = (
  redactionMap: Map<string, string>,
): string => {
  const entries = Object.fromEntries(redactionMap);
  return JSON.stringify(entries, null, 2);
};

/**
 * De-anonymise text using a redaction key.
 * Replaces placeholders back with original values.
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
