/**
 * A `DocumentAst` from the text layer of a publisher PDF, for any guidance
 * source.
 *
 * The text layer keeps characters and line order and loses everything else:
 * font sizes, indentation, superscript position. Structure is therefore read
 * only where the text itself states it, and every rule is a sequence the
 * document must keep, so a stray number cannot open a section by accident:
 * - Pages are separated by `PDF_PAGE_SEPARATOR`, as the extractor joins them.
 * - A line printed at the same edge of most pages (`6 | Adopted`) is running
 *   furniture, not text.
 * - Footnotes sit at a page's foot after an empty line, each a lone mark line
 *   followed by an indented first line. Further notes need a body reference
 *   and a blank separator. Ambiguous numbers stay text. The marks ascend
 *   through the document.
 * - A footnote reference is the next mark the document has not referenced
 *   yet: a lone line of marks (the superscript printed above the line it
 *   belongs to) or the mark glued to the word or punctuation before it.
 * - A section heading carries the next section number (`2`, `2.1`, `2.1.1`)
 *   and a title; a numbered paragraph carries the next paragraph number. When
 *   both are due (`1  Introduction` before paragraph `1`), the heading is the
 *   one followed by the paragraph.
 * - A table of contents is its dot leaders and page numbers.
 *
 * Text the rules do not place stays in the paragraph around it: a missed
 * heading costs structure, never text.
 */

import { panic } from "better-result";
import type { Result } from "better-result";

import type {
  DocumentAst,
  DocumentAstMetadata,
  DocumentAstSource,
  HeadingLevel,
  Inline,
} from "@stll/legal-ast/document-ast";

import type { KeyedBlock } from "./block-ids";
import { assembleDocumentAst, draftText } from "./document-assembly";
import type { DocumentBuildError } from "./document-assembly";

/** How the soft-law text extractor joins the pages of a PDF. */
export const PDF_PAGE_SEPARATOR = "\f";

/**
 * A line on at least this share of page edges is running furniture. Set
 * high on purpose: a missed footer leaves noise in the text, a false one
 * deletes text.
 */
const FURNITURE_SHARE = 0.6;
const FURNITURE_MIN_PAGES = 3;

const FOOTNOTE_MARK_LINE = /^\d{1,3}$/u;
const MARK_RUN_LINE = /^\d{1,3}(?: \d{1,3})*$/u;
const INDENTED = /^[\t ]+\S/u;

/**
 * A mark glued to a lowercase letter, a closing bracket or quote, or
 * punctuation after an uppercase acronym,
 * optionally through one clause punctuation, or a year through punctuation
 * or act number through punctuation (`November 2022.4`, `2016/679.2`).
 * Never another number directly, so `6(1)` and the
 * section numbers `1.1` and `2.2` stay text.
 */
const GLUED_MARK =
  /(?<=[\p{Ll})\]”’"][.,;:]?|\p{Lu}[.,;:]|(?<![\d/])\d{4}(?:\/\d{1,4})?[.,;:])(\d{1,3})(?=[\s.,;:)]|$)/gu;

/**
 * An EU act number with a mark glued to its last digit (`2022/20652`): EU
 * acts are numbered with at most four digits, so a fifth is the mark.
 */
const GLUED_ACT_MARK = /(?<!\d)(\d{4}\/\d{4})(\d{1,3})(?!\d)/gu;

const SECTION_LINE = /^(\d{1,2}(?:\.\d{1,2}){0,4})\.?\s+(\p{Lu}.*)$/u;
const PARAGRAPH_LINE = /^(\d{1,4})\s+(\S.*)$/u;
const PAGE_NUMBER_END = /\d{1,4}$/u;
const DOT_LEADER = "....";

/**
 * A contents entry: dot leaders, then a page number. Checked from the end
 * rather than with one pattern over the leaders, which backtracks
 * quadratically on a long run of dots.
 */
