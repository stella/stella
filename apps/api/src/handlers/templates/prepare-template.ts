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
import { HEADER_FOOTER_RE } from "@/api/handlers/docx/ooxml";
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
  if (!zip.file(DOCUMENT_PATH)) {
    return { buffer, fields: [], unapplied: suggestions };
  }

  // Rewrite the body and every header/footer part, matching the parts the rest
  // of the pipeline covers (discoverPlaceholders / fillTemplateWithValues filter
  // on `word/document.xml` || HEADER_FOOTER_RE). A literal that the model read
  // from a letterhead or footer (extractText concatenates headers, body, and
  // footers into the prompt) is then rewritten where it actually lives.
  const partNames = [
    DOCUMENT_PATH,
    ...Object.keys(zip.files).filter((name) => HEADER_FOOTER_RE.test(name)),
  ];

  // Merge results across parts: a field is added once per path, and a
  // suggestion is reported unapplied only when no part matched it. Running
  // applyFieldSuggestions once per part (instead of mutating it to take many)
  // keeps that low-level function single-part; each part marks a body-only
  // literal as unapplied, so the global unapplied set is the intersection.
  const fields: FieldMeta[] = [];
  const seenPaths = new Set<string>();
  // Object identity is stable: applyFieldSuggestions pushes the same suggestion
  // references we pass in, so a Set of objects tracks per-part application.
  let stillUnapplied: Set<FieldSuggestion> | undefined;

  for (const partName of partNames) {
    const entry = zip.file(partName);
    if (!entry) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- sequential: each part folds into the shared fields/seenPaths/stillUnapplied accumulators across parts
    const partXml = await entry.async("text");
    const result = applyFieldSuggestions(partXml, suggestions);
    if (result.xml !== partXml) {
      zip.file(partName, result.xml);
    }
    for (const field of result.fields) {
      if (!seenPaths.has(field.path)) {
        seenPaths.add(field.path);
        fields.push(field);
      }
    }
    const partUnapplied = new Set(result.unapplied);
    if (stillUnapplied === undefined) {
      stillUnapplied = partUnapplied;
    } else {
      for (const suggestion of stillUnapplied) {
        if (!partUnapplied.has(suggestion)) {
          stillUnapplied.delete(suggestion);
        }
      }
    }
  }

  const unapplied = stillUnapplied ? [...stillUnapplied] : [];

  const rewritten = Buffer.from(
    await zip.generateAsync({ type: "nodebuffer" }),
  );

  const withManifest = await writeManifest(rewritten, {
    version: 1,
    fields,
  });

  return { buffer: withManifest, fields, unapplied };
};
