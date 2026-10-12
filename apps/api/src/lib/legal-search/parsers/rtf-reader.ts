/**
 * An RTF reader that answers in folio's document model.
 *
 * `parseDocx` from `@stll/folio-core/server` returns a `Document` — a package
 * whose body is `BlockContent[]` of paragraphs and tables, whose runs carry
 * `TextFormatting`, and whose notes hang off `package.footnotes`, anchored by
 * paragraph-local `footnoteRef` run items. Source parsers resolve those anchors
 * with `createParagraphFootnoteReader`, placing notes after their paragraph. A court that
 * publishes half its collection as RTF and half as DOCX otherwise needs two
 * parsers, one per encoding, and the second one is where the drift starts. So
 * this reads RTF into that same model and is named for the `parseRtf` it would
 * be if it moved into folio-core: one reader per encoding, one parser per
 * court.
 *
 * Scope is the court dialect, not the RTF specification: groups, control words
 * with an optional numeric parameter, `\'xx` bytes against the document's
 * `\ansicpgN` code page (or the current font's `\fcharsetN`), `\uN?` escapes, `\par`/`\pard`, `\line`, `\tab`, the
 * character state (`\b`, `\i`, `\ul`, `\cfN`), alignment, `\trowd`/`\cell`/
 * `\row` tables, and `\footnote`. Header tables (`\fonttbl`, `\colortbl`,
 * `\stylesheet`, `\info`) are skipped. Embedded text destinations are kept
 * after their anchor paragraph; unsupported ignorable destinations are reported.
 *
 * What it does not recognise, it reports: `warnings` names every control word
 * outside the dialect, so an unhandled construct reaches the parse signal
 * (`validate-ast.ts`) instead of disappearing. Nothing is dropped silently.
 */

import { panic } from "better-result";

import type {
  BlockContent,
  ColorValue,
  Document,
  Footnote,
  Paragraph,
  ParagraphAlignment,
  ParagraphContent,
  Run,
  RunContent,
  Table,
  TableCell,
  TableRow,
  TextFormatting,
} from "@stll/docx-core/model";

import { RTF_CONTROLS } from "./rtf-control-vocabulary";
import {
  RTF_EMBEDDED_CONTAINERS,
  RTF_VISIBLE_BLOCK_DESTINATIONS,
} from "./rtf-destinations";

/**
 * Code pages `\ansicpgN` selects, and the label `TextDecoder` knows each by.
 *
 * Both of the court's writers appear in the collection — Central European and
 * Western European — and a byte read against the wrong one is a silently wrong
 * letter rather than a failure, so the mapping is explicit and a code page
 * outside it is reported instead of guessed at.
 */
const RTF_CODE_PAGES = [
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1257, "windows-1257"],
  [10_000, "macintosh"],
] as const;

/** The labels above, as the decoder's own vocabulary. */
type RtfCodePage = (typeof RTF_CODE_PAGES)[number][0];
type CodePageLabel = (typeof RTF_CODE_PAGES)[number][1];

const CODE_PAGE_LABELS = new Map<number, CodePageLabel>(RTF_CODE_PAGES);

const DEFAULT_CODE_PAGE_LABEL: CodePageLabel = "windows-1252";

/**
 * The code page a font's `\fcharsetN` selects. A font's charset outranks the
 * document's `\ansicpgN` for the `\'xx` bytes written in it: Word on a
 * Western-European machine writes `\ansicpg1252` and a Hungarian text in a
 * `\fcharset238` font, whose byte F5 is "ő", not the "õ" of windows-1252.
 * `0` (ANSI) and `1` (default) defer to the document; `2` (symbol) has no
 * code page and does too. Any other charset (`255`, the OEM code page 437,
 * which no WHATWG decoder reads; the double-byte Asian sets) is reported
 * where text is written in it, never read as a neighbour.
 */
const FONT_CHARSET_CODE_PAGES = new Map<number, number>([
  [77, 10_000],
  [161, 1253],
  [162, 1254],
  [186, 1257],
  [204, 1251],
  [238, 1250],
]);

const DOCUMENT_FONT_CHARSETS = new Set([0, 1, 2]);

/** What a font's `\fcharsetN` says its bytes are read against. */
type FontCharset =
  | { type: "code-page"; label: CodePageLabel }
  | { type: "unsupported"; charset: number };

/**
 * Control words the dialect states and this reader answers for. Every other
 * word is reported, so the set is the contract rather than a convenience.
 */
const HANDLED_CONTROL_WORDS = new Set([
  // Document and header groups.
  "rtf",
  "ansi",
  "mac",
  "pc",
  "pca",
  "ansicpg",
  "deff",
  "deflang",
  "deflangfe",
  "deftab",
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "generator",
  "bin",
  "objemb",
  "objlink",
  "objautlink",
  "objw",
  "objh",
  "shpleft",
  "shptop",
  "shpright",
  "shpbottom",
  "shpbxpage",
  "shpbypage",
  "shpwr",
  "shpfhdr",
  "shpz",
  "dptxbx",
  "viewkind",
  "uc",
  "red",
  "green",
  "blue",
  "f",
  "fs",
  "s",
  "fcharset",
  "fprq",
  "froman",
  "fswiss",
  "fmodern",
  "fnil",
  "fscript",
  "fdecor",
  "ftech",
  "fbidi",
  "lang",
  "langfe",
  "langnp",
  "noproof",
  // Paragraph state.
  "par",
  "pard",
  "plain",
  "ql",
  "qc",
  "qr",
  "qj",
  "sb",
  "sa",
  "sl",
  "slmult",
  "fi",
  "li",
  "ri",
  "lin",
  "rin",
  "itap",
  "keep",
  "keepn",
  "nowidctlpar",
  "widctlpar",
  "adjustright",
  "hyphpar",
  "tx",
  "tqc",
  "tqr",
  "tldot",
  "sect",
  "sectd",
  "page",
  "pagebb",
  "outlinelevel",
  // Character state.
  "b",
  "i",
  "ul",
  "ulnone",
  "strike",
  "caps",
  "scaps",
  "super",
  "sub",
  "nosupersub",
  "cf",
  "cb",
  "highlight",
  "expnd",
  "expndtw",
  "kerning",
  // Inline content.
  "tab",
  "line",
  "emdash",
  "endash",
  "emspace",
  "enspace",
  "bullet",
  "lquote",
  "rquote",
  "ldblquote",
  "rdblquote",
  "u",
  "chftn",
  "footnote",
  // Tables.
  "trowd",
  "intbl",
  "cell",
  "row",
  "cellx",
  "trgaph",
  "trleft",
  "trrh",
  "trqc",
  "trql",
  "trbrdrt",
  "trbrdrl",
  "trbrdrb",
  "trbrdrr",
  "clbrdrt",
  "clbrdrl",
  "clbrdrb",
  "clbrdrr",
  "clvertalt",
  "clvertalc",
  "clvertalb",
  "clvmgf",
  "clvmrg",
  "brdrs",
  "brdrw",
  "brdrcf",
  "brsp",
  "lastrow",
]);

