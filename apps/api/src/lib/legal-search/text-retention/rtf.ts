import { panic, Result } from "better-result";

import {
  TEXT_ORACLE_LIMITS,
  TextOracleError,
  type TextBaseline,
} from "./types";

// Only destinations with no rendered text are excluded. Unknown destinations
// remain visible, including starred text boxes and object/field results.
const NON_TEXT_DESTINATIONS = new Set([
  "fonttbl",
  "colortbl",
  "stylesheet",
  "info",
  "generator",
  "pict",
  "objdata",
  "fldinst",
  "listtable",
  "listoverridetable",
  "rsidtbl",
  "themedata",
  "colorschememapping",
  "latentstyles",
  "datastore",
  "filetbl",
  "revtbl",
  "shpname",
]);
const STARRED_VISIBLE_DESTINATIONS = new Set([
  "shptxt",
  "dptxbxtext",
  "fldrslt",
  "result",
]);
const UNSUPPORTED_CONTROLS = new Set([
  "upr",
  "ud",
  "v",
  "deleted",
  "chftn",
  "shpvalue",
]);
const CODE_PAGES = new Map([
  [1250, "windows-1250"],
  [1251, "windows-1251"],
  [1252, "windows-1252"],
  [1253, "windows-1253"],
  [1254, "windows-1254"],
  [1257, "windows-1257"],
  [10_000, "macintosh"],
]);
const CHARSET_CODE_PAGES = new Map([
  [77, 10_000],
  [161, 1253],
  [162, 1254],
  [186, 1257],
  [204, 1251],
  [238, 1250],
]);
const CONTROL_SYMBOLS = new Map([
  ["~", "\u00a0"],
  ["_", "\u2011"],
  ["\n", "\n"],
  ["\r", "\n"],
]);
const SYMBOLS = new Map([
  ["par", "\n"],
  ["line", "\n"],
  ["tab", "\t"],
  ["cell", "\t"],
  ["row", "\n"],
  ["page", "\n"],
  ["sect", "\n"],
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

type RtfGroup = {
  skip: boolean;
  fontTable: boolean;
  font: number;
  codePage: number;
  fallback: number;
  pendingStar: boolean;
  defaultFont: number;
};
type RtfToken =
  | { type: "character"; byte: number; next: number }
  | { type: "word"; word: string; parameter: number | undefined; next: number }
  | { type: "symbol"; symbol: string; next: number };

const tokenAt = (
  source: Uint8Array,
  start: number,
): Result<RtfToken, TextOracleError> => {
  const byte = source[start];
  if (byte === undefined) {
    return Result.err(
      new TextOracleError({
        message: "Truncated RTF escape",
        reason: "malformed",
      }),
    );
  }
  if (byte === 0x27) {
    const hex = String.fromCodePoint(
      source[start + 1] ?? 0,
      source[start + 2] ?? 0,
    );
    if (!/^[\da-f]{2}$/iu.test(hex)) {
      return Result.err(
        new TextOracleError({
          message: "Malformed RTF byte escape",
          reason: "malformed",
        }),
      );
    }
    return Result.ok({
      type: "character",
      byte: Number.parseInt(hex, 16),
      next: start + 3,
    });
  }
  if (byte === 0x5c || byte === 0x7b || byte === 0x7d) {
    return Result.ok({ type: "character", byte, next: start + 1 });
  }
  let cursor = start;
  while (/[a-z]/iu.test(String.fromCodePoint(source[cursor] ?? 0))) {
    cursor += 1;
  }
  if (cursor === start) {
    return Result.ok({
      type: "symbol",
      symbol: String.fromCodePoint(byte),
      next: start + 1,
    });
  }
  const word = new TextDecoder("ascii").decode(source.subarray(start, cursor));
  const numberStart = cursor;
  if (source[cursor] === 0x2d) {
    cursor += 1;
  }
  while ((source[cursor] ?? 0) >= 0x30 && (source[cursor] ?? 0) <= 0x39) {
    cursor += 1;
  }
  const number = new TextDecoder("ascii").decode(
    source.subarray(numberStart, cursor),
  );
  if (number === "-") {
    return Result.err(
      new TextOracleError({
        message: "Malformed RTF numeric parameter",
        reason: "malformed",
      }),
    );
  }
  const parameter = number === "" ? undefined : Number(number);
  if (parameter !== undefined && !Number.isSafeInteger(parameter)) {
    return Result.err(
      new TextOracleError({
        message: "RTF numeric parameter exceeds limit",
        reason: "resource_limit",
      }),
    );
  }
  return Result.ok({
    type: "word",
    word,
    parameter,
    next: source[cursor] === 0x20 ? cursor + 1 : cursor,
  });
};

type SkipFallbackOptions = { source: Uint8Array; start: number; count: number };

const skipFallback = ({
  source,
  start,
  count,
}: SkipFallbackOptions): Result<number, TextOracleError> => {
  let cursor = start;
  for (let skipped = 0; skipped < count; skipped += 1) {
    const byte = source[cursor];
    if (byte === undefined || byte === 0x7b || byte === 0x7d) {
      break;
    }
    if (byte !== 0x5c) {
      cursor += 1;
      continue;
    }
    const token = tokenAt(source, cursor + 1);
    if (token.isErr()) {
      return token;
    }
    if (token.value.type === "word") {
      break;
    }
    cursor = token.value.next;
  }
  return Result.ok(cursor);
};

type ApplyGroupControlOptions = {
  word: string;
  parameter: number | undefined;
  state: RtfGroup;
  fonts: Map<number, number>;
};
const applyGroupControl = ({
  word,
  parameter,
  state,
  fonts,
}: ApplyGroupControlOptions): Result<void, TextOracleError> => {
  if (word === "f" && parameter !== undefined) {
    state.font = parameter;
  } else if (
    word === "fcharset" &&
    state.fontTable &&
    parameter !== undefined
  ) {
    fonts.set(state.font, parameter);
  } else if (word === "ansicpg" && parameter !== undefined) {
    if (!CODE_PAGES.has(parameter)) {
      return Result.err(
        new TextOracleError({
          message: "Unsupported RTF code page",
          reason: "unsupported",
        }),
      );
    }
    state.codePage = parameter;
  } else if (word === "deff" && parameter !== undefined) {
    state.font = parameter;
    state.defaultFont = parameter;
  } else if (word === "plain") {
    state.font = state.defaultFont;
  } else if (word === "mac") {
    state.codePage = 10_000;
  } else if (word === "pc" || word === "pca") {
    return Result.err(
      new TextOracleError({
        message: "Unsupported RTF OEM encoding",
        reason: "unsupported",
      }),
    );
  } else if (word === "uc") {
    if (parameter === undefined || parameter < 0 || parameter > 256) {
      return Result.err(
        new TextOracleError({
          message: "Unsupported RTF Unicode fallback",
          reason: "unsupported",
        }),
      );
    }
    state.fallback = parameter;
  }
  return Result.ok();
};

type ApplyControlOptions = {
  token: Extract<RtfToken, { type: "word" }>;
  state: RtfGroup;
  fonts: Map<number, number>;
  source: Uint8Array;
};
const applyControl = ({
  token: { word, parameter, next },
  state,
  fonts,
  source,
}: ApplyControlOptions): Result<
  { text: string; next: number },
  TextOracleError
> => {
  if (UNSUPPORTED_CONTROLS.has(word)) {
    return Result.err(
      new TextOracleError({
        message: "RTF requires unsupported rendering semantics",
        reason: "unsupported",
      }),
    );
  }
  if (
    state.pendingStar &&
    !NON_TEXT_DESTINATIONS.has(word) &&
    !STARRED_VISIBLE_DESTINATIONS.has(word)
  ) {
    return Result.err(
      new TextOracleError({
        message: "RTF starred destination has ambiguous visibility",
        reason: "unsupported",
      }),
    );
  }
  state.pendingStar = false;
  if (NON_TEXT_DESTINATIONS.has(word)) {
    state.skip = true;
    state.fontTable ||= word === "fonttbl";
  }
  const group = applyGroupControl({ word, parameter, state, fonts });
  if (group.isErr()) {
    return group;
  }
  if (word === "bin") {
    if (
      parameter === undefined ||
      parameter < 0 ||
      next + parameter > source.length
    ) {
      return Result.err(
        new TextOracleError({
          message: "Malformed RTF binary payload",
          reason: "malformed",
        }),
      );
    }
    return Result.ok({ text: "", next: next + parameter });
  } else if (word === "u") {
    if (parameter === undefined || parameter < -32_768 || parameter > 65_535) {
      return Result.err(
        new TextOracleError({
          message: "Malformed RTF Unicode escape",
          reason: "malformed",
        }),
      );
    }
    const after = skipFallback({ source, start: next, count: state.fallback });
    if (after.isErr()) {
      return after;
    }
    return Result.ok({
      text: state.skip
        ? ""
        : String.fromCodePoint(parameter < 0 ? parameter + 65_536 : parameter),
      next: after.value,
    });
  }
  return Result.ok({ text: state.skip ? "" : (SYMBOLS.get(word) ?? ""), next });
};

type DecodeContentOptions = {
  characters: Uint8Array | undefined;
  state: RtfGroup;
  fonts: Map<number, number>;
  decoders: Map<string, TextDecoder>;
  text: string;
};
const decodeContent = ({
  characters,
  state,
  fonts,
  decoders,
  text,
}: DecodeContentOptions): Result<string, TextOracleError> => {
  if (characters === undefined) {
    return Result.ok(text);
  }
  if (state.pendingStar) {
    return Result.err(
      new TextOracleError({
        message: "RTF starred destination has no control word",
        reason: "malformed",
      }),
    );
  }
  if (state.skip) {
    return Result.ok(text);
  }
  const charset = fonts.get(state.font);
  const page =
    charset === undefined || charset === 0 || charset === 1
      ? state.codePage
      : CHARSET_CODE_PAGES.get(charset);
  const label = page === undefined ? undefined : CODE_PAGES.get(page);
  if (!label) {
    return Result.err(
      new TextOracleError({
        message: "Unsupported RTF font charset",
        reason: "unsupported",
      }),
    );
  }
  let decoder = decoders.get(label);
  if (!decoder) {
    decoder = new TextDecoder(label);
    decoders.set(label, decoder);
  }
  return Result.ok(decoder.decode(characters));
};

/** Separate byte scanner; it never consumes the court reader's filtered model. */
export const readRtfText = (
  source: Uint8Array,
): Result<TextBaseline, TextOracleError> => {
  if (new TextDecoder("ascii").decode(source.subarray(0, 5)) !== "{\\rtf") {
    return Result.err(
      new TextOracleError({
        message: "Missing RTF signature",
        reason: "malformed",
      }),
    );
  }
  let state: RtfGroup = {
    skip: false,
    fontTable: false,
    font: 0,
    codePage: 1252,
    fallback: 1,
    pendingStar: false,
    defaultFont: 0,
  };
  const stack: RtfGroup[] = [];
  const fonts = new Map<number, number>();
  const output: string[] = [];
  const decoders = new Map<string, TextDecoder>();
  let textCharacters = 0;
  let nodes = 0;
  let cursor = 0;
  let closed = false;
  while (cursor < source.length) {
    nodes += 1;
    if (
      nodes > TEXT_ORACLE_LIMITS.nodes ||
      textCharacters > TEXT_ORACLE_LIMITS.textCharacters
    ) {
      return Result.err(
        new TextOracleError({
          message: "RTF traversal limit exceeded",
          reason: "resource_limit",
        }),
      );
    }
    const byte = source[cursor] ?? 0;
    if (closed) {
      if (![0x20, 0x0a, 0x0d, 0x09].includes(byte)) {
        return Result.err(
          new TextOracleError({
            message: "RTF has trailing content",
            reason: "malformed",
          }),
        );
      }
      cursor += 1;
      continue;
    }
    if (byte === 0x7b) {
      stack.push(state);
      state = {
        skip: state.skip,
        fontTable: state.fontTable,
        font: state.font,
        codePage: state.codePage,
        fallback: state.fallback,
        pendingStar: false,
        defaultFont: state.defaultFont,
      };
      if (stack.length > TEXT_ORACLE_LIMITS.depth) {
        return Result.err(
          new TextOracleError({
            message: "RTF group depth exceeded",
            reason: "resource_limit",
          }),
        );
      }
      cursor += 1;
      continue;
    }
    if (byte === 0x7d) {
      const parent = stack.pop();
      if (!parent) {
        return Result.err(
          new TextOracleError({
            message: "Unbalanced RTF closing group",
            reason: "malformed",
          }),
        );
      }
      state = parent;
      closed = stack.length === 0;
      cursor += 1;
      continue;
    }
    let text = "";
    let characters: Uint8Array | undefined;
    if (byte === 0x5c) {
      const token = tokenAt(source, cursor + 1);
      if (token.isErr()) {
        return token;
      }
      cursor = token.value.next;
      switch (token.value.type) {
        case "character":
          characters = Uint8Array.of(token.value.byte);
          break;
        case "symbol":
          if (token.value.symbol === "*") {
            state.pendingStar = true;
          }
          if (!state.skip) {
            text = CONTROL_SYMBOLS.get(token.value.symbol) ?? "";
          }
          break;
        case "word": {
          const applied = applyControl({
            token: token.value,
            state,
            fonts,
            source,
          });
          if (applied.isErr()) {
            return applied;
          }
          text = applied.value.text;
          cursor = applied.value.next;
          break;
        }
        default:
          return panic(
            "Unexpected RTF oracle token",
            token.value satisfies never,
          );
      }
    } else {
      const start = cursor;
      while (
        cursor < source.length &&
        ![0x7b, 0x7d, 0x5c, 0x0a, 0x0d].includes(source[cursor] ?? 0)
      ) {
        cursor += 1;
      }
      if (cursor === start) {
        cursor += 1;
      } else {
        characters = source.subarray(start, cursor);
      }
    }
    const decoded = decodeContent({ characters, state, fonts, decoders, text });
    if (decoded.isErr()) {
      return decoded;
    }
    text = decoded.value;
    if (text !== "") {
      textCharacters += text.length;
      output.push(text);
    }
  }
  if (!closed || stack.length !== 0) {
    return Result.err(
      new TextOracleError({
        message: "Unclosed RTF group",
        reason: "malformed",
      }),
    );
  }
  if (textCharacters > TEXT_ORACLE_LIMITS.textCharacters) {
    return Result.err(
      new TextOracleError({
        message: "RTF text limit exceeded",
        reason: "resource_limit",
      }),
    );
  }
  return Result.ok({ text: output.join("") });
};
