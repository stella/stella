/**
 * Convert a RichPatchValue into a docx IPatch.
 *
 * - `string` → ParagraphPatch with a single TextRun
 * - `{ paragraphs: [single] }` → ParagraphPatch with formatted
 *   TextRun children (preserves the host paragraph's style)
 * - `{ paragraphs: [multiple] }` → DocumentPatch with full
 *   Paragraph objects (replaces the host paragraph entirely)
 */

import { Paragraph, PatchType, TextRun } from "docx";
import type { IPatch } from "docx";

import type { RichPatchValue } from "./types";

const runsToTextRuns = (
  runs: { text: string; bold?: boolean; italic?: boolean }[],
): TextRun[] =>
  runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
      }),
  );

export const buildPatch = (value: RichPatchValue): IPatch => {
  if (typeof value === "string") {
    return {
      type: PatchType.PARAGRAPH,
      children: [new TextRun(value)],
    };
  }

  // Empty or single paragraph: use PARAGRAPH patch to preserve
  // the host paragraph's style, numbering, and indentation.
  if (value.paragraphs.length <= 1) {
    return {
      type: PatchType.PARAGRAPH,
      children:
        value.paragraphs.length === 1
          ? runsToTextRuns(value.paragraphs[0].runs)
          : [],
    };
  }

  // Multiple paragraphs: must use DOCUMENT patch, which
  // replaces the host paragraph entirely.
  return {
    type: PatchType.DOCUMENT,
    children: value.paragraphs.map(
      (para) =>
        new Paragraph({
          children: runsToTextRuns(para.runs),
        }),
    ),
  };
};
