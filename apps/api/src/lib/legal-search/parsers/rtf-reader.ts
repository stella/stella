/**
 * An RTF reader that answers in folio's document model.
 *
 * `parseDocx` from `@stll/folio-core/server` returns a `Document` — a package
 * whose body is `BlockContent[]` of paragraphs and tables, whose runs carry
 * `TextFormatting`, and whose notes hang off `package.footnotes`. A court that
 * publishes half its collection as RTF and half as DOCX otherwise needs two
 * parsers, one per encoding, and the second one is where the drift starts. So
 * this reads RTF into that same model and is named for the `parseRtf` it would
 * be if it moved into folio-core: one reader per encoding, one parser per
 * court.
 *
 * Scope is the court dialect, not the RTF specification: groups, control words
 * with an optional numeric parameter, `\'xx` bytes against the document's
 * `\ansicpgN` code page, `\uN?` escapes, `\par`/`\pard`, `\line`, `\tab`, the
 * character state (`\b`, `\i`, `\ul`, `\cfN`), alignment, `\trowd`/`\cell`/
 * `\row` tables, and `\footnote`. Header tables (`\fonttbl`, `\colortbl`,
 * `\stylesheet`, `\info`) and every `\*` destination are skipped, because they
 * are the writer's own metadata rather than the document's text.
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

/**
 * Code pages `\ansicpgN` selects, and the label `TextDecoder` knows each by.
 *
 * Both of the court's writers appear in the collection — Central European and
 * Western European — and a byte read against the wrong one is a silently wrong
 * letter rather than a failure, so the mapping is explicit and a code page
 * outside it is reported instead of guessed at.
 */
const ANSI_CODE_PAGES = [
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1257, "windows-1257"],
  [437, "ibm866"],
  [10_000, "macintosh"],
] as const;

/** The labels above, as the decoder's own vocabulary. */
type CodePageLabel = (typeof ANSI_CODE_PAGES)[number][1];

const CODE_PAGE_LABELS = new Map<number, CodePageLabel>(ANSI_CODE_PAGES);

const DEFAULT_CODE_PAGE_LABEL: CodePageLabel = "windows-1252";

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
  "object",
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
};

/** A note being collected, and the paragraphs written into it so far. */
type OpenFootnote = { id: number; content: Paragraph[] };

type Destination =
  | { type: "body" }
  | { type: "footnote"; note: OpenFootnote }
  | { type: "skipped" };