const isContentsLine = (text: string): boolean => {
  const page = PAGE_NUMBER_END.exec(text);
  return (
    page !== null && text.slice(0, page.index).trimEnd().endsWith(DOT_LEADER)
  );
};
/** A contents entry too long for one line opens with its section number. */
const TOC_ENTRY_START = /^\d{1,2}(?:\.\d{1,2})*\s+\S/u;
const MAX_TOC_ENTRY_LINES = 3;
const BULLET_LINE = /^[•▪●◦]\s+/u;
const SENTENCE_END = /[.:;!?”"’]$/u;
const HYPHENATED_END = /\p{L}-$/u;

const MAX_HEADING_TITLE_LENGTH = 160;
const MAX_HEADING_LINES = 4;
/** Share of the usual line length below which a line ends its paragraph. */
const SHORT_LINE_SHARE = 0.75;

type Mark = { offset: number; label: string };
type Line = { text: string; marks: Mark[] };

// Only isolated page numbers (optionally before a running-label separator)
// vary within furniture. Numbers in substantive sentences remain part of the key.
const furnitureKey = (line: string): string => {
  const text = line.trim();
  const page = /^\d{1,4}/u.exec(text)?.at(0);
  if (page === undefined) {
    return text;
  }
  const suffix = text.slice(page.length).trim();
  const pageLabel =
    suffix.startsWith("|") && /^\p{L}[\p{L}\s]*$/u.test(suffix.slice(1).trim());
  return suffix === "" || pageLabel ? `#${text.slice(page.length)}` : text;
};

const edgeLines = (lines: readonly string[]): string[] => {
  const content = lines.filter((line) => line.trim() !== "");
  const first = content.at(0);
  const last = content.at(-1);
  return [first, last].filter((line) => line !== undefined);
};

const furnitureOf = (pages: readonly string[][]): Set<string> => {
  const counts = new Map<string, number>();
  for (const page of pages) {
    for (const key of new Set(edgeLines(page).map(furnitureKey))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(
    FURNITURE_MIN_PAGES,
    Math.ceil(pages.length * FURNITURE_SHARE),
  );
  return new Set(
    [...counts].filter(([, count]) => count >= threshold).map(([key]) => key),
  );
};

const withoutFurniture = (
  lines: readonly string[],
  furniture: ReadonlySet<string>,
): string[] => {
  let start = 0;
  let end = lines.length;
  const isEdge = (line: string | undefined): boolean =>
    line !== undefined &&
    (line.trim() === "" || furniture.has(furnitureKey(line)));
  while (start < end && isEdge(lines[start])) {
    start += 1;
  }
  while (end > start && isEdge(lines[end - 1])) {
    end -= 1;
  }
  return lines.slice(start, end);
};

type Footnote = { label: number; lines: string[] };

const isBlank = (line: string | undefined): boolean => line?.trim() === "";

const isNoteStart = (lines: readonly string[], index: number): boolean =>
  FOOTNOTE_MARK_LINE.test(lines[index] ?? "") &&
  INDENTED.test(lines[index + 1] ?? "");

/** Lines a note carried over from the previous page may take on this one. */
const MAX_CARRIED_LINES = 3;

type PageSplit = {
  body: string[];
  /** The previous page's last note, continued at the top of this zone. */
  carried: string[];
  notes: Footnote[];
};

/**
 * The marks a page may reference: its own notes, in order. A footnote is
 * printed on the page that references it, so a candidate mark is accepted
 * only when it is one of this page's notes not yet passed; one missed
 * reference skips that mark instead of stalling every reference after it.
 */
class ReferenceCursor {
  private readonly labels: readonly number[];
  private index = 0;

  constructor(labels: readonly number[]) {
    this.labels = labels;
  }

  take(label: number): boolean {
    return this.takeRun([label]);
  }

  /** Consume a run of marks only when they are this page's next notes in turn. */
  takeRun(labels: readonly number[]): boolean {
    const first = labels.at(0);
    const start =
      first === undefined ? -1 : this.labels.indexOf(first, this.index);
    if (
      start === -1 ||
      labels.some((label, offset) => this.labels[start + offset] !== label)
    ) {
      return false;
    }
    this.index = start + labels.length;
    return true;
  }
}

type ReadNotesOptions = {
  lines: readonly string[];
  start: number;
  after: number;
  bodyEnd: number;
};

/** The notes from `start`, or `null` when their marks do not ascend from `after`. */
const readNotes = ({
  lines,
  start,
  after,
  bodyEnd,
}: ReadNotesOptions): Footnote[] | null => {
  const labels = new Set(
    lines
      .slice(start)
      .filter((line) => FOOTNOTE_MARK_LINE.test(line))
      .map(Number),
  );
  const referenced = new Set(
    bodyLines(
      lines.slice(0, bodyEnd),
      new ReferenceCursor([...labels].toSorted((a, b) => a - b)),
    ).flatMap(({ marks }) => marks.map(({ label }) => Number(label))),
  );
  const notes: Footnote[] = [];
  let previous = after;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const label = Number(line);
    // A body reference cannot distinguish a numeric fact from a new note.
    // Every later note needs a separator; unseparated numbers stay literal.
    if (
      FOOTNOTE_MARK_LINE.test(line) &&
      (index === start ||
        (referenced.has(label) &&
          isBlank(lines[index - 1]) &&
          (isNoteStart(lines, index) || label === previous + 1)))
    ) {
      if (label <= previous) {
        return null;
      }
      previous = label;
      notes.push({ label, lines: [] });
      continue;
    }
    notes.at(-1)?.lines.push(line);
  }
  return notes;
};

/**
 * Split a page into body and footnotes. The zone opens at a note start
 * after an empty line; or, when the note is the very next one due, at the
 * note start itself (the empty line is not always printed), taking along
 * the few lines after the nearest empty line as the previous note running
 * over from the page before.
 */
const splitFootnotes = (lines: readonly string[], after: number): PageSplit => {
  for (let start = 0; start < lines.length; start += 1) {
    const mark = lines[start] ?? "";
    const due = FOOTNOTE_MARK_LINE.test(mark) && Number(mark) === after + 1;
    // An unindented first line is only trusted after an empty line, for the
    // note due next; a lone mark at the top of a page is a body reference.
    const opensAfterBlank =
      isBlank(lines[start - 1]) && (isNoteStart(lines, start) || due);
    if (
      Number(mark) <= after ||
      (!opensAfterBlank && !isNoteStart(lines, start))
    ) {
      continue;
    }
    let bodyEnd: number;
    let carried: string[] = [];
    if (opensAfterBlank) {
      bodyEnd = start - 1;
    } else if (due) {
      const blank = lines
        .slice(Math.max(0, start - MAX_CARRIED_LINES - 1), start)
        .findLastIndex(isBlank);
      bodyEnd =
        after > 0 && blank !== -1
          ? Math.max(0, start - MAX_CARRIED_LINES - 1) + blank
          : start;
      carried = bodyEnd === start ? [] : lines.slice(bodyEnd + 1, start);
    } else {
      continue;
    }
    const notes = readNotes({ lines, start, after, bodyEnd });
    if (notes !== null) {
      return { body: lines.slice(0, bodyEnd), carried, notes };
    }
  }
  return { body: [...lines], carried: [], notes: [] };
};

/** The line with the marks glued into it lifted out of its text. */
const liftGluedMarks = (text: string, cursor: ReferenceCursor): Line => {
  const marks: Mark[] = [];
  let out = "";
  let last = 0;
  const candidates = [
    ...[...text.matchAll(GLUED_ACT_MARK)].map((match) => ({
      start: match.index + (match[1]?.length ?? 0),
      label: match[2] ?? "",
    })),
    ...[...text.matchAll(GLUED_MARK)].map((match) => ({
      start: match.index,
      label: match[1] ?? "",
    })),
  ].toSorted((a, b) => a.start - b.start);
  for (const { label, start } of candidates) {
    if (start < last || !cursor.take(Number(label))) {
      continue;
    }
    out += text.slice(last, start);
    marks.push({ offset: out.length, label });
    last = start + label.length;
  }
  return { text: out + text.slice(last), marks };
};

/**
 * Body lines with every reference mark lifted out. A lone line of marks is
 * the superscript printed above the following line, so its marks go to the
 * end of that line: the text layer keeps the line, not the column.
 */
const bodyLines = (
  lines: readonly string[],
  cursor: ReferenceCursor,
): Line[] => {
  const out: Line[] = [];
  let pending: string[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (
      MARK_RUN_LINE.test(trimmed) &&
      cursor.takeRun(trimmed.split(" ").map(Number))
    ) {
      pending.push(...trimmed.split(" "));
      continue;
    }
    const line = liftGluedMarks(trimmed, cursor);
    if (pending.length > 0 && trimmed !== "") {
      line.marks.push(
        ...pending.map((label) => ({ offset: line.text.length, label })),
      );
      pending = [];
    }
    out.push(line);
  }
  const last = out.findLast((line) => line.text !== "");
  if (pending.length > 0 && last !== undefined) {
    last.marks.push(
      ...pending.map((label) => ({ offset: last.text.length, label })),
    );
  }
  return out;
};

const joinLines = (lines: readonly Line[]): Line => {
  let text = "";
  const marks: Mark[] = [];
  for (const line of lines) {
    if (line.text === "") {
      continue;
    }
    // A word broken at the margin keeps its hyphen and loses the line break;
    // a spaced dash ending a line is punctuation and keeps its space.
    const separator = text === "" || HYPHENATED_END.test(text) ? "" : " ";
    const base = text.length + separator.length;
    text += separator + line.text;
    marks.push(
      ...line.marks.map(({ label, offset }) => ({
        label,
        offset: base + offset,
      })),
    );
  }
  return { text, marks };
};

const inlinesOf = ({ marks, text }: Line): Inline[] => {
  const inlines: Inline[] = [];
  let last = 0;
  for (const { label, offset } of marks.toSorted(
    (a, b) => a.offset - b.offset,
  )) {
    if (offset > last) {
      inlines.push({ type: "text", text: text.slice(last, offset) });
    }
    inlines.push({
      type: "superscript",
      children: [{ type: "text", text: label }],
    });
    last = offset;
  }
  if (last < text.length) {
    inlines.push({ type: "text", text: text.slice(last) });
  }
  return inlines;
};

/** The labels a section numbering may continue with after `current`. */
const nextSectionLabels = (current: readonly number[]): Set<string> => {
  const next = new Set<string>([[...current, 1].join(".")]);
  for (let depth = current.length; depth >= 1; depth -= 1) {
    const prefix = current.slice(0, depth - 1);
    next.add([...prefix, (current[depth - 1] ?? 0) + 1].join("."));
  }
  return next;
};

const headingLevelOf = (label: string): HeadingLevel => {
  const depth = label.split(".").length;
  switch (depth) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 5;
    default:
      return 6;
  }
};

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

type Draft =
  | {
      type: "paragraph";
      number: number | null;
      lines: Line[];
      listDepth: 1 | null;
    }
  | { type: "heading"; label: string; lines: Line[] }
  | { type: "contents"; lines: Line[] };

type SegmentState = {
  drafts: Draft[];
  section: number[];
  nextParagraph: number;
  usualLength: number;
};

const firstContentLine = (lines: readonly Line[], from: number): string =>
  lines.slice(from).find((line) => line.text !== "")?.text ?? "";

const isDueParagraph = (text: string, state: SegmentState): boolean =>
  PARAGRAPH_LINE.exec(text)?.at(1) === String(state.nextParagraph);

/** Whether line `index` opens the next section rather than a paragraph. */
const sectionLabelAt = (
  lines: readonly Line[],
  index: number,
  state: SegmentState,
): string | null => {
  const text = lines[index]?.text ?? "";
  const match = SECTION_LINE.exec(text);
  const label = match?.at(1);
  const title = match?.at(2)?.trim() ?? "";
  if (
    label === undefined ||
    isContentsLine(text) ||
    title.length > MAX_HEADING_TITLE_LENGTH ||
    /[.;,:]$/u.test(title) ||
    !nextSectionLabels(state.section).has(label)
  ) {
    return null;
  }
  if (!label.includes(".") && label === String(state.nextParagraph)) {
    // Both are due: only a heading is followed by the paragraph itself.
    return isDueParagraph(firstContentLine(lines, index + 1), state)
      ? label
      : null;
  }
  return label;
};

const openParagraph = (state: SegmentState, line: Line): void => {
  const numbered = PARAGRAPH_LINE.exec(line.text);
  const number = numbered?.at(1);
  if (number !== undefined && Number(number) === state.nextParagraph) {
    const prefix = line.text.length - (numbered?.at(2)?.length ?? 0);
    state.nextParagraph += 1;
    state.drafts.push({
      type: "paragraph",
      number: Number(number),
      listDepth: null,
      lines: [
        {
          text: line.text.slice(prefix),
          marks: line.marks
            .filter(({ offset }) => offset >= prefix)
            .map(({ label, offset }) => ({ label, offset: offset - prefix })),
        },
      ],
    });
    return;
  }
  state.drafts.push({
    type: "paragraph",
    number: null,
    listDepth: BULLET_LINE.test(line.text) ? 1 : null,
    lines: [line],
  });
};

type ContentsStep =
  { type: "consumed"; open: Draft } | { type: "not-contents" };

/** A line read as part of a table of contents, when it is one. */
const contentsStep = (
  state: SegmentState,
  open: Draft | null,
  line: Line,
): ContentsStep => {
  const opensEntry = (): ContentsStep => {
    const entry: Draft = { type: "contents", lines: [line] };
    state.drafts.push(entry);
    return { type: "consumed", open: entry };
  };
  if (open?.type !== "contents") {
    return isContentsLine(line.text) ? opensEntry() : { type: "not-contents" };
  }
  const entryOpen =
    !isContentsLine(open.lines.at(-1)?.text ?? "") &&
    open.lines.length < MAX_TOC_ENTRY_LINES;
  if (entryOpen) {
    // An entry wrapped onto several lines carries its leaders on the last.
    open.lines.push(line);
    return { type: "consumed", open };
  }
  return isContentsLine(line.text) ||
    (TOC_ENTRY_START.test(line.text) && !isDueParagraph(line.text, state))
    ? opensEntry()
    : { type: "not-contents" };
};

const segment = (lines: readonly Line[]): Draft[] => {
  const state: SegmentState = {
    drafts: [],
    section: [],
    nextParagraph: 1,
    usualLength: median(
      lines.filter((line) => line.text !== "").map((line) => line.text.length),
    ),
  };
  let open: Draft | null = null;
  let headingLines = 0;
  for (const [index, line] of lines.entries()) {
    if (line.text === "") {
      open = null;
      continue;
    }
    const label = sectionLabelAt(lines, index, state);
    if (label !== null) {
      state.section = label.split(".").map(Number);
      open = { type: "heading", label, lines: [line] };
      headingLines = 1;
      state.drafts.push(open);
      continue;
    }
    const contents = contentsStep(state, open, line);
    if (contents.type === "consumed") {
      open = contents.open;
      continue;
    }
    const previous = open?.lines.at(-1)?.text ?? "";
    const opensBlock =
      open === null ||
      isDueParagraph(line.text, state) ||
      BULLET_LINE.test(line.text) ||
      open.type === "contents" ||
      (open.type === "heading" &&
        (headingLines >= MAX_HEADING_LINES || MARK_RUN_LINE.test(line.text))) ||
      (open.type === "paragraph" &&
        SENTENCE_END.test(previous) &&
        previous.length < state.usualLength * SHORT_LINE_SHARE &&
        /^\p{Lu}/u.test(line.text));
    if (opensBlock) {
      openParagraph(state, line);
      open = state.drafts.at(-1) ?? null;
      continue;
    }
    if (open?.type === "heading") {
      headingLines += 1;
    }
    open?.lines.push(line);
  }
  return state.drafts;
};

const keyedBlockOf = (draft: Draft): KeyedBlock => {
  const line = joinLines(draft.lines);
  switch (draft.type) {
    case "heading": {
      return {
        key: { type: "section", label: draft.label },
        block: {
          type: "heading",
          level: headingLevelOf(draft.label),
          role: "section-heading",
          ...draftText(inlinesOf(line)),
        },
      };
    }
    case "paragraph": {
      return {
        key:
          draft.number === null
            ? { type: "positional" }
            : { type: "paragraph", number: draft.number },
        block: {
          type: "paragraph",
          ...(draft.number === null ? {} : { number: draft.number }),
          ...(draft.listDepth === null ? {} : { listDepth: draft.listDepth }),
          ...draftText(inlinesOf(line)),
        },
      };
    }
    case "contents": {
      return {
        key: { type: "positional" },
        block: { type: "paragraph", ...draftText(inlinesOf(line)) },
      };
    }
    default: {
      draft satisfies never;
      return panic(`Unhandled draft: ${String(draft)}`);
    }
  }
};

const noteBlockOf = (note: Footnote): KeyedBlock => {
  const label = String(note.label);
  return {
    key: { type: "footnote", label },
    block: {
      type: "paragraph",
      note: { type: "footnote", label },
      ...draftText(
        inlinesOf(
          joinLines(
            note.lines.map((text) => ({ text: text.trim(), marks: [] })),
          ),
        ),
      ),
    },
  };
};

type BuildPdfTextDocumentAstOptions = {
  /** The extracted text layer, pages joined by `PDF_PAGE_SEPARATOR`. */
  text: string;
  source: DocumentAstSource;
  metadata: DocumentAstMetadata;
};

export const buildPdfTextDocumentAst = ({
  metadata,
  source,
  text,
}: BuildPdfTextDocumentAstOptions): Result<DocumentAst, DocumentBuildError> => {
  const rawPages = text
    .split(PDF_PAGE_SEPARATOR)
    .map((page) => page.split("\n").map((line) => line.trimEnd()));
  const furniture =
    rawPages.length >= FURNITURE_MIN_PAGES
      ? furnitureOf(rawPages)
      : new Set<string>();
  const notes: Footnote[] = [];
  const pageBodies = rawPages.map((page) => {
    const split = splitFootnotes(
      withoutFurniture(page, furniture),
      notes.at(-1)?.label ?? 0,
    );
    notes.at(-1)?.lines.push(...split.carried);
    notes.push(...split.notes);
    return split;
  });
  const lines = pageBodies.flatMap(({ body, notes: pageNotes }) =>
    bodyLines(body, new ReferenceCursor(pageNotes.map(({ label }) => label))),
  );
  return assembleDocumentAst({
    source,
    metadata,
    blocks: [...segment(lines).map(keyedBlockOf), ...notes.map(noteBlockOf)],
  });
};
