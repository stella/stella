import { FormatRegistry } from "@sinclair/typebox";
import { t } from "elysia";

export const boundedString = (maxBytes: number) => {
  const format = `legislation-search-utf8-${maxBytes}`;
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(
      format,
      (value) =>
        value.isWellFormed() && Buffer.byteLength(value, "utf-8") <= maxBytes,
    );
  }
  return t.String({
    maxLength: maxBytes,
    format,
    "x-maxUtf8Bytes": maxBytes,
    description: `At most ${maxBytes} UTF-8 bytes.`,
  });
};

export const nullableBoundedString = (maxBytes: number) =>
  t.Union([boundedString(maxBytes), t.Null()]);

export const truncateTextBytes = (text: string, maxBytes: number): string => {
  let result = "";
  let bytes = 0;
  for (const character of text) {
    // Normalize lone surrogates too: JSON must carry the same valid Unicode
    // that the UTF-8 byte counter measures.
    const scalar = character.toWellFormed();
    const size = Buffer.byteLength(scalar, "utf-8");
    if (bytes + size > maxBytes) {
      break;
    }
    result += scalar;
    bytes += size;
  }
  return result;
};

const MARK_OPEN = "<mark>";
const MARK_CLOSE = "</mark>";

export const truncateHeadlineBytes = (
  text: string,
  maxBytes: number,
): string => {
  // Match entity syntax rather than mirroring the escaper's substitutions;
  // every complete named or numeric entity occupies one atomic text unit.
  const entityPattern = /&(?:[a-z][a-z0-9]*|#(?:[0-9]+|x[0-9a-f]+));/iuy;
  let cursor = 0;
  let result = "";
  let bytes = 0;
  let depth = 0;
  while (cursor < text.length) {
    if (text.startsWith(MARK_OPEN, cursor)) {
      if (
        bytes + MARK_OPEN.length + (depth + 1) * MARK_CLOSE.length >
        maxBytes
      ) {
        break;
      }
      result += MARK_OPEN;
      bytes += MARK_OPEN.length;
      depth += 1;
      cursor += MARK_OPEN.length;
      continue;
    }
    if (text.startsWith(MARK_CLOSE, cursor)) {
      if (depth > 0) {
        result += MARK_CLOSE;
        bytes += MARK_CLOSE.length;
        depth -= 1;
      }
      cursor += MARK_CLOSE.length;
      continue;
    }
    const codePoint = text.codePointAt(cursor);
    if (codePoint === undefined) {
      break;
    }
    let character = String.fromCodePoint(codePoint);
    if (character === "&") {
      entityPattern.lastIndex = cursor;
      character = entityPattern.exec(text)?.[0] ?? character;
    }
    const scalar = character.toWellFormed();
    const size = Buffer.byteLength(scalar, "utf-8");
    if (bytes + size + depth * MARK_CLOSE.length > maxBytes) {
      break;
    }
    result += scalar;
    bytes += size;
    cursor += character.length;
  }
  return result + MARK_CLOSE.repeat(depth);
};

export const nullableText = (text: string | null, maxBytes: number) =>
  text === null ? null : truncateTextBytes(text, maxBytes);