const PARAGRAPH_ALIGNMENTS = {
  ql: "left",
  qc: "center",
  qr: "right",
  qj: "both",
} as const satisfies Record<string, ParagraphAlignment>;

/** Control words whose whole group is the writer's metadata, not the text. */
const SKIPPED_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "pict",
  "objdata",
  "objclass",
  "objname",
  "shprslt",
  "shppict",
  "nonshppict",
  "sp",
  "sn",
  "sv",
  "generator",
  "header",
  "headerl",
  "headerr",
  "headerf",
  "footer",
  "footerl",
  "footerr",
  "footerf",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "filetbl",
  "revtbl",
]);

/** Skipped tables establish font decoding and colours, never document content. */
const METADATA_CONTROL_WORDS = new Set([
  "fonttbl",
  "colortbl",
  "f",
  "fcharset",
  "deff",
  "red",
  "green",
  "blue",
]);

/** The literal characters a symbol control word stands for. */
const SYMBOL_CONTROL_WORDS = new Map<string, string>([
  ["emdash", "\u2014"],
  ["endash", "\u2013"],
  ["emspace", "\u2003"],
  ["enspace", "\u2002"],
  ["bullet", "\u2022"],
  ["lquote", "\u2018"],
  ["rquote", "\u2019"],
  ["ldblquote", "\u201c"],
  ["rdblquote", "\u201d"],
]);

type CharacterState = {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  colorIndex: number;
  /** `\fN`, or undefined for the document's `\deffN`. */
  font: number | undefined;
};

type ParagraphState = {
  alignment: ParagraphAlignment | undefined;
  inTable: boolean;
};

type GroupState = {
  character: CharacterState;
  paragraph: ParagraphState;
  /** Where text written inside this group goes. */
  destination: Destination;
  /** Replacement characters that follow each `\uN`, as `\ucN` last set it. */
  unicodeFallbackCount: number;
  /** Inside `\fonttbl`, where `\fN` defines a font rather than selects one. */
  fontTable: boolean;
};

/** A note being collected, and the paragraphs written into it so far. */
type OpenFootnote = { id: number; content: Paragraph[] };

type Destination =
  | { type: "body" }
  | { type: "footnote"; note: OpenFootnote }
  | { type: "embedded-container"; content: Paragraph[] }
  | { type: "embedded-text"; content: Paragraph[] }
  | { type: "skipped"; reason: "metadata" | "pending" | "unknown" };

const initialCharacterState = (): CharacterState => ({
  bold: false,
  italic: false,
  underline: false,
  colorIndex: 0,
  font: undefined,
});

const initialParagraphState = (): ParagraphState => ({
  alignment: undefined,
  inTable: false,
});

const copyGroupState = (state: GroupState): GroupState => ({
  character: { ...state.character },
  paragraph: { ...state.paragraph },
  destination: state.destination,
  unicodeFallbackCount: state.unicodeFallbackCount,
  fontTable: state.fontTable,
});

/**
 * The formatting one run carries, or `undefined` when it carries none.
 *
 * Omitted rather than written as all-false, so a reader walking this model
 * cannot tell a run the writer left plain from one it set plain — which is the
 * same distinction `parseDocx` preserves.
 */
const formattingOf = (
  state: CharacterState,
  colors: readonly ColorValue[],
): TextFormatting | undefined => {
  const color = colors[state.colorIndex];
  const formatting: TextFormatting = {
    ...(state.bold ? { bold: true } : {}),
    ...(state.italic ? { italic: true } : {}),
    ...(state.underline ? { underline: { style: "single" as const } } : {}),
    // Kept because this publisher marks its anonymised spans with a colour
    // whose table entry is plain black: dropping it would drop the marker.
    ...(state.colorIndex > 0 && color !== undefined ? { color } : {}),
  };
  return Object.keys(formatting).length === 0 ? undefined : formatting;
};

const sameFormatting = (
  left: TextFormatting | undefined,
  right: TextFormatting | undefined,
): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

/** One paragraph under construction, and the runs it has so far. */
type ParagraphBuffer = {
  content: ParagraphContent[];
  alignment: ParagraphAlignment | undefined;
  following: Paragraph[];
};

/**
 * Text accumulated for the run being written.
 *
 * Bytes and decoded characters are kept apart because they decode differently:
 * a `\'xx` byte is read against the code page in force when it was written,
 * and a `\uN` escape already names a code point. Joining them as bytes would
 * put a `\uN` character through the single-byte decoder. `label` is the code
 * page every byte in `bytes` was written under: a byte written under another
 * decodes the ones before it first, so no later font change, `\plain` or
 * group close can reread them.
 */
