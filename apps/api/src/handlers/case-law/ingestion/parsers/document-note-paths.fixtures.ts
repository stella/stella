import { panic } from "better-result";
import { expect } from "bun:test";

import type {
  BlockContent,
  Document,
  Footnote,
  HeaderFooter,
  Paragraph,
  Table,
} from "@stll/docx-core/model";
import type { Block } from "@stll/legal-ast/document-ast";

import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { readRtfString } from "@/api/lib/legal-search/parsers/rtf-reader";

export const NOTE_PATHS = [
  "body-paragraph",
  "heading",
  "list-item",
  "front-header",
  "page-header",
  "page-footer",
  "section-header",
  "section-footer",
  "closing-footer",
  "holding",
  "table-cell",
  "table-later-row",
  "nested-table",
  "content-control",
  "custom-xml",
  "note-paragraph",
  "note-list",
  "note-table",
  "note-nested-table",
  "note-wrapper",
  "note-content-control",
  "notes-inside-notes",
] as const;
export const LINE_BOUNDARIES = ["line", "par", "sect", "page"] as const;
type NotePath = (typeof NOTE_PATHS)[number];
type Boundary = (typeof LINE_BOUNDARIES)[number];

const paragraphsOf = (source: string): Paragraph[] =>
  readRtfString(source).package.document.content.flatMap((block) =>
    block.type === "paragraph" ? [block] : [],
  );
const tableOf = (rows: readonly (readonly BlockContent[])[]): Table => ({
  type: "table",
  rows: rows.map((content) => ({
    type: "tableRow",
    cells: [{ type: "tableCell", content: [...content] }],
  })),
});
const wrap = (
  content: BlockContent[],
  kind: "blockSdt" | "blockCustomXml",
): BlockContent =>
  kind === "blockCustomXml"
    ? {
        type: "blockCustomXml",
        openingXml: '<w:customXml w:element="note">',
        closingXml: "</w:customXml>",
        content,
      }
    : { type: "blockSdt", content, properties: { sdtType: "richText" } };
const addReference = (paragraph: Paragraph | undefined, id: number): void => {
  if (paragraph === undefined) {
    panic("Matrix anchor missing");
  }
  paragraph.content.push({
    type: "run",
    content: [{ type: "footnoteRef", id }],
  });
};

const noteContentOf = (path: NotePath, notes: Paragraph[]): BlockContent[] => {
  let noteContent: BlockContent[] = notes;
  if (path === "note-list") {
    notes.at(0)?.content.unshift({
      type: "run",
      content: [{ type: "text", text: "[1] " }],
    });
  }
  if (path === "note-table") {
    noteContent = [tableOf([notes])];
  }
  if (path === "note-nested-table") {
    noteContent = [tableOf([[tableOf([notes])]])];
  }
  if (path === "note-content-control") {
    noteContent = [wrap(notes, "blockSdt")];
  }
  if (path === "note-wrapper") {
    noteContent = [wrap(notes, "blockCustomXml")];
  }
  return noteContent;
};

type FurnitureOptions = {
  document: Document;
  path: NotePath;
  anchor: Paragraph[];
  reasoning: string;
  following: Paragraph[];
};
const placeFurniture = ({
  document,
  path,
  anchor,
  reasoning,
  following,
}: FurnitureOptions): void => {
  const kind =
    path === "page-header" || path === "section-header" ? "header" : "footer";
  const furniture = {
    type: kind,
    hdrFtrType: "default",
    content: anchor,
  } satisfies HeaderFooter;
  document.package.document.content = [
    ...paragraphsOf(`{\\rtf1 ${reasoning}\\par}`),
    ...following,
  ];
  if (kind === "header") {
    document.package.headers = new Map([["header1.xml", furniture]]);
  } else {
    document.package.footers = new Map([["footer1.xml", furniture]]);
  }
  if (path === "section-header" || path === "section-footer") {
    document.package.document.sections = [
      {
        properties: {},
        content: document.package.document.content,
        ...(kind === "header"
          ? { headers: new Map([["default", furniture]]) }
          : { footers: new Map([["default", furniture]]) }),
      },
    ];
  }
};

