import { panic } from "better-result";

import type {
  BlockContent,
  Document,
  Footnote,
  Hyperlink,
  Paragraph,
  ParagraphContent,
  TrackedRunContent,
} from "@stll/docx-core/model";

type InlineContent =
  ParagraphContent | TrackedRunContent | Hyperlink["children"][number];

/**
 * Resolve notes at their paragraph references, in reference order. Use one
 * reader per document traversal: repeated references and cycles emit a note
 * only at its first anchor. Unreferenced package entries are not body content.
 * RTF and DOCX share these paragraph-local footnoteRef anchors.
 */
export const createParagraphFootnoteReader = ({
  package: { footnotes = [] },
}: Document) => {
  const notes = new Map(footnotes.map((note) => [note.id, note]));
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

export type BodyDocumentLine<T> = { readonly kind: "body"; readonly value: T };
export type DocumentLine<T> =
  | BodyDocumentLine<T>
  | {
      readonly kind: "note";
      readonly note: {
        readonly value: T;
        readonly label: string;
        readonly noteId: string | undefined;
      };
    };

/** Preserve membership at the shared boundary; note payloads cannot be passed
 * to a classifier that accepts BodyDocumentLine. Nested notes keep their own id. */
export const createParagraphLineReader = <T>(
  document: Document,
  project: (paragraph: Paragraph) => T,
) => {
  const notesAfter = createParagraphFootnoteReader(document);
  return (paragraph: Paragraph): DocumentLine<T>[] => {
    const lines: DocumentLine<T>[] = [];
    const append = (
      anchor: Paragraph,
      membership: { label: string; noteId: string } | undefined,
    ): void => {
      const value = project(anchor);
      lines.push(
        membership === undefined
          ? { kind: "body", value }
          : { kind: "note", note: { value, ...membership } },
      );
      for (const note of notesAfter(anchor)) {
        visit(note.content, {
          label: String(note.id),
          noteId: `fn-${note.id}`,
        });
      }
    };
    const visit = (
      blocks: readonly BlockContent[],
      membership: { label: string; noteId: string },
    ): void => {
      for (const block of blocks) {
        switch (block.type) {
          case "paragraph":
            append(block, membership);
            break;
          case "table":
            for (const row of block.rows) {
              for (const cell of row.cells) {
                visit(cell.content, membership);
              }
            }
            break;
          case "blockSdt":
          case "blockCustomXml":
            visit(block.content, membership);
            break;
          case "preservedBlock":
          case "bookmarkStart":
          case "bookmarkEnd":
            break;
          default:
            block satisfies never;
            panic("Unhandled footnote block");
        }
      }
    };
    append(paragraph, undefined);
    return lines;
  };
};