type PendingText = { bytes: number[]; label: CodePageLabel; text: string };

export type ReadRtfOptions = {
  /**
   * Code page to read `\'xx` bytes against when the document states none.
   * Defaults to windows-1252, which is what `\ansi` alone means.
   */
  defaultCodePage?: RtfCodePage | undefined;
};

const decodeBytes = (bytes: readonly number[], label: CodePageLabel): string =>
  bytes.length === 0
    ? ""
    : new TextDecoder(label).decode(Uint8Array.from(bytes));

/**
 * A run of bytes read as the ASCII it is: control words and the RTF signature
 * are ASCII by definition, so each byte is its own code point.
 */
const asciiOf = (bytes: Uint8Array | Uint16Array): string =>
  Array.from(bytes, (code) => String.fromCodePoint(code)).join("");

const HEX_DIGITS = "0123456789abcdefABCDEF";

const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

type RtfSource = string | Uint8Array | Uint16Array;
const unitAt = (source: RtfSource, index: number): number =>
  typeof source === "string"
    ? (source.codePointAt(index) ?? 0)
    : (source[index] ?? 0);
const asciiRange = (source: RtfSource, start: number, end: number): string =>
  typeof source === "string"
    ? source.slice(start, end)
    : asciiOf(source.subarray(start, end));

type RtfLexicalToken =
  | {
      type: "word";
      word: string;
      parameter: number | undefined;
      next: number;
      syntax: "valid" | "malformed";
    }
  | {
      type: "symbol";
      symbol: string;
      byte: number | undefined;
      next: number;
      syntax: "valid" | "malformed";
    };

// RTF 1.9.1 lexical boundaries are shared by decoding and residue detection.
// Decoder recovery is a separate policy; it cannot invent a residue token.
const readRtfToken = (
  source: RtfSource,
  start: number,
): RtfLexicalToken | null => {
  const first = start + 1;
  if (first >= source.length) {
    return null;
  }
  if (!isAsciiLetter(unitAt(source, first))) {
    const symbol = asciiRange(source, first, first + 1);
    if (symbol !== "'") {
      return {
        type: "symbol",
        symbol,
        byte: undefined,
        next: first + 1,
        syntax: "valid",
      };
    }
    const hex = asciiRange(source, first + 1, first + 3);
    const valid =
      hex.length === 2 &&
      Array.from(hex).every((digit) => HEX_DIGITS.includes(digit));
    return {
      type: "symbol",
      symbol,
      byte: valid ? Number.parseInt(hex, 16) : undefined,
      next: first + (valid ? 3 : 1),
      syntax: valid ? "valid" : "malformed",
    };
  }
  let lettersEnd = first;
  while (
    lettersEnd < source.length &&
    isAsciiLetter(unitAt(source, lettersEnd))
  ) {
    lettersEnd += 1;
  }
  let parameterStart = lettersEnd;
  const negative = unitAt(source, parameterStart) === 0x2d;
  if (negative) {
    parameterStart += 1;
  }
  let digitsEnd = parameterStart;
  while (digitsEnd < source.length && isAsciiDigit(unitAt(source, digitsEnd))) {
    digitsEnd += 1;
  }
  const parameter =
    digitsEnd === parameterStart
      ? undefined
      : Number(asciiRange(source, parameterStart, digitsEnd)) *
        (negative ? -1 : 1);
  const delimiter = parameter === undefined ? lettersEnd : digitsEnd;
  const code = unitAt(source, delimiter);
  return {
    type: "word",
    word: asciiRange(source, first, lettersEnd),
    parameter,
    next: delimiter + (code === 0x20 ? 1 : 0),
    syntax:
      lettersEnd - first <= 32 &&
      !isAsciiLetter(code) &&
      !isAsciiDigit(code) &&
      !(negative && digitsEnd === parameterStart)
        ? "valid"
        : "malformed",
  };
};

/**
 * Words the court's writer runs straight into the text after it, longest
 * first. They take no parameter, so nothing is lost by ending them early.
 */
const DELIMITER_OMITTED_WORDS = [
  "emdash",
  "endash",
  "bullet",
  "chftn",
  "line",
  "cell",
  "row",
  "tab",
  "par",
] as const;

type ControlToken = {
  /** The control word's letters, or `null` for a control symbol. */
  word: string | null;
  /** Its numeric parameter, where it has one. */
  parameter: number | undefined;
  /** Index just past the token, and past the one space that delimits it. */
  next: number;
};

/**
 * Read one control word, and recover the court writer's missing delimiter.
 *
 * RTF ends a control word at the first non-letter, so `\tabDr.Kovács` is the
 * word `tabDr` and the `Dr` is gone. The collection's signature blocks are
 * written exactly that way. Where the whole run of letters is not a word this
 * reader knows but a prefix of it is, the prefix is taken as the word and the
 * remainder is returned as text — which recovers the name rather than losing
 * it, and is reported by the caller either way.
 */
const readControlWord = (
  source: Uint8Array | Uint16Array,
  start: number,
): ControlToken => {
  const lexical = readRtfToken(source, start - 1);
  return decoderControlWord(lexical, start);
};

const decoderControlWord = (
  lexical: RtfLexicalToken | null,
  start: number,
): ControlToken => {
  if (lexical?.type !== "word") {
    return { word: null, parameter: undefined, next: start };
  }
  const letters = lexical.word.toLowerCase();
  if (!HANDLED_CONTROL_WORDS.has(letters)) {
    // Only the words that take no parameter and stand next to text are
    // recovered. A general longest-prefix search would read `\shpinst` as
    // `\s` plus the text `hpinst`, which invents words the document never had.
    const recovered = DELIMITER_OMITTED_WORDS.find((candidate) =>
      letters.startsWith(candidate),
    );
    if (recovered !== undefined) {
      // No parameter and no delimiter: what follows is the text the missing
      // delimiter ran into, and the scanner reads it as text from here.
      return {
        word: recovered,
        parameter: undefined,
        next: start + recovered.length,
      };
    }
  }

  return { word: letters, parameter: lexical.parameter, next: lexical.next };
};

