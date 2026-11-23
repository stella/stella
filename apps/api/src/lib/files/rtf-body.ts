/**
 * A message body written in RTF, as Outlook stores it, read for display: the
 * HTML an Outlook RTF body encapsulates ([MS-OXRTFEX], `\fromhtml1`), else
 * the RTF's text. One pass over the bytes, holding only the output; a group
 * nested deeper than any message writes is read as hidden.
 */
import { Result } from "better-result";

type RtfMessageBody =
  { type: "html"; html: string } | { type: "text"; text: string };

/** Groups opened deeper than this are not read. */
const MAX_GROUP_DEPTH = 1024;

/** Destinations whose content is never body text. */
const HIDDEN_DESTINATIONS: ReadonlySet<string> = new Set([
  "author",
  "buptim",
  "colortbl",
  "comment",
  "creatim",
  "doccomm",
  "fonttbl",
  "footer",
  "footerf",
  "footerl",
  "footerr",
  "header",
  "headerf",
  "headerl",
  "headerr",
  "info",
  "keywords",
  "listoverridetable",
  "listtable",
  "object",
  "operator",
  "pict",
  "printim",
  "revtim",
  "revtbl",
  "rsidtbl",
  "stylesheet",
  "subject",
  "title",
]);

const SPECIAL_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["par", "\n"],
  ["line", "\n"],
  ["row", "\n"],
  ["sect", "\n"],
  ["page", "\n"],
  ["tab", "\t"],
  ["cell", "\t"],
  ["emdash", "\u2014"],
  ["endash", "\u2013"],
  ["bullet", "\u2022"],
  ["lquote", "\u2018"],
  ["rquote", "\u2019"],
  ["ldblquote", "\u201C"],
  ["rdblquote", "\u201D"],
  ["emspace", "\u2003"],
  ["enspace", "\u2002"],
]);

/** Code pages `\ansicpgN` selects, by the label `TextDecoder` knows. */
const CODE_PAGES = [
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
  [65_001, "utf-8"],
] as const;

/** The labels above, as the decoder's own vocabulary. */
type CodePageLabel = (typeof CODE_PAGES)[number][1];

const CODE_PAGE_LABELS = new Map<number, CodePageLabel>(CODE_PAGES);

/**
 * A decoder for a Windows code page as Outlook declares it (an RTF body's
 * `\ansicpgN`, a TNEF stream's OEM or internet code page); Windows-1252 for
 * one the table does not hold.
 */
export const codePageDecoder = (codePage: number): TextDecoder =>
  Result.try(
    () => new TextDecoder(CODE_PAGE_LABELS.get(codePage) ?? "windows-1252"),
  ).unwrapOr(new TextDecoder("windows-1252"));

const decoderFor = codePageDecoder;

/** The largest UTF-16 code unit a `\uN` may name. */
const MAX_CODE_UNIT = 0xff_ff;
/** The longest control word and parameter the RTF specification allows. */
const MAX_WORD_LETTERS = 32;
const MAX_PARAMETER_DIGITS = 10;

/**
 * The Windows code page a font's character set (`\fcharsetN`) selects, so a
 * run in that font decodes as its own script.
 */
