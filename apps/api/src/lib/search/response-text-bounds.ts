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

export const nullableText = (text: string | null, maxBytes: number) =>
  text === null ? null : truncateTextBytes(text, maxBytes);