/**
 * Where reading resumes after the replacement characters a `\uN` escape is
 * followed by, `count` of them as `\ucN` states. The writer gives each either
 * as the byte itself, as a `\'xx` escape, or as an escaped `\{`, `\}` or `\\`,
 * and each may sit on the next line: a line ending is the file's formatting,
 * not a character, so it is passed over first. Anything else (a control word,
 * a group) ends the replacement early and is left to the scanner.
 */
const afterFallbackCharacters = (
  source: Uint8Array | Uint16Array,
  start: number,
  count: number,
): number => {
  let resume = start;
  for (let skipped = 0; skipped < count; skipped += 1) {
    let cursor = resume;
    while (source[cursor] === 0x0d || source[cursor] === 0x0a) {
      cursor += 1;
    }
    const byte = source[cursor];
    if (byte === undefined || byte === 0x7b || byte === 0x7d) {
      return resume;
    }
    if (byte !== 0x5c) {
      resume = cursor + 1;
      continue;
    }
    const token = readRtfToken(source, cursor);
    if (
      token?.type !== "symbol" ||
      !(
        token.symbol === "{" ||
        token.symbol === "}" ||
        token.symbol === "\\" ||
        token.byte !== undefined
      )
    ) {
      return resume;
    }
    resume = token.next;
  }
  return resume;
};

type ReaderOutput = {
  blocks: BlockContent[];
  footnotes: Footnote[];
  warnings: string[];
};