type NotePathOptions = {
  parser: "cz" | "hu";
  path: NotePath;
  boundary: Boundary;
  withNotes: boolean;
};
export const notePathDocument = ({
  parser,
  path,
  boundary,
  withNotes,
}: NotePathOptions) => {
  const reasoning = parser === "cz" ? "Odůvodnění" : "Indokolás";
  const holding = parser === "cz" ? "takto:" : "Rendelkező rész";
  const noteHeading =
    parser === "cz" ? "Odlišné stanovisko" : "Rendelkező rész";
  let anchorText = "Anchor text";
  if (path === "heading") {
    anchorText = reasoning;
  }
  if (path === "list-item") {
    anchorText = parser === "cz" ? "1. Anchor text" : "[1] Anchor text";
  }
  if (path === "closing-footer") {
    anchorText =
      parser === "cz" ? "V Brně dne 1. 1. 2025" : "Győr, 2009. június 30.";
  }
  const anchor = paragraphsOf(
    `{\\rtf1 ${anchorText}\\${boundary} Body continuation\\par}`,
  );
  const notes = paragraphsOf(
    `{\\rtf1 ${noteHeading}\\${boundary} Note tail\\par}`,
  );
  const child = paragraphsOf(
    `{\\rtf1 Child note heading\\${boundary} Child note tail\\par}`,
  );
  const noteContent = noteContentOf(path, notes);
  if (withNotes) {
    addReference(anchor.at(0), 1);
  }
  const footnotes: Footnote[] = withNotes
    ? [{ type: "footnote", id: 1, content: noteContent }]
    : [];
  if (withNotes && path === "notes-inside-notes") {
    addReference(notes.at(0), 2);
    footnotes.push({ type: "footnote", id: 2, content: child });
  }
  const following = paragraphsOf("{\\rtf1 Following body\\par}");
  let body: BlockContent[] = anchor;
  if (path === "table-cell" || path === "table-later-row") {
    const rows = [anchor, paragraphsOf("{\\rtf1 Following row\\par}")];
    if (path === "table-later-row") {
      rows.unshift(paragraphsOf("{\\rtf1 Previous row\\par}"));
    }
    body = [tableOf(rows)];
  }
  if (path === "nested-table") {
    body = [
      tableOf([
        [tableOf([anchor])],
        paragraphsOf("{\\rtf1 Following row\\par}"),
      ]),
    ];
  }
  if (path === "content-control" || path === "custom-xml") {
    body = [
      wrap(anchor, path === "content-control" ? "blockSdt" : "blockCustomXml"),
    ];
  }
  const initial =
    path === "front-header" || path === "heading"
      ? []
      : paragraphsOf(
          `{\\rtf1 ${path === "holding" ? holding : reasoning}\\par}`,
        );
  const afterFront =
    path === "front-header" ? paragraphsOf(`{\\rtf1 ${reasoning}\\par}`) : [];
  const excluded =
    path === "page-header" ||
    path === "page-footer" ||
    path === "section-header" ||
    path === "section-footer";
  const document: Document = {
    package: {
      document: { content: [...initial, ...body, ...afterFront, ...following] },
      footnotes,
    },
  };
  if (excluded) {
    placeFurniture({ document, path, anchor, reasoning, following });
  }
  return {
    document,
    anchorText,
    noteHeading,
    nested: path === "notes-inside-notes",
    excluded,
  };
};

