/**
 * Fallback DOCX styles for when no template is provided.
 *
 * The template's styles.xml (injected via surgery) supplies the
 * cascade styles, TitleNoSubheading, A0, A1, etc. These fallback
 * styles are a safety net for when `markdownToDocx` is called
 * without a template path.
 *
 * Future: TemplateAnalyzer will extract styles from user-uploaded
 * DOCX files and produce this config dynamically.
 */

import { AlignmentType } from "docx";
import type { IStylesOptions } from "docx";

const FONT = "Arial";
const FONT_SIZE_PT = 10;
const FONT_SIZE = FONT_SIZE_PT * 2; // half-points
const TITLE_SIZE = 14 * 2;
const BODY_AFTER_PT = 6;
const BODY_AFTER = BODY_AFTER_PT * 20; // twips

const INDENT_STEP_PT = 28.35;
const INDENT_STEP = Math.round(INDENT_STEP_PT * 20);

/** Indent in twips for bullet/list items. */
export const BULLET_INDENT = INDENT_STEP;
export const BULLET_HANGING = Math.round(11 * 20);

export const stylesConfig: IStylesOptions = {
  default: {
    document: {
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: BODY_AFTER },
      },
    },
  },
  paragraphStyles: [
    {
      id: "TitleNoSubheading",
      name: "Title (No Subheading)",
      basedOn: "Normal",
      next: "A0",
      run: { font: FONT, size: TITLE_SIZE, bold: true },
      paragraph: {
        alignment: AlignmentType.CENTER,
        spacing: { after: BODY_AFTER * 2 },
      },
    },
    {
      id: "A0",
      name: "A0",
      basedOn: "Normal",
      next: "A0",
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        spacing: { after: BODY_AFTER },
      },
    },
    {
      id: "A1",
      name: "A1",
      basedOn: "A0",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        indent: { left: INDENT_STEP },
      },
    },
    {
      id: "A1stLevelNumbering",
      name: "A_1st Level Numbering",
      basedOn: "A0",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE, bold: true },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        spacing: { before: BODY_AFTER, after: BODY_AFTER },
      },
    },
    {
      id: "A2ndLevelNumbering",
      name: "A_2nd Level Numbering",
      basedOn: "A1",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE, bold: true },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: INDENT_STEP },
        spacing: { before: BODY_AFTER, after: BODY_AFTER },
      },
    },
    {
      id: "A3rdLevelNumbering",
      name: "A_3rd Level Numbering",
      basedOn: "A1",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: INDENT_STEP * 2 },
        spacing: { after: BODY_AFTER },
      },
    },
    {
      id: "A4thLevelNumbering",
      name: "A_4th Level Numbering",
      basedOn: "A1",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: INDENT_STEP * 3 },
        spacing: { after: BODY_AFTER },
      },
    },
    {
      id: "A5thLevelNumbering",
      name: "A_5th Level Numbering",
      basedOn: "A1",
      next: "A1",
      run: { font: FONT, size: FONT_SIZE },
      paragraph: {
        alignment: AlignmentType.JUSTIFIED,
        indent: { left: INDENT_STEP * 4 },
        spacing: { after: BODY_AFTER },
      },
    },
    {
      id: "StockQuote",
      name: "Stock Quote",
      basedOn: "A1",
      run: { font: FONT, size: FONT_SIZE, italics: true },
      paragraph: {
        indent: { left: INDENT_STEP * 2 },
        spacing: { before: BODY_AFTER, after: BODY_AFTER },
      },
    },
  ],
};
