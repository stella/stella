/**
 * The paragraphs an RTF file states, read straight from its control words.
 *
 * Written for retention projections, so it shares nothing with the RTF reader
 * the parsers use: the check compares a parse against the publisher's file,
 * and a comparison text produced by the reader under test would lose exactly
 * what that reader loses. It keeps what a reader of the file sees: the body
 * text and the footnotes, decoded through the code page the file (or the font
 * a run is set in) declares. Destinations that are not text on the page are
 * skipped: the font, colour and style tables, document properties, pictures,
 * page headers and footers, field instructions, and every `\*` destination a
 * reader is allowed to ignore. Hidden runs (`\v`) are skipped too.
 */
import { parseIntegerToken } from "@stll/agent-input/numeric-token";

import { hexValue } from "@/api/handlers/case-law/ingestion/retention/sources/hex-value";

/** Destinations whose text is never visible on the page. */
const SKIPPED_DESTINATIONS = new Set([
  "annotation",
  "atnauthor",
  "atnid",
  "author",
  "colortbl",
  "comment",
  "datastore",
  "fldinst",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "info",
  "listoverridetable",
  "listtable",
  "nonshppict",
  "object",
  "objdata",
  "operator",
  "pict",
  "revtbl",
  "rsidtbl",
  "stylesheet",
  "subject",
  "themedata",
  "title",
  "xe",
]);

/** Control words standing for one character. */
const CHARACTER_WORDS = new Map([
  ["bullet", "•"],
  ["emdash", "—"],
  ["emspace", " "],
  ["endash", "–"],
  ["enspace", " "],
  ["ldblquote", "“"],
  ["lquote", "‘"],
  ["qmspace", " "],
  ["rdblquote", "”"],
  ["rquote", "’"],
  ["tab", "\t"],
  ["cell", "\t"],
  ["line", "\n"],
]);

/** Control words that end a paragraph. */
const PARAGRAPH_WORDS = new Set(["par", "sect", "page", "row"]);

/** Control symbols standing for one character (or for none), by byte. */
const CHARACTER_SYMBOLS = new Map([
  [0x7e, " "],
  [0x5f, "‑"],
  [0x2d, ""],
  [0x5c, "\\"],
  [0x7b, "{"],
  [0x7d, "}"],
]);

/** Windows code page of an RTF `\fcharset` value. */
const CHARSET_CODE_PAGES = new Map([
  [0, 1252],
  [2, 1252],
  [128, 932],
  [129, 949],
  [134, 936],
  [136, 950],
  [161, 1253],
  [162, 1254],
  [163, 1258],
  [177, 1255],
  [178, 1256],
  [186, 1257],
  [204, 1251],
  [222, 874],
  [238, 1250],
]);

type DecoderLabel = NonNullable<ConstructorParameters<typeof TextDecoder>[0]>;

/** The WHATWG label of every code page the runtime's decoder knows. */
const CODE_PAGE_LABELS = new Map<number, DecoderLabel>([
  [874, "windows-874"],
  [932, "shift_jis"],
  [936, "gbk"],
  [949, "euc-kr"],
  [950, "big5"],
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1255, "windows-1255"],
  [1256, "windows-1256"],
  [1257, "windows-1257"],
  [1258, "windows-1258"],
  [10_000, "macintosh"],
]);

const decoders = new Map<number, TextDecoder>();

/** A decoder for the code page, or for Western European when it is unknown. */
const decoderFor = (codePage: number): TextDecoder => {
  const cached = decoders.get(codePage);
  if (cached !== undefined) {
    return cached;
  }
  const decoder = new TextDecoder(
    CODE_PAGE_LABELS.get(codePage) ?? "windows-1252",
  );
  decoders.set(codePage, decoder);
  return decoder;
};

/** Control words, parameters and hex digits are ASCII. */
const ascii = new TextDecoder();

const BACKSLASH = 0x5c;
const OPEN_GROUP = 0x7b;
const CLOSE_GROUP = 0x7d;
const APOSTROPHE = 0x27;
const ASTERISK = 0x2a;
const HYPHEN = 0x2d;
const SPACE = 0x20;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

const isLetter = (byte: number): boolean =>
  (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a);
const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isLineBreak = (byte: number): boolean =>
  byte === LINE_FEED || byte === CARRIAGE_RETURN;

/** What one group sets, restored when it closes. */
type GroupState = {
  /** A destination whose text is not visible. */
  skipped: boolean;
  hidden: boolean;
  /** Inside the font table, where `\f` and `\fcharset` describe fonts. */
  fontTable: boolean;
  footnote: boolean;
  /** Characters a reader skips after each `\u`. */
  unicodeSkip: number;
  font: number | undefined;
};

const copyGroup = (group: GroupState): GroupState => ({
  skipped: group.skipped,
  hidden: group.hidden,
  fontTable: group.fontTable,
  footnote: group.footnote,
  unicodeSkip: group.unicodeSkip,
  font: group.font,
});