const CHARSET_CODE_PAGES: ReadonlyMap<number, number> = new Map([
  [0, 1252],
  [77, 10_000],
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

type Group = {
  /** The group's content is not body text. */
  hidden: boolean;
  /** An encapsulated HTML tag, always shown in HTML mode. */
  htmlTag: boolean;
  /** RTF-only content an HTML body leaves out (`\htmlrtf`). */
  rtfOnly: boolean;
  /** Characters a `\uN` stands in place of (`\ucN`). */
  unicodeSkip: number;
  /** The group is (inside) the font table, whose fonts it records. */
  fontTable: boolean;
  /** The current font (`\fN`), whose character set decodes its bytes. */
  font: number | null;
};

const isLetter = (byte: number) =>
  (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a);
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const HEX_DIGITS = /^[0-9a-f]{2}$/iu;
const ascii = new TextDecoder("windows-1252");

const ROOT_GROUP: Group = {
  hidden: false,
  htmlTag: false,
  rtfOnly: false,
  unicodeSkip: 1,
  fontTable: false,
  font: null,
};

/** What a control symbol other than an escaped byte stands for. */
const CONTROL_SYMBOL_TEXT: ReadonlyMap<number, string> = new Map([
  [0x7e, "\u00A0"],
  [0x5f, "-"],
  [0x0d, "\n"],
  [0x0a, "\n"],
]);

/** One control word and where the text after it starts. */
type ControlWord = { word: string; parameter: number | null; next: number };

const readControlWord = (rtf: Uint8Array, at: number): ControlWord => {
  const limit = (start: number, length: number) =>
    Math.min(rtf.byteLength, start + length);
  let end = at + 1;
  while (end < limit(at + 1, MAX_WORD_LETTERS) && isLetter(rtf[end] ?? 0)) {
    end += 1;
  }
  const word = ascii.decode(rtf.subarray(at + 1, end));
  const digitsStart = rtf[end] === 0x2d ? end + 1 : end;
  let paramEnd = digitsStart;
  while (
    paramEnd < limit(digitsStart, MAX_PARAMETER_DIGITS) &&
    isDigit(rtf[paramEnd] ?? 0)
  ) {
    paramEnd += 1;
  }
  const hasParameter = paramEnd > digitsStart;
  const parameter = hasParameter
    ? Number.parseInt(ascii.decode(rtf.subarray(end, paramEnd)), 10)
    : null;
  const after = hasParameter ? paramEnd : end;
  // One space after a control word is its delimiter, not text.
  return { word, parameter, next: rtf[after] === 0x20 ? after + 1 : after };
};

/** The reading of one body: the output so far and the state that shapes it. */
class BodyReader {
  fromHtml = false;
  private documentDecoder = decoderFor(1252);
  /** Each font's code page, from the font table. */
  private readonly fontCodePages = new Map<number, number>();
  /** One decoder per font code page, made once. */
  private readonly fontDecoders = new Map<number, TextDecoder>();
  /** The font the font table is describing. */
  private tableFont: number | null = null;
  private readonly out: string[] = [];
  private pending: number[] = [];
  private pendingDecoder: TextDecoder = this.documentDecoder;
  private readonly groups: Group[] = [{ ...ROOT_GROUP }];
  /** Groups opened past the depth bound: counted, never kept. */
  private overflow = 0;
  /** Whether the next control word opens the current group's destination. */
  private groupStart = false;
  private ignorableDestination = false;
  /** Characters still to skip after a `\uN`. */
  private skip = 0;

  private get group(): Group {
    return this.groups.at(-1) ?? { ...ROOT_GROUP, hidden: true };
  }

  private get visible(): boolean {
    const { group } = this;
    if (group.hidden || this.overflow > 0) {
      return false;
    }
    return group.htmlTag || !(this.fromHtml && group.rtfOnly);
  }

  /** The decoder for the current font, else the document's code page. */
  private get decoder(): TextDecoder {
    const { font } = this.group;
    const codePage = font === null ? undefined : this.fontCodePages.get(font);
    if (codePage === undefined) {
      return this.documentDecoder;
    }
    const known = this.fontDecoders.get(codePage);
    if (known !== undefined) {
      return known;
    }
    const decoder = codePageDecoder(codePage);
    this.fontDecoders.set(codePage, decoder);
    return decoder;
  }

  private flush() {
    if (this.pending.length > 0) {
      this.out.push(this.pendingDecoder.decode(new Uint8Array(this.pending)));
      this.pending = [];
    }
  }

  /** Whether a fallback character of a `\uN` is consumed here. */
  private skipped(): boolean {
    if (this.skip > 0) {
      this.skip -= 1;
      return true;
    }
    return false;
  }

  byte(byte: number) {
    this.groupStart = false;
    if (this.skipped() || !this.visible) {
      return;
    }
    const { decoder } = this;
    if (decoder !== this.pendingDecoder) {
      this.flush();
      this.pendingDecoder = decoder;
    }
    this.pending.push(byte);
  }

  private text(text: string) {
    if (this.visible) {
      this.flush();
      this.out.push(text);
    }
  }

  open() {
    if (this.groups.length > MAX_GROUP_DEPTH) {
      this.overflow += 1;
    } else {
      // A group inherits its parent's state.
      this.groups.push({ ...this.group });
    }
    this.groupStart = true;
    this.ignorableDestination = false;
  }

  close() {
    if (this.overflow > 0) {
      this.overflow -= 1;
    } else if (this.groups.length > 1) {
      this.groups.pop();
    }
    this.groupStart = false;
  }

  /** A control symbol, `\` and one character; returns where text resumes. */
  symbol(rtf: Uint8Array, at: number): number {
    const symbol = rtf[at + 1];
    if (symbol === 0x27) {
      const hex = ascii.decode(rtf.subarray(at + 2, at + 4));
      if (HEX_DIGITS.test(hex)) {
        this.byte(Number.parseInt(hex, 16));
      }
      return at + 4;
    }
    if (symbol === 0x2a) {
      // `\*`: the group is a destination to skip unless it is known.
      this.ignorableDestination = this.groupStart;
    } else if (symbol === 0x5c || symbol === 0x7b || symbol === 0x7d) {
      this.byte(symbol);
    } else {
      const text = CONTROL_SYMBOL_TEXT.get(symbol ?? 0);
      // A control symbol counts as one fallback character of a `\uN`.
      if (text !== undefined && !this.skipped()) {
        this.text(text);
      }
    }
    return at + 2;
  }

  /** Whether a control word opens its group as a destination it consumed. */
  private destination(word: string): boolean {
    if (!this.groupStart) {
      return false;
    }
    this.groupStart = false;
    if (word === "htmltag") {
      this.flush();
      this.group.htmlTag = true;
      return true;
    }
    if (word === "fonttbl") {
      this.group.hidden = true;
      this.group.fontTable = true;
      return true;
    }
    if (this.ignorableDestination || HIDDEN_DESTINATIONS.has(word)) {
      this.flush();
      this.group.hidden = true;
      return true;
    }
    return false;
  }

  /** A font table's control word: which font, and its character set. */
  private fontTableWord(word: string, parameter: number | null): void {
    if (word === "f") {
      this.tableFont = parameter;
      return;
    }
    const codePage =
      word === "fcharset" && parameter !== null
        ? CHARSET_CODE_PAGES.get(parameter)
        : undefined;
    if (this.tableFont !== null && codePage !== undefined) {
      this.fontCodePages.set(this.tableFont, codePage);
    }
  }

  word({ word, parameter }: ControlWord) {
    if (this.destination(word)) {
      return;
    }
    const { group } = this;
    if (group.fontTable) {
      this.fontTableWord(word, parameter);
      return;
    }
    switch (word) {
      case "fromhtml":
        this.fromHtml = parameter !== 0;
        return;
      case "ansicpg":
        if (parameter !== null) {
          this.flush();
          this.documentDecoder = decoderFor(parameter);
        }
        return;
      case "f":
      case "deff":
        group.font = parameter;
        return;
      case "uc":
        group.unicodeSkip = Math.max(0, parameter ?? 1);
        return;
      case "u": {
        if (parameter === null) {
          return;
        }
        // A signed 16-bit parameter names one UTF-16 code unit; any other
        // value names nothing, though its stand-in characters are skipped.
        const unit = parameter < 0 ? parameter + 65_536 : parameter;
        if (unit >= 0 && unit <= MAX_CODE_UNIT) {
          this.text(String.fromCodePoint(unit));
        }
        this.skip = group.unicodeSkip;
        return;
      }
      case "htmlrtf":
        this.flush();
        group.rtfOnly = parameter !== 0;
        return;
      default: {
        const special = SPECIAL_CHARACTERS.get(word);
        if (special !== undefined && !this.skipped()) {
          this.text(special);
        }
      }
    }
  }

  body(): RtfMessageBody | null {
    this.flush();
    const body = this.out.join("");
    if (this.fromHtml) {
      return body.trim() === "" ? null : { type: "html", html: body };
    }
    const text = body
      .replace(/[ \t]+\n/gu, "\n")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    return text === "" ? null : { type: "text", text };
  }
}

/**
 * The body an RTF message carries: its encapsulated HTML when it has one,
 * else its text; null when it shows nothing.
 */
export const rtfMessageBody = (rtf: Uint8Array): RtfMessageBody | null => {
  const reader = new BodyReader();
  let at = 0;
  while (at < rtf.byteLength) {
    const byte = rtf[at] ?? 0;
    if (byte === 0x7b) {
      reader.open();
      at += 1;
    } else if (byte === 0x7d) {
      reader.close();
      at += 1;
    } else if (byte === 0x0d || byte === 0x0a) {
      at += 1;
    } else if (byte !== 0x5c) {
      reader.byte(byte);
      at += 1;
    } else if (isLetter(rtf[at + 1] ?? 0)) {
      const control = readControlWord(rtf, at);
      reader.word(control);
      // `\binN`: N raw bytes follow, never read as RTF.
      at =
        control.word === "bin" && control.parameter !== null
          ? Math.min(
              rtf.byteLength,
              control.next + Math.max(0, control.parameter),
            )
          : control.next;
    } else {
      at = reader.symbol(rtf, at);
    }
  }
  return reader.body();
};