const readRtfInto = (
  source: Uint8Array,
  options: ReadRtfOptions,
): ReaderOutput => {
  const blocks: BlockContent[] = [];
  const footnotes: Footnote[] = [];
  const unknownWords = new Set<string>();
  const colors: ColorValue[] = [];

  const codePageOf = (value: number | undefined): CodePageLabel | undefined =>
    value === undefined ? undefined : CODE_PAGE_LABELS.get(value);

  let codePageLabel: CodePageLabel =
    codePageOf(options.defaultCodePage) ?? DEFAULT_CODE_PAGE_LABEL;

  let state: GroupState = {
    character: initialCharacterState(),
    paragraph: initialParagraphState(),
    destination: { type: "body" },
    unicodeFallbackCount: 1,
    fontTable: false,
  };
  /** Each font's charset, from its `\fcharsetN`, where it states its own. */
  const fontCharsets = new Map<number, FontCharset>();
  let definingFont: number | undefined;
  let defaultFont: number | undefined;

  const currentFontCharset = (): FontCharset | undefined => {
    const font = state.character.font ?? defaultFont;
    return font === undefined ? undefined : fontCharsets.get(font);
  };
  /**
   * One frame per open group. `heldParagraph` is the body paragraph a
   * destination inside the group set aside: a footnote's text belongs to the
   * note, and the sentence it interrupts resumes when the group closes.
   */
  const stack: { state: GroupState; heldParagraph: ParagraphBuffer | null }[] =
    [];

  let paragraph: ParagraphBuffer = {
    content: [],
    alignment: undefined,
    following: [],
  };
  let pending: PendingText = { bytes: [], label: codePageLabel, text: "" };
  let pendingFormatting: TextFormatting | undefined;
  let hasPendingRun = false;

  /** Cells of the table row being read, and the rows of the table before it. */
  let tableCells: TableCell[] = [];
  let tableRows: TableRow[] = [];

  /** Notes opened so far, in the order the document opened them. */
  const openFootnotes: OpenFootnote[] = [];

  /**
   * Append a character the escape named outright, after the bytes read before
   * it: the two decode differently, and joining them at the end would reorder
   * the sentence.
   */
  const appendText = (text: string): void => {
    pending.text += decodeBytes(pending.bytes, pending.label) + text;
    pending.bytes = [];
  };

  /** A byte of text, read later against the code page in force now. */
  const appendByte = (byte: number): void => {
    const fontCharset = currentFontCharset();
    if (fontCharset?.type === "unsupported" && byte >= 0x80) {
      unknownWords.add(`fcharset${String(fontCharset.charset)}`);
    }
    const label =
      fontCharset?.type === "code-page" ? fontCharset.label : codePageLabel;
    if (label !== pending.label) {
      appendText("");
      pending.label = label;
    }
    pending.bytes.push(byte);
  };

  const flushRun = (): void => {
    const text = pending.text + decodeBytes(pending.bytes, pending.label);
    pending = { bytes: [], label: pending.label, text: "" };
    // A skipped destination is the writer's metadata: its text is not the
    // document's, and keeping it would print a colour table into the decision.
    if (
      text.length === 0 ||
      state.destination.type === "skipped" ||
      state.destination.type === "embedded-container"
    ) {
      return;
    }
    const last = paragraph.content.at(-1);
    if (
      last?.type === "run" &&
      hasPendingRun &&
      sameFormatting(last.formatting, pendingFormatting)
    ) {
      const lastContent = last.content.at(-1);
      if (lastContent?.type === "text") {
        lastContent.text += text;
        return;
      }
      last.content.push({ type: "text", text });
      return;
    }
    const run: Run = {
      type: "run",
      ...(pendingFormatting === undefined
        ? {}
        : { formatting: pendingFormatting }),
      content: [{ type: "text", text }],
    };
    paragraph.content.push(run);
    hasPendingRun = true;
  };

  /** Append a non-text run item (a tab, a break, a note reference). */
  const pushRunContent = (item: RunContent): void => {
    flushRun();
    const formatting = formattingOf(state.character, colors);
    paragraph.content.push({
      type: "run",
      ...(formatting === undefined ? {} : { formatting }),
      content: [item],
    });
    hasPendingRun = false;
  };

  const restyle = (): void => {
    flushRun();
    pendingFormatting = formattingOf(state.character, colors);
    hasPendingRun = false;
  };

  const takeParagraph = (): Paragraph => {
    flushRun();
    const built: Paragraph = {
      type: "paragraph",
      ...(paragraph.alignment === undefined
        ? {}
        : { formatting: { alignment: paragraph.alignment } }),
      content: paragraph.content,
    };
    paragraph = {
      content: [],
      alignment: state.paragraph.alignment,
      following: [],
    };
    hasPendingRun = false;
    return built;
  };

  const endParagraph = (): void => {
    const following = paragraph.following;
    const built = takeParagraph();
    switch (state.destination.type) {
      case "skipped":
        return;
      case "embedded-container":
        state.destination.content.push(...following);
        return;
      case "embedded-text":
        state.destination.content.push(built, ...following);
        return;
      case "footnote":
        state.destination.note.content.push(built, ...following);
        return;
      case "body":
        if (!state.paragraph.inTable) {
          // A paragraph outside the row grid ends the table it follows.
          closeTable();
        } else {
          // Word writes a table cell's paragraphs before its `\cell`, so a
          // paragraph mark inside a row belongs to the cell being filled.
          const cell = tableCells.at(-1);
          if (cell === undefined) {
            tableCells.push({
              type: "tableCell",
              content: [built, ...following],
            });
            return;
          }
          cell.content.push(built, ...following);
          return;
        }
        blocks.push(built, ...following);
        return;
      default:
        state.destination satisfies never;
        panic("Unhandled RTF destination");
    }
  };

  /**
   * Send what follows to another destination, keeping the paragraph it
   * interrupted for the group's close.
   */
  const enterDestination = (destination: Destination): void => {
    flushRun();
    const frame = stack.at(-1);
    if (frame?.heldParagraph === null) {
      frame.heldParagraph = paragraph;
      paragraph = { content: [], alignment: undefined, following: [] };
      hasPendingRun = false;
    }
    state.destination = destination;
  };

  const endCell = (): void => {
    const following = paragraph.following;
    const built = takeParagraph();
    const cell = tableCells.at(-1);
    if (cell === undefined || cell.content.length > 0) {
      tableCells.push({ type: "tableCell", content: [built, ...following] });
      return;
    }
    cell.content.push(built, ...following);
  };

  const endRow = (): void => {
    if (tableCells.length > 0) {
      tableRows.push({ type: "tableRow", cells: tableCells });
      tableCells = [];
    }
  };

  const closeTable = (): void => {
    if (tableRows.length === 0) {
      return;
    }
    const table: Table = { type: "table", rows: tableRows };
    blocks.push(table);
    tableRows = [];
  };

  /**
   * Apply a font word: which font the bytes that follow are written in, and,
   * inside the font table, which code page each font declares. Returns
   * whether the word was one.
   */
  const applyFontWord = (
    word: string,
    parameter: number | undefined,
  ): boolean => {
    switch (word) {
      case "deff":
        defaultFont = parameter;
        return true;
      case "f":
        if (state.fontTable) {
          definingFont = parameter;
          return true;
        }
        state.character.font = parameter;
        return true;
      case "fcharset": {
        if (
          !state.fontTable ||
          definingFont === undefined ||
          parameter === undefined ||
          DOCUMENT_FONT_CHARSETS.has(parameter)
        ) {
          return true;
        }
        const label = codePageOf(FONT_CHARSET_CODE_PAGES.get(parameter));
        fontCharsets.set(
          definingFont,
          label === undefined
            ? { type: "unsupported", charset: parameter }
            : { type: "code-page", label },
        );
        return true;
      }
      default:
        return false;
    }
  };

  /** Destination controls establish content boundaries before formatting is read. */
  const applyDestinationWord = (word: string): boolean => {
    // Only known drawing wrappers may expose nested text; a font table or
    // an unknown ignorable destination cannot turn its children into body text.
    const parent = stack.at(-1)?.state.destination;
    const mayReadEmbedded =
      state.destination.type !== "skipped" ||
      (state.destination.reason === "pending" && parent?.type !== "skipped");
    if (mayReadEmbedded && RTF_EMBEDDED_CONTAINERS.has(word)) {
      enterDestination({ type: "embedded-container", content: [] });
      return true;
    }
    if (mayReadEmbedded && RTF_VISIBLE_BLOCK_DESTINATIONS.has(word)) {
      enterDestination({ type: "embedded-text", content: [] });
      state.paragraph = initialParagraphState();
      return true;
    }
    if (
      state.destination.type === "skipped" &&
      state.destination.reason === "pending"
    ) {
      state.destination = { type: "skipped", reason: "unknown" };
    }
    if (SKIPPED_DESTINATIONS.has(word)) {
      enterDestination({ type: "skipped", reason: "metadata" });
      // Font/colour tables still establish decoding and formatting below.
      if (word !== "fonttbl" && word !== "colortbl") {
        return true;
      }
    }
    return false;
  };

  /**
   * Apply one control word.
   *
   * Its own function rather than a branch of the scanner: the dialect is
   * forty words wide and the scanner is a byte loop, and a reader that has
   * to hold both at once is reading two things.
   */
  const applyControlWord = (
    word: string,
    parameter: number | undefined,
  ): void => {
    if (applyDestinationWord(word)) {
      return;
    }
    if (!HANDLED_CONTROL_WORDS.has(word)) {
      if (
        state.destination.type !== "skipped" ||
        state.destination.reason === "unknown"
      ) {
        unknownWords.add(word);
      }
      return;
    }

    if (
      state.destination.type === "skipped" &&
      !METADATA_CONTROL_WORDS.has(word)
    ) {
      return;
    }

    if (word === "colortbl") {
      // `\cfN` indexes the table, and `{\colortbl ;\red…}` opens with an empty
      // entry that is index 0 — the auto colour. Seeding it keeps `\cf2` the
      // second colour the table defines rather than the third.
      colors.length = 0;
      colors.push({ auto: true });
    }

    if (word === "fonttbl") {
      state.fontTable = true;
    }

    if (applyFontWord(word, parameter)) {
      return;
    }

    switch (word) {
      case "ansicpg": {
        const label = codePageOf(parameter);
        if (label === undefined) {
          unknownWords.add(`ansicpg${parameter ?? ""}`);
          break;
        }
        codePageLabel = label;
        break;
      }
      // `\redN\greenN\blueN;` defines one table entry. What matters downstream
      // is that an entry exists at this index, not what it renders as: every
      // entry this publisher writes is plain black, and the colour is read as
      // an anonymisation marker rather than as a rendering instruction.
      case "red":
        colors.push({ rgb: "000000" });
        break;
      case "green":
      case "blue":
        break;
      // Source parsers classify headings per paragraph; all RTF line boundaries
      // must finish a paragraph while retaining formatting for the next line.
      case "line":
      case "page":
      case "sect":
      case "par":
        endParagraph();
        break;
      case "pard":
        state.paragraph = initialParagraphState();
        paragraph.alignment = undefined;
        closeTable();
        break;
      case "plain":
        state.character = initialCharacterState();
        restyle();
        break;
      case "ql":
      case "qc":
      case "qr":
      case "qj": {
        const alignment = PARAGRAPH_ALIGNMENTS[word];
        state.paragraph.alignment = alignment;
        paragraph.alignment = alignment;
        break;
      }
      case "b":
        state.character.bold = parameter !== 0;
        restyle();
        break;
      case "i":
        state.character.italic = parameter !== 0;
        restyle();
        break;
      case "ul":
        state.character.underline = parameter !== 0;
        restyle();
        break;
      case "ulnone":
        state.character.underline = false;
        restyle();
        break;
      case "cf":
        state.character.colorIndex = parameter ?? 0;
        restyle();
        break;
      case "tab":
        pushRunContent({ type: "tab" });
        break;
      case "u": {
        // Invalid code points must fail the structured parse: adapters retain
        // their source-text fallback instead of publishing a partial document.
        if (parameter === undefined) {
          unknownWords.add("u");
          break;
        }
        const codePoint = parameter < 0 ? parameter + 0x1_00_00 : parameter;
        appendText(String.fromCodePoint(codePoint));
        // The escape is followed by `\ucN` replacement characters for
        // readers that cannot decode it.
        cursor = afterFallbackCharacters(
          source,
          cursor,
          state.unicodeFallbackCount,
        );
        break;
      }
      case "uc":
        state.unicodeFallbackCount = Math.max(parameter ?? 1, 0);
        break;
      case "footnote": {
        const note: OpenFootnote = {
          id: openFootnotes.length + 1,
          content: [],
        };
        openFootnotes.push(note);
        pushRunContent({ type: "footnoteRef", id: note.id });
        // The note's own paragraphs follow inside this group; the body
        // paragraph is set aside and resumes when the group closes.
        enterDestination({ type: "footnote", note });
        break;
      }
      case "chftn":
        break;
      case "trowd":
        state.paragraph.inTable = true;
        break;
      case "intbl":
        state.paragraph.inTable = true;
        break;
      case "cell":
        endCell();
        break;
      case "row":
        endRow();
        break;
      case "lastrow":
        break;
      default: {
        const symbol = SYMBOL_CONTROL_WORDS.get(word);
        if (symbol !== undefined) {
          appendText(symbol);
        }
        break;
      }
    }
  };

  const enterIgnorableDestination = (): void => {
    if (
      state.destination.type === "skipped" &&
      state.destination.reason === "metadata"
    ) {
      return;
    }
    enterDestination({ type: "skipped", reason: "pending" });
  };

  const closeGroup = (): void => {
    flushRun();
    const frame = stack.pop();
    if (frame !== undefined) {
      if (frame.heldParagraph !== null) {
        // A note's last paragraph carries no `\par`: the group's close is
        // what ends it, and it is the note's text either way.
        const embedded =
          state.destination.type === "embedded-text" ||
          state.destination.type === "embedded-container"
            ? state.destination.content
            : [];
        if (paragraph.content.length > 0 || paragraph.following.length > 0) {
          endParagraph();
        }
        paragraph = frame.heldParagraph;
        paragraph.following.push(...embedded);
      }
      state = frame.state;
      pendingFormatting = formattingOf(state.character, colors);
      hasPendingRun = false;
    }
  };

  const closeOpenGroups = (): void => {
    while (stack.length > 0) {
      closeGroup();
    }
  };

  let cursor = 0;
  while (cursor < source.length) {
    const byte = source[cursor] ?? 0;

    if (byte === 0x7b) {
      flushRun();
      stack.push({ state: copyGroupState(state), heldParagraph: null });
      state = copyGroupState(state);
      cursor += 1;
      continue;
    }

    if (byte === 0x7d) {
      closeGroup();
      cursor += 1;
      continue;
    }

    if (byte !== 0x5c) {
      // Line endings between control words are the writer's formatting of the
      // file, never the document's text.
      if (byte !== 0x0d && byte !== 0x0a) {
        appendByte(byte);
      }
      cursor += 1;
      continue;
    }

    const lexical = readRtfToken(source, cursor);
    if (lexical === null) {
      cursor += 1;
      continue;
    }
    const after = source[cursor + 1] ?? 0;
    // Escaped literals and the `\'xx` byte.
    if (after === 0x5c || after === 0x7b || after === 0x7d) {
      appendByte(after);
      cursor = lexical.next;
      continue;
    }
    if (after === 0x27) {
      if (lexical.type === "symbol" && lexical.byte !== undefined) {
        appendByte(lexical.byte);
        cursor = lexical.next;
        continue;
      }
      unknownWords.add("'");
      cursor = lexical.next;
      continue;
    }
    if (after === 0x0d || after === 0x0a) {
      // `\<newline>` is this writer's paragraph mark, same as `\par`.
      endParagraph();
      cursor = lexical.next;
      continue;
    }
    if (after === 0x7e) {
      appendText("\u00a0");
      cursor = lexical.next;
      continue;
    }
    if (after === 0x2d) {
      // Optional hyphen: contributes nothing to the text.
      cursor = lexical.next;
      continue;
    }
    if (after === 0x5f) {
      appendText("\u2011");
      cursor = lexical.next;
      continue;
    }
    if (after === 0x2a) {
      // Unsupported destinations warn outside metadata; a metadata subgroup
      // inherits its exclusion instead of becoming a new unknown destination.
      enterIgnorableDestination();
      cursor = lexical.next;
      continue;
    }

    const token = decoderControlWord(lexical, cursor + 1);
    if (token.word === null) {
      unknownWords.add(String.fromCodePoint(after));
      cursor += 2;
      continue;
    }
    cursor = token.next;
    const { parameter, word } = token;

    if (word === "bin" && parameter !== undefined && parameter >= 0) {
      cursor = Math.min(source.length, cursor + parameter);
      continue;
    }
    applyControlWord(word, parameter);
  }

  // EOF closes every open group. In particular, this restores the body
  // paragraph held before an unterminated destination without promoting that
  // destination's metadata or binary payload into it.
  closeOpenGroups();
  const following = paragraph.following;
  const trailing = takeParagraph();
  if (trailing.content.length > 0) {
    blocks.push(trailing);
  }
  blocks.push(...following);
  closeTable();

  for (const { content, id } of openFootnotes) {
    footnotes.push({ type: "footnote", id, content });
  }

  return {
    blocks,
    footnotes,
    warnings: [...unknownWords]
      .toSorted()
      .map((word) => `rtf: unhandled control word \\${word}`),
  };
};