/** Everything one read accumulates. */
type Reader = {
  readonly body: string[];
  readonly notes: string[];
  paragraph: string;
  note: string;
  /** Bytes awaiting decoding through the current code page. */
  pending: number[];
  documentCodePage: number;
  /** The font a run without its own `\f` is set in. */
  defaultFont: number | undefined;
  readonly fontCodePages: Map<number, number>;
  /** Characters still to skip after a `\u`. */
  skipCount: number;
  group: GroupState;
  readonly stack: GroupState[];
  /** Whether the next control word is the first of its group. */
  groupStart: boolean;
  /** Whether the group just opened with `\*`. */
  ignorable: boolean;
};

const codePageOf = (reader: Reader): number => {
  const font = reader.group.font ?? reader.defaultFont;
  return (
    (font === undefined ? undefined : reader.fontCodePages.get(font)) ??
    reader.documentCodePage
  );
};

const isVisible = ({ group }: Reader): boolean =>
  !group.skipped && !group.hidden && !group.fontTable;

const append = (reader: Reader, text: string): void => {
  if (reader.group.footnote) {
    reader.note += text;
  } else {
    reader.paragraph += text;
  }
};

const flushBytes = (reader: Reader): void => {
  if (reader.pending.length === 0) {
    return;
  }
  if (isVisible(reader)) {
    append(
      reader,
      decoderFor(codePageOf(reader)).decode(new Uint8Array(reader.pending)),
    );
  }
  reader.pending = [];
};

const endParagraph = (reader: Reader): void => {
  flushBytes(reader);
  if (reader.group.footnote) {
    reader.notes.push(reader.note);
    reader.note = "";
  } else {
    reader.body.push(reader.paragraph);
    reader.paragraph = "";
  }
};

/** Whether a character skipped after `\u` consumed this token. */
const consumedBySkip = (reader: Reader): boolean => {
  if (reader.skipCount === 0) {
    return false;
  }
  reader.skipCount -= 1;
  return true;
};

/** The first control word of a group names its destination. */
const enterDestination = (reader: Reader, word: string): void => {
  reader.groupStart = false;
  if (reader.ignorable || SKIPPED_DESTINATIONS.has(word)) {
    reader.group.skipped = true;
  }
  if (word === "fonttbl") {
    reader.group.fontTable = true;
  }
  if (word === "footnote") {
    reader.group.footnote = true;
  }
};

/** A font table entry: its number, then the character set it is in. */
const describeFont = (
  reader: Reader,
  word: string,
  parameter: number | undefined,
): void => {
  if (word === "f" && parameter !== undefined) {
    reader.group.font = parameter;
    return;
  }
  const font = reader.group.font;
  const page =
    word === "fcharset" && parameter !== undefined
      ? CHARSET_CODE_PAGES.get(parameter)
      : undefined;
  if (font !== undefined && page !== undefined) {
    reader.fontCodePages.set(font, page);
  }
};

/** Words that change how text is decoded or whether it shows. */
const applyFormatting = (
  reader: Reader,
  word: string,
  parameter: number | undefined,
): boolean => {
  switch (word) {
    case "ansicpg":
      if (parameter !== undefined && parameter > 0) {
        reader.documentCodePage = parameter;
      }
      return true;
    case "deff":
      reader.defaultFont = parameter;
      return true;
    case "f":
      flushBytes(reader);
      reader.group.font = parameter;
      return true;
    case "plain":
      flushBytes(reader);
      reader.group.hidden = false;
      reader.group.font = undefined;
      return true;
    case "v":
      flushBytes(reader);
      reader.group.hidden = parameter !== 0;
      return true;
    case "uc":
      reader.group.unicodeSkip = parameter ?? 1;
      return true;
    default:
      return false;
  }
};

/** `\uN`: one UTF-16 unit, signed, then the fallback characters to skip. */
const appendUnicode = (reader: Reader, parameter: number | undefined): void => {
  flushBytes(reader);
  if (parameter !== undefined) {
    const unit = parameter < 0 ? parameter + 0x1_00_00 : parameter;
    if (unit >= 0 && unit <= 0xff_ff && isVisible(reader)) {
      append(reader, String.fromCodePoint(unit));
    }
  }
  reader.skipCount = reader.group.unicodeSkip;
};

const controlWord = (
  reader: Reader,
  word: string,
  parameter: number | undefined,
): void => {
  if (reader.groupStart) {
    enterDestination(reader, word);
  }
  if (word === "u") {
    appendUnicode(reader, parameter);
    return;
  }
  if (consumedBySkip(reader)) {
    return;
  }
  if (reader.group.fontTable) {
    describeFont(reader, word, parameter);
    return;
  }
  if (applyFormatting(reader, word, parameter)) {
    return;
  }
  if (PARAGRAPH_WORDS.has(word)) {
    if (isVisible(reader) || reader.group.footnote) {
      endParagraph(reader);
    }
    return;
  }
  const character = CHARACTER_WORDS.get(word);
  if (character !== undefined && isVisible(reader)) {
    flushBytes(reader);
    append(reader, character);
  }
};

