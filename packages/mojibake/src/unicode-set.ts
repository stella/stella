/**
 * The subset of UnicodeSet syntax CLDR writes exemplar sets in: bracketed
 * space-separated characters, `{…}` multi-character sequences, `a-z` ranges
 * and backslash escapes (`\-`, `\uXXXX`, `\x{…}`). A sequence contributes
 * its characters one by one, since the detector scores single characters.
 *
 * Anything else (nested sets, property classes) is an error rather than a
 * silent gap, so a CLDR release that starts using it fails extraction.
 */

type ParsedUnicodeSet =
  | { status: "ok"; codePoints: ReadonlySet<number> }
  | { status: "error"; message: string };

const HEX = /^[0-9A-Fa-f]+$/u;

type Cursor = { chars: readonly string[]; index: number };

type ReadEscapeResult =
  | { status: "ok"; codePoint: number }
  | { status: "error"; message: string };

const readHex = (hex: string): ReadEscapeResult =>
  HEX.test(hex)
    ? { status: "ok", codePoint: Number.parseInt(hex, 16) }
    : { status: "error", message: `bad escape \\${hex}` };

/** Reads the escape starting after a backslash and advances the cursor. */
const readEscape = (cursor: Cursor): ReadEscapeResult => {
  const head = cursor.chars[cursor.index] ?? "";
  cursor.index += 1;
  if (head === "u") {
    const hex = cursor.chars.slice(cursor.index, cursor.index + 4).join("");
    cursor.index += 4;
    return readHex(hex);
  }
  if (head === "U") {
    const hex = cursor.chars.slice(cursor.index, cursor.index + 8).join("");
    cursor.index += 8;
    return readHex(hex);
  }
  if (head === "x" && cursor.chars[cursor.index] === "{") {
    const close = cursor.chars.indexOf("}", cursor.index);
    if (close === -1) {
      return { status: "error", message: "unterminated \\x{" };
    }
    const hex = cursor.chars.slice(cursor.index + 1, close).join("");
    cursor.index = close + 1;
    return readHex(hex);
  }
  const codePoint = head.codePointAt(0);
  return codePoint === undefined
    ? { status: "error", message: "trailing backslash" }
    : { status: "ok", codePoint };
};

export const parseUnicodeSet = (raw: string): ParsedUnicodeSet => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return { status: "error", message: `not a bracketed set: ${raw}` };
  }
  const codePoints = new Set<number>();
  const cursor: Cursor = { chars: Array.from(trimmed.slice(1, -1)), index: 0 };
  let inSequence = false;
  let previous: number | null = null;
  let pendingRange = false;

  while (cursor.index < cursor.chars.length) {
    const char = cursor.chars[cursor.index] ?? "";
    cursor.index += 1;
    let codePoint: number;
    if (char === "\\") {
      const escaped = readEscape(cursor);
      if (escaped.status === "error") {
        return escaped;
      }
      ({ codePoint } = escaped);
    } else {
      if (/\s/u.test(char)) {
        continue;
      }
      if (char === "[" || char === "]") {
        return { status: "error", message: `nested set in ${raw}` };
      }
      if (char === "{" && !inSequence) {
        inSequence = true;
        continue;
      }
      if (char === "}" && inSequence) {
        inSequence = false;
        continue;
      }
      if (char === "-" && !inSequence && previous !== null && !pendingRange) {
        pendingRange = true;
        continue;
      }
      codePoint = char.codePointAt(0) ?? 0;
    }
    if (pendingRange && previous !== null) {
      for (let cp = previous + 1; cp <= codePoint; cp += 1) {
        codePoints.add(cp);
      }
      pendingRange = false;
      previous = null;
      continue;
    }
    codePoints.add(codePoint);
    previous = inSequence ? null : codePoint;
  }
  if (inSequence || pendingRange) {
    return {
      status: "error",
      message: `unterminated sequence or range in ${raw}`,
    };
  }
  return { status: "ok", codePoints };
};
