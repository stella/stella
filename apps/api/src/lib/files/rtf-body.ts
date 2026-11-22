/**
 * A message body written in RTF, as Outlook stores it, read for display: the
 * HTML an Outlook RTF body encapsulates ([MS-OXRTFEX], `\fromhtml1`), else
 * the RTF's text. One pass over the bytes, holding only the output; a group
 * nested deeper than any message writes is read as hidden.
 */
import { Result } from "better-result";

export type RtfMessageBody =
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
const CODE_PAGE_LABELS: ReadonlyMap<number, string> = new Map([
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
  [20_866, "koi8-r"],
  [28_591, "iso-8859-1"],
  [28_592, "iso-8859-2"],
  [65_001, "utf-8"],
]);

const decoderFor = (codePage: number): TextDecoder =>
  Result.try(
    () => new TextDecoder(CODE_PAGE_LABELS.get(codePage) ?? "windows-1252"),
  ).unwrapOr(new TextDecoder("windows-1252"));

type Group = {
  /** The group's content is not body text. */
  hidden: boolean;
  /** An encapsulated HTML tag, always shown in HTML mode. */
  htmlTag: boolean;
  /** RTF-only content an HTML body leaves out (`\htmlrtf`). */
  rtfOnly: boolean;
  /** Characters a `\uN` stands in place of (`\ucN`). */
  unicodeSkip: number;
};

const isLetter = (byte: number) =>
  (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x41 && byte <= 0x5a);
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;
const HEX_DIGITS = /^[0-9a-f]{2}$/iu;

const ROOT_GROUP: Group = {
  hidden: false,
  htmlTag: false,
  rtfOnly: false,
  unicodeSkip: 1,
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
  let end = at + 1;
  while (end < rtf.byteLength && isLetter(rtf[end] ?? 0)) {
    end += 1;
  }
  const word = String.fromCodePoint(...rtf.subarray(at + 1, end));
  let paramEnd = rtf[end] === 0x2d ? end + 1 : end;
  while (paramEnd < rtf.byteLength && isDigit(rtf[paramEnd] ?? 0)) {
    paramEnd += 1;
  }
  const hasParameter = paramEnd > end && isDigit(rtf[paramEnd - 1] ?? 0);
  const parameter = hasParameter
    ? Number.parseInt(String.fromCodePoint(...rtf.subarray(end, paramEnd)), 10)
    : null;
  const after = hasParameter ? paramEnd : end;
  // One space after a control word is its delimiter, not text.
  return { word, parameter, next: rtf[after] === 0x20 ? after + 1 : after };
};

/** The reading of one body: the output so far and the state that shapes it. */
class BodyReader {
  fromHtml = false;
  private decoder = decoderFor(1252);
  private readonly out: string[] = [];
  private pending: number[] = [];
  private readonly groups: Group[] = [{ ...ROOT_GROUP }];
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
    if (group.hidden) {
      return false;
    }
    return group.htmlTag || !(this.fromHtml && group.rtfOnly);
  }

  private flush() {
    if (this.pending.length > 0) {
      this.out.push(this.decoder.decode(new Uint8Array(this.pending)));
      this.pending = [];
    }
  }

  byte(byte: number) {
    this.groupStart = false;
    if (this.skip > 0) {
      this.skip -= 1;
      return;
    }
    if (this.visible) {
      this.pending.push(byte);
    }
  }

  private text(text: string) {
    if (this.visible) {
      this.flush();
      this.out.push(text);
    }
  }

  open() {
    // A group inherits its parent's state.
    const parent = this.group;
    this.groups.push({
      ...parent,
      hidden: parent.hidden || this.groups.length > MAX_GROUP_DEPTH,
    });
    this.groupStart = true;
    this.ignorableDestination = false;
  }

  close() {
    if (this.groups.length > 1) {
      this.groups.pop();
    }
    this.groupStart = false;
  }

  /** A control symbol, `\` and one character; returns where text resumes. */
  symbol(rtf: Uint8Array, at: number): number {
    const symbol = rtf[at + 1];
    if (symbol === 0x27) {
      const hex = String.fromCodePoint(rtf[at + 2] ?? 0, rtf[at + 3] ?? 0);
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
      if (text !== undefined) {
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
    if (this.ignorableDestination || HIDDEN_DESTINATIONS.has(word)) {
      this.flush();
      this.group.hidden = true;
      return true;
    }
    return false;
  }

  word({ word, parameter }: ControlWord) {
    if (this.destination(word)) {
      return;
    }
    const { group } = this;
    switch (word) {
      case "fromhtml":
        this.fromHtml = parameter !== 0;
        return;
      case "ansicpg":
        if (parameter !== null) {
          this.flush();
          this.decoder = decoderFor(parameter);
        }
        return;
      case "uc":
        group.unicodeSkip = Math.max(0, parameter ?? 1);
        return;
      case "u":
        if (parameter !== null) {
          this.text(
            String.fromCodePoint(
              parameter < 0 ? parameter + 65_536 : parameter,
            ),
          );
          this.skip = group.unicodeSkip;
        }
        return;
      case "htmlrtf":
        this.flush();
        group.rtfOnly = parameter !== 0;
        return;
      default: {
        const special = SPECIAL_CHARACTERS.get(word);
        if (special !== undefined) {
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
      at = control.next;
    } else {
      at = reader.symbol(rtf, at);
    }
  }
  return reader.body();
};