/**
 * Read RTF bytes into folio's document model.
 *
 * The twin of `parseDocx`: same model out, same "the bytes decide" contract in.
 * Synchronous, because RTF needs no archive opened and no fonts resolved.
 */
export const readRtf = (
  input: Uint8Array | ArrayBuffer,
  options: ReadRtfOptions = {},
): Document => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { blocks, footnotes, warnings } = readRtfInto(bytes, options);
  return {
    package: {
      document: { content: blocks },
      footnotes,
    },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
};

/**
 * Read RTF exposed through a Unicode transport such as an HTML form field.
 * The transport has already decoded literal non-ASCII characters, so encode
 * them as RTF Unicode controls while leaving the source's byte escapes intact.
 */
const rtfBytesFromUnicodeTransport = (source: string): Uint8Array => {
  const ascii: number[] = [];
  const appendUnicodeUnit = (unit: number): void => {
    const signed = unit > 0x7f_ff ? unit - 0x1_00_00 : unit;
    // Scope `\uc1` with the escape: the surrounding document may select a
    // different fallback width, but this transport-generated escape has one.
    for (const escaped of `{\\uc1\\u${String(signed)}?}`) {
      ascii.push(escaped.codePointAt(0) ?? 0);
    }
  };
  // Split by UTF-16 unit: Unicode escapes and opaque counts include separate
  // surrogate halves, even when the decoded transport contains astral text.
  const units = Uint16Array.from(
    source.split(""),
    (unit) => unit.codePointAt(0) ?? 0,
  );
  const fallbackStack: number[] = [];
  let fallbackCount = 1;
  const copyOpaque = (start: number, end: number): void => {
    for (let index = start; index < end; index += 1) {
      const unit = units[index] ?? 0;
      // These units are skipped by the reader. A decoded non-byte unit occupies
      // one opaque byte slot; emitting Unicode syntax here would change the count.
      ascii.push(unit <= 0xff ? unit : 0);
    }
  };
  let cursor = 0;
  while (cursor < units.length) {
    const unit = units[cursor] ?? 0;
    if (unit === 0x5c) {
      const token = readControlWord(units, cursor + 1);
      if (token.word !== null) {
        copyOpaque(cursor, token.next);
        cursor = token.next;
        if (
          token.word === "bin" &&
          token.parameter !== undefined &&
          token.parameter >= 0
        ) {
          const end = Math.min(units.length, cursor + token.parameter);
          copyOpaque(cursor, end);
          cursor = end;
        } else if (token.word === "uc") {
          fallbackCount = Math.max(token.parameter ?? 1, 0);
        } else if (
          token.word === "u" &&
          token.parameter !== undefined &&
          token.parameter >= -0x1_00_00 &&
          token.parameter <= 0x10_ff_ff
        ) {
          const end = afterFallbackCharacters(units, cursor, fallbackCount);
          copyOpaque(cursor, end);
          cursor = end;
        }
        continue;
      }
      // Escaped backslashes and braces are symbols, not token/group boundaries.
      if ([0x5c, 0x7b, 0x7d].includes(units[cursor + 1] ?? 0)) {
        copyOpaque(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
    }
    if (unit === 0x7b) {
      fallbackStack.push(fallbackCount);
    } else if (unit === 0x7d) {
      fallbackCount = fallbackStack.pop() ?? fallbackCount;
    }
    if (unit <= 0x7f) {
      ascii.push(unit);
    } else {
      appendUnicodeUnit(unit);
    }
    cursor += 1;
  }
  return Uint8Array.from(ascii);
};

export const readRtfString = (
  source: string,
  options: ReadRtfOptions = {},
): Document => readRtf(rtfBytesFromUnicodeTransport(source), options);

/** Every RTF file opens with this; nothing else the publisher serves does. */
const RTF_SIGNATURE = "{\\rtf";

export const isRtf = (bytes: Uint8Array): boolean =>
  asciiOf(bytes.subarray(0, RTF_SIGNATURE.length)) === RTF_SIGNATURE;

const KNOWN_RTF_CONTROLS = new Set<string>(RTF_CONTROLS);

type LiteralSpan = { start: number; end: number };
const LITERAL_QUOTE_CLOSERS = new Map([
  ['"', '"'],
  ["“", "”"],
  ["‘", "’"],
  ["'", "'"],
  ["`", "`"],
]);

type LiteralPathEndOptions = { text: string; start: number; tokenEnd: number };

const literalPathEnd = ({
  text,
  start,
  tokenEnd,
}: LiteralPathEndOptions): number => {
  let end = start;
  if (/^[a-zA-Z]:\\$/u.test(text.slice(start, start + 3))) {
    end += 3;
  } else if (text.slice(start, start + 2) === "\\\\") {
    end += 2;
  }
  while (end < tokenEnd) {
    const char = text.charAt(end);
    if ("\"“”‘’'`<>|".includes(char)) {
      break;
    }
    if (".,;:!?)]}".includes(char)) {
      let punctuationEnd = end + 1;
      while (
        punctuationEnd < tokenEnd &&
        ".,;:!?)]}".includes(text.charAt(punctuationEnd))
      ) {
        punctuationEnd += 1;
      }
      const nextToken =
        text.charAt(punctuationEnd) === "\\"
          ? readRtfToken(text, punctuationEnd)
          : null;
      const followedByControl =
        nextToken?.type === "word" &&
        nextToken.syntax === "valid" &&
        KNOWN_RTF_CONTROLS.has(nextToken.word);
      if (
        punctuationEnd === tokenEnd ||
        "\"“”‘’'`".includes(text.charAt(punctuationEnd)) ||
        followedByControl
      ) {
        break;
      }
      end = punctuationEnd;
      continue;
    }
    end += 1;
  }
  return end;
};

// Only complete path tokens and paired quotation/code spans are literal escapes.
// All other backslashes reach the lexer, including those immediately after text.
const rtfLiteralSpans = (text: string): LiteralSpan[] => {
  const spans: LiteralSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text.charAt(cursor);
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    const closing = LITERAL_QUOTE_CLOSERS.get(char);
    if (
      closing === undefined ||
      (char === "'" &&
        cursor > 0 &&
        /[\p{L}\p{N}]/u.test(text.charAt(cursor - 1)))
    ) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    let width = 1;
    if (char === "`") {
      while (text.charAt(cursor + width) === "`") {
        width += 1;
      }
    }
    cursor += width;
    while (cursor < text.length) {
      if (text.charAt(cursor) === "\\" && closing !== "`") {
        cursor += 2;
        continue;
      }
      if (text.charAt(cursor) !== closing) {
        cursor += 1;
        continue;
      }
      if (
        closing === "'" &&
        /[\p{L}\p{N}]/u.test(text.charAt(cursor - 1)) &&
        /[\p{L}\p{N}]/u.test(text.charAt(cursor + 1))
      ) {
        cursor += 1;
        continue;
      }
      let closingWidth = 1;
      if (closing === "`") {
        while (text.charAt(cursor + closingWidth) === "`") {
          closingWidth += 1;
        }
      }
      cursor += closingWidth;
      if (closingWidth >= width) {
        spans.push({ start, end: cursor });
        break;
      }
    }
  }
  // Paths remain literal even after an unmatched quotation mark. Each token
  // and each quote/code delimiter run is scanned only once.
  const paths: LiteralSpan[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const token = match[0];
    const path = /(?:[a-zA-Z]:\\|\\\\[^\\\s]+\\[^\\\s]+)/u.exec(token);
    if (path) {
      const start = match.index + path.index;
      const tokenEnd = match.index + token.length;
      const end = literalPathEnd({ text, start, tokenEnd });
      paths.push({
        start,
        end,
      });
    }
  }
  const ordered: LiteralSpan[] = [];
  const pathIterator = paths.values();
  let path = pathIterator.next();
  for (const span of spans) {
    while (!path.done && path.value.start < span.start) {
      ordered.push(path.value);
      path = pathIterator.next();
    }
    ordered.push(span);
  }
  while (!path.done) {
    ordered.push(path.value);
    path = pathIterator.next();
  }
  return ordered;
};

// parser-output-unchanged: [cz-us] Shared lexical scanning preserves the decoder's existing recovery policy.
// parser-output-unchanged: [hu-bhgy] Shared lexical scanning preserves the decoder's existing recovery policy.
/**
 * Recognize known spec tokens without decoding or changing publisher text.
 * @yields Recognized control spans outside literal path and quoted/code spans.
 */
export function* rtfControlResidueMatchesIn(
  text: string,
): Generator<{ index: number; matched: string }> {
  const literalSpans = rtfLiteralSpans(text);
  let literalIndex = 0;
  let cursor = 0;
  while (cursor < text.length) {
    let literal = literalSpans.at(literalIndex);
    while (literal && literal.end <= cursor) {
      literalIndex += 1;
      literal = literalSpans.at(literalIndex);
    }
    if (literal && literal.start <= cursor) {
      cursor = literal.end;
      continue;
    }
    if (text.charAt(cursor) !== "\\") {
      cursor += 1;
      continue;
    }
    const token = readRtfToken(text, cursor);
    if (token === null) {
      cursor += 1;
      continue;
    }
    const control = token.type === "word" ? token.word : token.symbol;
    if (token.syntax === "valid" && KNOWN_RTF_CONTROLS.has(control)) {
      // The one consumed word-delimiting space is not part of the finding.
      const end =
        token.type === "word" && text.charAt(token.next - 1) === " "
          ? token.next - 1
          : token.next;
      yield { index: cursor, matched: text.slice(cursor, end) };
    }
    cursor = token.next;
  }
}
