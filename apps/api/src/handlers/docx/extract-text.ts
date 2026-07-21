/**
 * Extract plain-text content from a DOCX for AI context, annotated with block
 * directive metadata. Markdown extraction now lives in `@stll/folio-core`
 * (`docxToMarkdown`), which owns the DOCX parser and its full fidelity.
 */

import {
  extractDocxText,
  type ExtractedDocxParagraph,
} from "@stll/folio-core/server";

import type {
  BlockDirectiveKind,
  ExtractedDocument,
  ExtractedParagraph,
  FieldMeta,
} from "./types";

// ── Directive detection ─────────────────────────────────

/**
 * Matches a block directive as the sole paragraph content.
 * Intentionally duplicated from block-directives.ts: the two
 * modules serve different purposes and should not depend on
 * each other.
 */
const DIRECTIVE_RE =
  /^\s*\{\{(?<tag>#if|#elseif|#else|#each|\/if|\/each)\s*(?<expr>.*?)\}\}\s*$/u;

const DIRECTIVE_KIND_MAP: Record<string, BlockDirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "#each": "each",
  "/if": "endif",
  "/each": "endeach",
};

// ── Public API ───────────────────────────────────────────

const annotateDirective = ({
  index,
  text,
  source,
  style,
  bold,
  fontSize,
  alignment,
}: ExtractedDocxParagraph): ExtractedParagraph => {
  const paragraph: ExtractedParagraph = { index, text, source };
  if (style !== undefined) {
    paragraph.style = style;
  }
  if (bold !== undefined) {
    paragraph.bold = bold;
  }
  if (fontSize !== undefined) {
    paragraph.fontSize = fontSize;
  }
  if (alignment !== undefined) {
    paragraph.alignment = alignment;
  }

  const directiveMatch = DIRECTIVE_RE.exec(text);
  if (!directiveMatch) {
    return paragraph;
  }

  paragraph.isDirective = true;
  const tag = directiveMatch.groups?.["tag"];
  const expression = directiveMatch.groups?.["expr"];
  if (tag !== undefined) {
    paragraph.directiveKind = DIRECTIVE_KIND_MAP[tag];
  }
  if (expression !== undefined) {
    paragraph.directiveExpression = expression.trim();
  }
  return paragraph;
};

export const extractText = async (
  docxBytes: Uint8Array,
): Promise<ExtractedDocument> => {
  const result = await extractDocxText(docxBytes);
  return {
    paragraphs: result.paragraphs.map(annotateDirective),
    charCount: result.charCount,
    view: result.view,
  };
};

/**
 * Rendered document body for AI-draft fields that opted into seeing it
 * ({@link FieldMeta.aiSeesDocument}). Returns `undefined` — and skips the
 * extraction entirely — when no AI-draft field opted in, so the generator
 * prompt and token cost stay unchanged for non-opted templates.
 */
export const documentTextForAiFields = async (
  docxBytes: Uint8Array,
  fields: readonly FieldMeta[],
): Promise<string | undefined> => {
  const wantsDocumentText = fields.some(
    (field) =>
      field.aiPrompt !== undefined &&
      field.aiPrompt !== "" &&
      field.aiSeesDocument === true,
  );
  if (!wantsDocumentText) {
    return undefined;
  }
  const { paragraphs } = await extractText(docxBytes);
  return paragraphs.map((paragraph) => paragraph.text).join("\n");
};