const initialCharacterState = (): CharacterState => ({
  bold: false,
  italic: false,
  underline: false,
  colorIndex: 0,
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
};

/**
 * Text accumulated for the run being written.
 *
 * Bytes and decoded characters are kept apart because they decode differently:
 * a `\'xx` byte is read against the document's code page, and a `\uN` escape
 * already names a code point. Joining them as bytes would put a `\uN`
 * character through the single-byte decoder.
 */
type PendingText = { bytes: number[]; text: string };

export type ReadRtfOptions = {
  /**
   * Code page to read `\'xx` bytes against when the document states none.
   * Defaults to windows-1252, which is what `\ansi` alone means.
   */
  defaultCodePage?: number | undefined;
};

const decodeBytes = (bytes: readonly number[], label: CodePageLabel): string =>
  bytes.length === 0
    ? ""
    : new TextDecoder(label).decode(Uint8Array.from(bytes));

/**
 * A run of bytes read as the ASCII it is: control words and the RTF signature
 * are ASCII by definition, so each byte is its own code point.
 */
const asciiOf = (bytes: Uint8Array): string => String.fromCodePoint(...bytes);

const HEX_DIGITS = "0123456789abcdefABCDEF";

const isAsciiLetter = (code: number): boolean =>
  (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

const isAsciiDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;

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
const readControlWord = (source: Uint8Array, start: number): ControlToken => {
  let cursor = start;
  while (cursor < source.length && isAsciiLetter(source[cursor] ?? 0)) {
    cursor += 1;
  }
  const letters = asciiOf(source.subarray(start, cursor));
  if (letters.length === 0) {
    return { word: null, parameter: undefined, next: start };
  }

  const word = letters;
  const consumed = cursor;
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

  let parameterStart = consumed;
  let negative = false;
  if (source[parameterStart] === 0x2d) {
    negative = true;
    parameterStart += 1;
  }
  let digits = parameterStart;
  while (digits < source.length && isAsciiDigit(source[digits] ?? 0)) {
    digits += 1;
  }
  const parameter =
    digits === parameterStart
      ? undefined
      : Number(asciiOf(source.subarray(parameterStart, digits))) *
        (negative ? -1 : 1);
  let next = parameter === undefined ? consumed : digits;
  // One space after a control word is its delimiter and not text.
  if (source[next] === 0x20) {
    next += 1;
  }
  return { word, parameter, next };
};

/**
 * Where reading resumes after the replacement characters a `\uN` escape is
 * followed by, `count` of them as `\ucN` states. The writer gives each either
 * as the byte itself or as a `\'xx` escape, and either may sit on the next
 * line: a line ending is the file's formatting, not a character, so it is
 * passed over first. Anything else (a control word, a group) ends the
 * replacement early and is left to the scanner.
 */
const afterFallbackCharacters = (
  source: Uint8Array,
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
    const high = String.fromCodePoint(source[cursor + 2] ?? 0);
    const low = String.fromCodePoint(source[cursor + 3] ?? 0);
    if (
      source[cursor + 1] !== 0x27 ||
      !HEX_DIGITS.includes(high) ||
      !HEX_DIGITS.includes(low)
    ) {
      return resume;
    }
    resume = cursor + 4;
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
  };
  /**
   * One frame per open group. `heldParagraph` is the body paragraph a
   * destination inside the group set aside: a footnote's text belongs to the
   * note, and the sentence it interrupts resumes when the group closes.
   */
  const stack: { state: GroupState; heldParagraph: ParagraphBuffer | null }[] =
    [];

  let paragraph: ParagraphBuffer = { content: [], alignment: undefined };
  let pending: PendingText = { bytes: [], text: "" };
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
    pending.text += decodeBytes(pending.bytes, codePageLabel) + text;
    pending.bytes = [];
  };

  const flushRun = (): void => {
    const text = pending.text + decodeBytes(pending.bytes, codePageLabel);
    pending = { bytes: [], text: "" };
    // A skipped destination is the writer's metadata: its text is not the
    // document's, and keeping it would print a colour table into the decision.
    if (text.length === 0 || state.destination.type === "skipped") {
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
    paragraph = { content: [], alignment: state.paragraph.alignment };
    hasPendingRun = false;
    return built;
  };

  const endParagraph = (): void => {
    const built = takeParagraph();
    switch (state.destination.type) {
      case "skipped":
        return;
      case "footnote":
        state.destination.note.content.push(built);
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
            tableCells.push({ type: "tableCell", content: [built] });
            return;
          }
          cell.content.push(built);
          return;
        }
        blocks.push(built);
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
      paragraph = { content: [], alignment: undefined };
      hasPendingRun = false;
    }
    state.destination = destination;
  };

  const endCell = (): void => {
    const built = takeParagraph();
    const cell = tableCells.at(-1);
    if (cell === undefined || cell.content.length > 0) {
      tableCells.push({ type: "tableCell", content: [built] });
      return;
    }
    cell.content.push(built);
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
    if (!HANDLED_CONTROL_WORDS.has(word)) {
      // Inside a destination this reader skips whole, the writer's own
      // vocabulary is not the document's: reporting `\fname` from a font table
      // would make every file look degraded.
      if (state.destination.type !== "skipped") {
        unknownWords.add(word);
      }
      return;
    }

    if (word === "colortbl") {
      // `\cfN` indexes the table, and `{\colortbl ;\red…}` opens with an empty
      // entry that is index 0 — the auto colour. Seeding it keeps `\cf2` the
      // second colour the table defines rather than the third.
      colors.length = 0;
      colors.push({ auto: true });
    }

    if (SKIPPED_DESTINATIONS.has(word)) {
      enterDestination({ type: "skipped" });
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
      case "line":
        pushRunContent({ type: "break", breakType: "textWrapping" });
        break;
      case "page":
        pushRunContent({ type: "break", breakType: "page" });
        break;
      case "u": {
        // RTF writes a code point above 0x7fff as a negative 16-bit value, so
        // the escape's own range is one 16-bit word. Anything outside it is a
        // number `String.fromCodePoint` throws on, and a throw here would lose
        // the whole document to one malformed escape.
        if (parameter === undefined) {
          unknownWords.add("u");
          break;
        }
        const codePoint = parameter < 0 ? parameter + 0x1_00_00 : parameter;
        if (codePoint < 0 || codePoint > 0x10_ff_ff) {
          unknownWords.add(`u${parameter}`);
          break;
        }
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
      flushRun();
      const frame = stack.pop();
      if (frame !== undefined) {
        if (frame.heldParagraph !== null) {
          // A note's last paragraph carries no `\par`: the group's close is
          // what ends it, and it is the note's text either way.
          if (paragraph.content.length > 0) {
            endParagraph();
          }
          paragraph = frame.heldParagraph;
        }
        state = frame.state;
        pendingFormatting = formattingOf(state.character, colors);
        hasPendingRun = false;
      }
      cursor += 1;
      continue;
    }

    if (byte !== 0x5c) {
      // Line endings between control words are the writer's formatting of the
      // file, never the document's text.
      if (byte !== 0x0d && byte !== 0x0a) {
        pending.bytes.push(byte);
      }
      cursor += 1;
      continue;
    }

    const after = source[cursor + 1];
    if (after === undefined) {
      cursor += 1;
      continue;
    }

    // Escaped literals and the `\'xx` byte.
    if (after === 0x5c || after === 0x7b || after === 0x7d) {
      pending.bytes.push(after);
      cursor += 2;
      continue;
    }
    if (after === 0x27) {
      const high = String.fromCodePoint(source[cursor + 2] ?? 0);
      const low = String.fromCodePoint(source[cursor + 3] ?? 0);
      if (HEX_DIGITS.includes(high) && HEX_DIGITS.includes(low)) {
        pending.bytes.push(Number.parseInt(`${high}${low}`, 16));
        cursor += 4;
        continue;
      }
      unknownWords.add("'");
      cursor += 2;
      continue;
    }
    if (after === 0x0d || after === 0x0a) {
      // `\<newline>` is this writer's paragraph mark, same as `\par`.
      endParagraph();
      cursor += 2;
      continue;
    }
    if (after === 0x7e) {
      appendText("\u00a0");
      cursor += 2;
      continue;
    }
    if (after === 0x2d) {
      // Optional hyphen: contributes nothing to the text.
      cursor += 2;
      continue;
    }
    if (after === 0x5f) {
      appendText("\u2011");
      cursor += 2;
      continue;
    }
    if (after === 0x2a) {
      // `\*` marks a destination a reader that does not know it must skip
      // whole, which is every one of them here.
      enterDestination({ type: "skipped" });
      cursor += 2;
      continue;
    }

    const token = readControlWord(source, cursor + 1);
    if (token.word === null) {
      unknownWords.add(String.fromCodePoint(after));
      cursor += 2;
      continue;
    }
    cursor = token.next;
    const { parameter, word } = token;

    applyControlWord(word, parameter);
  }

  // Whatever the writer left unterminated is still the document's text.
  const trailing = takeParagraph();
  if (trailing.content.length > 0) {
    blocks.push(trailing);
  }
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
      ...(footnotes.length === 0 ? {} : { footnotes }),
    },
    ...(warnings.length === 0 ? {} : { warnings }),
  };
};

/** Every RTF file opens with this; nothing else the publisher serves does. */
const RTF_SIGNATURE = "{\\rtf";

export const isRtf = (bytes: Uint8Array): boolean =>
  asciiOf(bytes.subarray(0, RTF_SIGNATURE.length)) === RTF_SIGNATURE;
