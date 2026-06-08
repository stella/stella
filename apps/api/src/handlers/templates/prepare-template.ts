/**
 * AI template preparation: turn a finished document into a template.
 *
 * Ask the injected suggester which literal values should become fields, rewrite
 * those literals as `{{markers}}` in the document body, and embed a manifest of
 * the resulting fields (including AI-fillable ones). Pure aside from the
 * injected `suggest` (the model call), so the assembly is unit-testable with a
 * stub. The model half lives in suggest-template-fields.ts; the deterministic
 * rewrite in apply-field-suggestions.ts.
 */

import JSZip from "jszip";

import {
  applyFieldSuggestions,
  type FieldSuggestion,
} from "@/api/handlers/docx/apply-field-suggestions";
import { extractText } from "@/api/handlers/docx/extract-text";
import { writeManifest } from "@/api/handlers/docx/template-manifest";
import type { FieldMeta } from "@/api/handlers/docx/types";

const DOCUMENT_PATH = "word/document.xml";

export type SuggestFields = (
  documentText: string,
) => Promise<FieldSuggestion[]>;

export type PrepareTemplateResult = {
  /** The prepared docx: literals rewritten as markers, manifest embedded. */
  buffer: Buffer;
  fields: FieldMeta[];
  /** Suggestions whose literal text spanned runs and could not be applied. */
  unapplied: FieldSuggestion[];
};

export const prepareTemplateFromDocument = async ({
  buffer,
  suggest,
}: {
  buffer: Buffer;
  suggest: SuggestFields;
}): Promise<PrepareTemplateResult> => {
  const { paragraphs } = await extractText(buffer);
  const documentText = paragraphs.map((paragraph) => paragraph.text).join("\n");

  const suggestions = await suggest(documentText);
  if (suggestions.length === 0) {
    return { buffer, fields: [], unapplied: [] };
  }

  const zip = await JSZip.loadAsync(buffer);
  const entry = zip.file(DOCUMENT_PATH);
  if (!entry) {
    return { buffer, fields: [], unapplied: suggestions };
  }

  const docXml = await entry.async("text");
  const { xml, fields, unapplied } = applyFieldSuggestions(docXml, suggestions);
  zip.file(DOCUMENT_PATH, xml);
  const rewritten = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer" }),
  );

  const withManifest = await writeManifest(rewritten, {
    version: 1,
    fields,
    conditions: [],
  });

  return { buffer: withManifest, fields, unapplied };
};