const openGroup = (reader: Reader): void => {
  flushBytes(reader);
  reader.stack.push(reader.group);
  reader.group = copyGroup(reader.group);
  reader.groupStart = true;
  reader.ignorable = false;
  reader.skipCount = 0;
};

const closeGroup = (reader: Reader): void => {
  flushBytes(reader);
  const closingFootnote = reader.group.footnote;
  reader.group = reader.stack.pop() ?? reader.group;
  // A note's last paragraph needs no `\par`: the group's end closes it.
  if (closingFootnote && !reader.group.footnote && reader.note.length > 0) {
    reader.notes.push(reader.note);
    reader.note = "";
  }
  reader.groupStart = false;
  reader.skipCount = 0;
};

/** Read a control word at `index` (its backslash) and return where it ends. */
const readControlWord = (
  reader: Reader,
  bytes: Uint8Array,
  index: number,
): number => {
  let end = index + 1;
  while (end < bytes.length && isLetter(bytes[end] ?? 0)) {
    end += 1;
  }
  const word = ascii.decode(bytes.subarray(index + 1, end));
  let parameterEnd = bytes[end] === HYPHEN ? end + 1 : end;
  while (parameterEnd < bytes.length && isDigit(bytes[parameterEnd] ?? 0)) {
    parameterEnd += 1;
  }
  const parameter = parseIntegerToken(
    ascii.decode(bytes.subarray(end, parameterEnd)),
  ).unwrapOr(undefined);
  // One space after a control word is its delimiter, not text.
  const next = bytes[parameterEnd] === SPACE ? parameterEnd + 1 : parameterEnd;
  // `\binN` is followed by N raw bytes that are data, never text.
  if (word === "bin" && parameter !== undefined && parameter > 0) {
    return next + parameter;
  }
  controlWord(reader, word, parameter);
  return next;
};

/** Read a control symbol at `index` (its backslash) and return where it ends. */
const readControlSymbol = (
  reader: Reader,
  bytes: Uint8Array,
  index: number,
): number => {
  const symbol = bytes[index + 1] ?? 0;
  if (symbol === APOSTROPHE) {
    const byte = hexValue(
      ascii.decode(bytes.subarray(index + 2, index + 4)),
      2,
    );
    if (byte !== undefined && !consumedBySkip(reader)) {
      reader.pending.push(byte);
    }
    return index + 4;
  }
  if (symbol === ASTERISK) {
    reader.ignorable = reader.groupStart;
    return index + 2;
  }
  if (isLineBreak(symbol)) {
    controlWord(reader, "par", undefined);
    return index + 2;
  }
  reader.groupStart = false;
  const text = CHARACTER_SYMBOLS.get(symbol);
  if (!consumedBySkip(reader) && text !== undefined && isVisible(reader)) {
    flushBytes(reader);
    append(reader, text);
  }
  return index + 2;
};

/** A byte of running text: ASCII as is, anything higher through the code page. */
const readTextByte = (reader: Reader, byte: number): void => {
  if (isLineBreak(byte)) {
    return;
  }
  reader.groupStart = false;
  if (consumedBySkip(reader)) {
    return;
  }
  if (byte >= 0x80) {
    reader.pending.push(byte);
    return;
  }
  if (isVisible(reader)) {
    flushBytes(reader);
    append(reader, String.fromCodePoint(byte));
  }
};

/**
 * The paragraphs of an RTF file, body first and footnotes after it, or
 * `null` for bytes that do not open as RTF.
 */
export const rtfParagraphs = (bytes: Uint8Array): string[] | null => {
  if (ascii.decode(bytes.subarray(0, 5)) !== "{\\rtf") {
    return null;
  }
  const reader: Reader = {
    body: [],
    notes: [],
    paragraph: "",
    note: "",
    pending: [],
    documentCodePage: 1252,
    defaultFont: undefined,
    fontCodePages: new Map(),
    skipCount: 0,
    group: {
      skipped: false,
      hidden: false,
      fontTable: false,
      footnote: false,
      unicodeSkip: 1,
      font: undefined,
    },
    stack: [],
    groupStart: false,
    ignorable: false,
  };
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    if (byte === OPEN_GROUP) {
      openGroup(reader);
      index += 1;
    } else if (byte === CLOSE_GROUP) {
      closeGroup(reader);
      index += 1;
    } else if (byte === BACKSLASH) {
      index = isLetter(bytes[index + 1] ?? 0)
        ? readControlWord(reader, bytes, index)
        : readControlSymbol(reader, bytes, index);
    } else {
      readTextByte(reader, byte);
      index += 1;
    }
  }
  flushBytes(reader);
  if (reader.paragraph.length > 0) {
    reader.body.push(reader.paragraph);
  }
  if (reader.note.length > 0) {
    reader.notes.push(reader.note);
  }
  return [...reader.body, ...reader.notes];
};
