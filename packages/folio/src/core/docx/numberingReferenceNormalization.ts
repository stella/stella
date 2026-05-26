import type {
  DocumentBody,
  Endnote,
  Footnote,
  HeaderFooter,
} from "../types/document";
import type { NumberingMap } from "./numberingParser";
import { visitDocxParagraphs } from "./paragraphTraversal";

type NormalizeNumberingReferencesInput = {
  documentBody: DocumentBody;
  numbering: NumberingMap;
  headers?: Map<string, HeaderFooter>;
  footers?: Map<string, HeaderFooter>;
  footnotes?: readonly Footnote[];
  endnotes?: readonly Endnote[];
};

type NormalizeNumberingReferencesResult = {
  removedMissingNumberingReferences: number;
};

export const normalizeNumberingReferences = ({
  documentBody,
  numbering,
  headers,
  footers,
  footnotes,
  endnotes,
}: NormalizeNumberingReferencesInput): NormalizeNumberingReferencesResult => {
  let removedMissingNumberingReferences = 0;

  visitDocxParagraphs(
    { documentBody, headers, footers, footnotes, endnotes },
    (paragraph) => {
      const numId = paragraph.formatting?.numPr?.numId;
      if (
        numId !== undefined &&
        numId !== 0 &&
        !numbering.hasNumbering(numId)
      ) {
        delete paragraph.formatting?.numPr;
        delete paragraph.listRendering;
        removedMissingNumberingReferences += 1;
      }
    },
  );

  return { removedMissingNumberingReferences };
};
