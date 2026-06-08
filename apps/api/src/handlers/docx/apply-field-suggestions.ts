/**
 * Turn a (typically already-filled) document into a template by applying
 * AI-suggested field mappings: each suggestion replaces a literal span of
 * document text with a `{{fieldPath}}` marker and contributes a manifest
 * field. This is the deterministic half of "AI template preparation" — a
 * model produces the `FieldSuggestion[]` (which value is which field), and
 * this pure function applies them and emits the manifest fields.
 *
 * Scope: replacements operate on `<w:t>` text-node contents only (never tags
 * or attributes), and a literal must lie within a single run to be replaced —
 * the common case for atomic values (names, dates, registration numbers). A
 * literal split across runs by Word is left untouched; the caller can report
 * it as unmapped.
 */

import type { FieldMeta, InputType } from "./types";

export type FieldSuggestion = {
  /** Exact document text to replace (as the model read it, unescaped). */
  literalText: string;
  /** Target field path, e.g. "company.name" or "signatory.role". */
  fieldPath: string;
  inputType?: InputType | undefined;
  /** When set, the field becomes AI-fillable (drafted at fill time). */
  aiPrompt?: string | undefined;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const W_T_RE = /(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/gu;

/** Replace `literal` with `replacement` only inside `<w:t>` text content. */
const replaceInTextNodes = (
  xml: string,
  literal: string,
  replacement: string,
): string => {
  const escapedLiteral = escapeXml(literal);
  if (escapedLiteral.length === 0) {
    return xml;
  }
  return xml.replace(
    W_T_RE,
    (_match, open: string, content: string, close: string) =>
      open + content.split(escapedLiteral).join(escapeXml(replacement)) + close,
  );
};

export type ApplyFieldSuggestionsResult = {
  xml: string;
  fields: FieldMeta[];
  /** Suggestions whose literal text was not found in any single text run. */
  unapplied: FieldSuggestion[];
};

export const applyFieldSuggestions = (
  docXml: string,
  suggestions: readonly FieldSuggestion[],
): ApplyFieldSuggestionsResult => {
  let xml = docXml;
  const fields: FieldMeta[] = [];
  const seenPaths = new Set<string>();
  const unapplied: FieldSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (!suggestion.literalText || !suggestion.fieldPath) {
      continue;
    }

    const before = xml;
    xml = replaceInTextNodes(
      xml,
      suggestion.literalText,
      `{{${suggestion.fieldPath}}}`,
    );
    if (xml === before) {
      unapplied.push(suggestion);
      continue;
    }

    if (!seenPaths.has(suggestion.fieldPath)) {
      seenPaths.add(suggestion.fieldPath);
      const field: FieldMeta = { path: suggestion.fieldPath };
      if (suggestion.inputType) {
        field.inputType = suggestion.inputType;
      }
      if (suggestion.aiPrompt) {
        field.aiPrompt = suggestion.aiPrompt;
      }
      fields.push(field);
    }
  }

  return { xml, fields, unapplied };
};
