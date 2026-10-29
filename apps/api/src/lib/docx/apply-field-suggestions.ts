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

import { Result } from "better-result";

import {
  replaceXmlElements,
  type XmlScanError,
} from "@/api/lib/files/xml-scan";

import type { FieldMeta, InputType } from "./types";

export type FieldSuggestion = {
  /** Exact document text to replace (as the model read it, unescaped). */
  literalText: string;
  /** Target field path, e.g. "company.name" or "signatory.role". */
  fieldPath: string;
  inputType?: InputType | undefined;
  /** Suggested user-facing label for the fill form. */
  label?: string | undefined;
  /** A realistic example of the value, for previews. Never inserted. */
  exampleValue?: string | undefined;
  /** When set, the field becomes AI-fillable (drafted at fill time). */
  aiPrompt?: string | undefined;
};

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/** Replace `literal` with `replacement` only inside `<w:t>` text content. */
const replaceInTextNodes = (
  xml: string,
  literal: string,
  replacement: string,
): Result<string, XmlScanError> => {
  const escapedLiteral = escapeXml(literal);
  if (escapedLiteral.length === 0) {
    return Result.ok(xml);
  }
  return replaceXmlElements(xml, "w:t", (match, content) =>
    match.selfClosing
      ? match.openTag
      : match.openTag +
        content.split(escapedLiteral).join(escapeXml(replacement)) +
        match.closeTag,
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
): Result<ApplyFieldSuggestionsResult, XmlScanError> => {
  let xml = docXml;

  // Replace longest literals first so a shorter literal cannot match inside a
  // longer one, but record only which suggestions actually matched — the
  // emitted fields/unapplied keep document (original) order below.
  const applied = new Set<FieldSuggestion>();
  for (const suggestion of suggestions.toSorted(
    (a, b) => b.literalText.length - a.literalText.length,
  )) {
    if (!suggestion.literalText || !suggestion.fieldPath) {
      continue;
    }
    const before = xml;
    const replaced = replaceInTextNodes(
      xml,
      suggestion.literalText,
      `{{${suggestion.fieldPath}}}`,
    );
    if (replaced.isErr()) {
      return replaced;
    }
    xml = replaced.value;
    if (xml !== before) {
      applied.add(suggestion);
    }
  }

  const fields: FieldMeta[] = [];
  const seenPaths = new Set<string>();
  const unapplied: FieldSuggestion[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.literalText || !suggestion.fieldPath) {
      continue;
    }
    if (!applied.has(suggestion)) {
      unapplied.push(suggestion);
      continue;
    }
    if (!seenPaths.has(suggestion.fieldPath)) {
      seenPaths.add(suggestion.fieldPath);
      const field: FieldMeta = { path: suggestion.fieldPath };
      if (suggestion.inputType) {
        field.inputType = suggestion.inputType;
      }
      if (suggestion.label) {
        field.label = suggestion.label;
      }
      if (suggestion.aiPrompt) {
        field.aiPrompt = suggestion.aiPrompt;
      }
      fields.push(field);
    }
  }

  return Result.ok({ xml, fields, unapplied });
};
