import { panic } from "better-result";

import type {
  Document,
  Footnote,
  Hyperlink,
  Paragraph,
  ParagraphContent,
  TrackedRunContent,
} from "@stll/docx-core/model";

type InlineContent =
  | ParagraphContent
  | TrackedRunContent
  | Hyperlink["children"][number];

/**
 * Resolve notes at their paragraph references, in reference order. Use one
 * reader per document traversal: repeated references and cycles emit a note
 * only at its first anchor. Unreferenced package entries are not body content.
 * RTF and DOCX share these paragraph-local footnoteRef anchors.
 */
export const createParagraphFootnoteReader = (document: Document) => {
  const notes = new Map(
    (document.package.footnotes ?? []).map((note) => [note.id, note]),
  );
  const emitted = new Set<number>();
  return (paragraph: Paragraph): Footnote[] => {
    const anchored: Footnote[] = [];
    const visit = (items: readonly InlineContent[]): void => {
      for (const item of items) {
        switch (item.type) {
          case "run":
            for (const content of item.content) {
              if (content.type !== "footnoteRef" || emitted.has(content.id)) {
                continue;
              }
              const note = notes.get(content.id);
              if (note === undefined) {
                panic(`Footnote reference has no body: ${String(content.id)}`);
              }
              emitted.add(content.id);
              if (note.noteType === undefined || note.noteType === "normal") {
                anchored.push(note);
              }
            }
            break;
          case "hyperlink":
            visit(item.children);
            break;
          case "complexField":
            visit(item.fieldResult);
            break;
          case "simpleField":
          case "inlineSdt":
          case "inlineWrapper":
          case "insertion":
          case "moveTo":
            visit(item.content);
            break;
          case "deletion":
          case "moveFrom":
          case "mathEquation":
          case "preservedInline":
          case "bookmarkStart":
          case "bookmarkEnd":
          case "moveFromRangeStart":
          case "moveFromRangeEnd":
          case "moveToRangeStart":
          case "moveToRangeEnd":
          case "commentRangeStart":
          case "commentRangeEnd":
          case "commentReference":
            break;
          default:
            item satisfies never;
            panic("Unhandled paragraph content while resolving footnotes");
        }
      }
    };
    visit(paragraph.content);
    return anchored;
  };
};
