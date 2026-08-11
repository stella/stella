/**
 * Extract plain-text content from a DOCX for AI context, annotated with block
 * directive metadata. Markdown extraction now lives in `@stll/folio-core`
 * (`docxToMarkdown`), which owns the DOCX parser and its full fidelity.
 */

import { panic } from "better-result";

import {
  extractDocxText,
  type ExtractedDocxParagraph,
} from "@stll/folio-core/server";
import type { BlockDirectiveKind } from "@stll/template-conditions";

import type { ExtractedDocument, ExtractedParagraph, FieldMeta } from "./types";

// ── Directive detection ─────────────────────────────────

/**
 * Matches a block directive as the sole paragraph content.
 * Intentionally duplicated from block-directives.ts: the two
 * modules serve different purposes and should not depend on
 * each other.
 */
const DIRECTIVE_RE =
  /^\s*\{\{(?<tag>#if|#elseif|#else|#each|\/if|\/each)(?<expr>[^{}]*)\}\}\s*$/u;

const DIRECTIVE_KIND_MAP: Record<string, BlockDirectiveKind> = {
  "#if": "if",
  "#elseif": "elseif",
  "#else": "else",
  "#each": "each",
  "/if": "endif",
  "/each": "endeach",
};

const directiveCandidate = ({
  tableRow,
  text,
}: ExtractedDocxParagraph): string => {
  if (tableRow?.kind !== "cells") {
    return text;
  }

  // Folio renders a source table row as `| cell | cell |`. Removing only the
  // two outer delimiters lets a sole-cell directive retain its semantics;
  // internal delimiters remain, so mixed-content rows cannot become blocks.
  return text.startsWith("|") && text.endsWith("|")
    ? text.slice(1, -1).trim()
    : text;
};

const FOLIO_TABLE_ROW_PREFIX = "| ";
const FOLIO_TABLE_ROW_SUFFIX = " |";
const FOLIO_TABLE_CELL_SEPARATOR = " | ";
const FOLIO_TABLE_PARAGRAPH_SEPARATOR = "<br>";
const FOLIO_ESCAPED_TABLE_PIPE = "&#124;";

const restoreTableCellParagraphs = (
  paragraph: ExtractedDocxParagraph,
): ExtractedDocxParagraph[] => {
  const kind = paragraph.tableRow?.kind;
  if (kind === undefined) {
    return [paragraph];
  }

  switch (kind) {
    case "syntheticHeader":
    case "delimiter":
      return [];
    case "cells": {
      if (
        !paragraph.text.startsWith(FOLIO_TABLE_ROW_PREFIX) ||
        !paragraph.text.endsWith(FOLIO_TABLE_ROW_SUFFIX)
      ) {
        return panic("Folio table row does not match its serialized contract");
      }

      const cells = paragraph.text
        .slice(FOLIO_TABLE_ROW_PREFIX.length, -FOLIO_TABLE_ROW_SUFFIX.length)
        .split(FOLIO_TABLE_CELL_SEPARATOR);
      return cells.flatMap((cell) =>
        cell.split(FOLIO_TABLE_PARAGRAPH_SEPARATOR).map((text) => ({
          index: paragraph.index,
          source: paragraph.source,
          text: text.replaceAll(FOLIO_ESCAPED_TABLE_PIPE, "|"),
        })),
      );
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
};

// ── Public API ───────────────────────────────────────────

const annotateDirective = (
  extractedParagraph: ExtractedDocxParagraph,
): ExtractedParagraph => {
  const paragraph: ExtractedParagraph = { ...extractedParagraph };
  const directiveMatch = DIRECTIVE_RE.exec(
    directiveCandidate(extractedParagraph),
  );
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

export const extractTextForPreview = async (
  docxBytes: Uint8Array,
): Promise<ExtractedDocument> => {
  const result = await extractDocxText(docxBytes);
  const paragraphs = result.paragraphs
    .flatMap(restoreTableCellParagraphs)
    .map((paragraph, index) => annotateDirective({ ...paragraph, index }));
  return {
    paragraphs,
    charCount: paragraphs.reduce(
      (count, paragraph) => count + paragraph.text.length,
      0,
    ),
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