type ParsedPath = {
  blocks: readonly Block[];
  sections: readonly DecisionSection[];
};
type AssertPathOptions = {
  parsed: ParsedPath;
  baseline: ParsedPath;
  anchorText: string;
  noteHeading: string;
  nested: boolean;
  excluded: boolean;
};
export const assertNotePath = ({
  parsed,
  baseline,
  anchorText,
  noteHeading,
  nested,
  excluded,
}: AssertPathOptions): void => {
  const notes = parsed.blocks.filter(
    (block) => block.type === "paragraph" && block.note !== undefined,
  );
  if (excluded) {
    expect(notes).toEqual([]);
    expect(parsed).toEqual(baseline);
    expect(
      parsed.blocks.map((block) => block.plainText).join(" "),
    ).not.toContain("Note tail");
    return;
  }
  expect(notes.length).toBe(nested ? 4 : 2);
  const bodyText = (blocks: readonly Block[]) =>
    blocks
      .filter((block) => block.type !== "paragraph" || block.note === undefined)
      .map((block) => block.plainText)
      .join("")
      .replace(/\s/gu, "");
  expect(bodyText(parsed.blocks)).toBe(bodyText(baseline.blocks));
  for (const block of notes) {
    expect(block.type).toBe("paragraph");
    if (block.type !== "paragraph") {
      panic("Expected note paragraph");
    }
    const isChild = block.plainText.startsWith("Child note");
    expect(block.note).toEqual({
      type: "footnote",
      label: isChild ? "2" : "1",
      noteId: isChild ? "fn-2" : "fn-1",
    });
  }
  expect(notes.some((block) => block.plainText.includes(noteHeading))).toBe(
    true,
  );
  const anchorIndex = parsed.blocks.findIndex((block) =>
    block.plainText.includes(anchorText.replace(/^1\. |^\[1\] /u, "")),
  );
  const firstNoteIndex = parsed.blocks.findIndex(
    (block) => block.type === "paragraph" && block.note !== undefined,
  );
  const followingIndex = parsed.blocks.findIndex(
    (block) =>
      block.plainText.includes("Following row") ||
      block.plainText === "Following body",
  );
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  expect(firstNoteIndex).toBeGreaterThan(anchorIndex);
  const lastNoteIndex = parsed.blocks.findLastIndex(
    (block) => block.type === "paragraph" && block.note !== undefined,
  );
  expect(followingIndex).toBeGreaterThan(lastNoteIndex);
  for (const block of parsed.blocks) {
    if (block.type === "paragraph" && block.note !== undefined) {
      continue;
    }
    expect(block.plainText).not.toContain("Note tail");
    expect(block.plainText).not.toContain("Child note");
    if (block.type === "table") {
      for (const row of block.rows) {
        for (const cell of row) {
          expect(cell.plainText).not.toContain("Note tail");
          expect(cell.plainText).not.toContain("Child note");
        }
      }
    }
  }
  for (const text of [
    "Anchor text",
    "Body continuation",
    "Following body",
    "Following row",
  ]) {
    const before = baseline.sections.find((section) =>
      section.text.includes(text),
    );
    if (before === undefined) {
      continue;
    }
    expect(
      parsed.sections.find((section) => section.text.includes(text))?.type,
    ).toBe(before.type);
  }
  const noteSection = parsed.sections.find((section) =>
    section.text.includes("Note tail"),
  );
  const anchorSection = parsed.sections.find(
    (section) =>
      section.text.includes(anchorText.replace(/^1\. |^\[1\] /u, "")) ||
      section.title?.includes(anchorText),
  );
  expect(noteSection?.type).toBe(anchorSection?.type);
};

export const noteTableRtf = (
  parser: "cz" | "hu",
  boundary: Boundary,
  withNotes: boolean,
): string => {
  const heading = parser === "cz" ? "Odůvodnění" : "Indokolás";
  const noteHeading =
    parser === "cz" ? "Odlišné stanovisko" : "Rendelkező rész";
  const note = withNotes
    ? `{\\footnote ${noteHeading}\\${boundary} Note tail}`
    : "";
  return `{\\rtf1 ${heading}\\par\\trowd\\cellx3000\\intbl Anchor text${note}\\${boundary} Body continuation\\cell\\row\\trowd\\cellx3000\\intbl Following row\\cell\\row\\pard Following body\\par}`;
};

export const furnitureRtf = (
  parser: "cz" | "hu",
  destination: "header" | "footer",
  boundary: Boundary,
): string => {
  const heading = parser === "cz" ? "Odůvodnění" : "Indokolás";
  return `{\\rtf1 {\\${destination} Furniture{\\footnote Hidden note\\${boundary} Hidden tail}\\${boundary} Hidden furniture tail}${heading}\\par Following body\\par}`;
};
