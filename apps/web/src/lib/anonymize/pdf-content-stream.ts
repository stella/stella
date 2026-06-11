import type { PDF, PdfDict, PdfRef, PdfStream } from "@libpdf/core";

/**
 * A redaction region on a specific page for content stream
 * neutralisation. Coordinates are in PDF user space.
 */
type RedactionBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** PDF context type extracted from PDF.context accessor. */
type Context = PDF["context"];

/**
 * Neutralise text in a page's content stream that falls
 * within the given redaction boxes. Replaces text operands
 * with spaces (same byte length) to preserve stream structure.
 *
 * This is the security-critical step: without it, the original
 * text remains extractable via copy-paste or programmatic tools
 * despite the white rectangle overlay.
 */
export const neutralisePageText = (
  ctx: Context,
  pageDict: PdfDict,
  boxes: RedactionBox[],
): void => {
  if (boxes.length === 0) {
    return;
  }

  const resolver = (ref: PdfRef) => ctx.resolve(ref);
  const contentsObj = pageDict.get("Contents", resolver);
  if (!contentsObj) {
    return;
  }

  const streams = getContentStreams(contentsObj, ctx);

  for (const stream of streams) {
    const decoded = stream.getDecodedData();
    const text = decodeLatin1(decoded);
    const modified = neutraliseTextOperators(text, boxes);

    if (modified !== text) {
      // Encode modified string to Latin-1 bytes.
      const result = new Uint8Array(modified.length);
      for (let i = 0; i < modified.length; i++) {
        // eslint-disable-next-line no-bitwise -- Latin-1 byte masking
        result[i] = (modified.codePointAt(i) ?? 0) & 0xff;
      }
      stream.setData(result);
    }
  }
};

/** Decode bytes as Latin-1 (single-byte, no BOM issues). */
const decodeLatin1 = (bytes: Uint8Array): string => {
  const chars: string[] = [];
  for (const byte of bytes) {
    chars.push(String.fromCodePoint(byte));
  }
  return chars.join("");
};

/**
 * Resolve /Contents to an array of PdfStream objects.
 */
const getContentStreams = (
  contents: ReturnType<PdfDict["get"]>,
  ctx: Context,
): PdfStream[] => {
  if (!contents) {
    return [];
  }

  if (contents.type === "ref") {
    const resolved = ctx.resolve(contents);
    if (!resolved) {
      return [];
    }
    return getContentStreams(resolved, ctx);
  }

  if (contents.type === "stream") {
    return [contents];
  }

  if (contents.type === "array") {
    const arr = contents;
    const streams: PdfStream[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr.at(i);
      if (item) {
        const resolved = item.type === "ref" ? ctx.resolve(item) : item;
        if (resolved?.type === "stream") {
          streams.push(resolved);
        }
      }
    }
    return streams;
  }

  return [];
};

/**
 * Check if a text line starting at (tx, ty) overlaps any
 * redaction box. The text extends rightward from tx, so we
 * test whether the y-coordinate is within the box's vertical
 * range AND the text start is to the left of the box's right
 * edge (meaning the text could extend into the box).
 *
 * This intentionally over-redacts: if the entity is in the
 * middle of a TextItem, the entire Tj/TJ is neutralised.
 * For a security feature, over-redaction is safer than
 * missing PII.
 */
const isInRedactionZone = (
  tx: number,
  ty: number,
  boxes: RedactionBox[],
): boolean => {
  const margin = 2; // points tolerance
  for (const box of boxes) {
    // Skip if not on the same vertical line
    if (ty < box.y - margin || ty > box.y + box.height + margin) {
      continue;
    }
    // Text starts at tx and extends rightward. It overlaps
    // the box if the text start is before the box's right
    // edge (text could reach into the box).
    if (tx <= box.x + box.width + margin) {
      return true;
    }
  }
  return false;
};

/**
 * Replace text operands in content stream operators that fall
 * within redaction zones. Uses a line-based parser that tracks
 * text positioning operators (Td, TD, Tm) and replaces string
 * content in text-showing operators (Tj, TJ, ', ") with spaces.
 */
const neutraliseTextOperators = (
  content: string,
  boxes: RedactionBox[],
): string => {
  let tx = 0;
  let ty = 0;
  // Set when T* (or '/" which imply T*) is seen: we
  // can't track TL so ty becomes uncertain. In that
  // state, neutralise any Tj on the same x-range
  // regardless of y, since over-redaction is safer.
  let positionUncertain = false;

  // Split while preserving each line's original ending.
  // PDF generators may mix \r\n, \r, and \n in the same
  // stream; normalising to a single EOL changes byte
  // length and corrupts the stream.
  const parts = content.split(/(\r\n|\r|\n)/u);
  // parts = [line0, eol0, line1, eol1, ..., lastLine]
  const lines: string[] = [];
  const eols: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    if (part !== undefined) {
      lines.push(part);
    }
    // The separator follows each line except the last
    if (i + 1 < parts.length) {
      const eol = parts[i + 1];
      if (eol !== undefined) {
        eols.push(eol);
      }
    }
  }
  const result: string[] = [];
  // Buffer for multi-line TJ arrays. The PDF spec allows
  // newlines inside the [...] operand of TJ, so we
  // accumulate lines until the closing "] TJ".
  let tjBuffer: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Handle multi-line TJ accumulation. When we
    // previously saw an unclosed '[' in a redaction
    // zone, collect lines until '] TJ'.
    if (tjBuffer !== null) {
      tjBuffer.push(line);
      if (/\]\s*TJ\s*$/u.test(trimmed)) {
        // End of multi-line TJ: neutralise all lines
        for (const buffered of tjBuffer) {
          result.push(replaceStringContent(buffered));
        }
        tjBuffer = null;
      }
      continue;
    }

    // Track text position from Td/TD operators
    const tdMatch = /^([\d.-]+)\s+([\d.-]+)\s+T[dD]$/u.exec(trimmed);
    if (tdMatch) {
      tx += Number(tdMatch[1]);
      ty += Number(tdMatch[2]);
      result.push(line);
      continue;
    }

    // Track text position from Tm operator (set text matrix)
    const tmMatch =
      /^[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+[\d.-]+\s+([\d.-]+)\s+([\d.-]+)\s+Tm$/u.exec(
        trimmed,
      );
    if (tmMatch) {
      tx = Number(tmMatch[1]);
      ty = Number(tmMatch[2]);
      result.push(line);
      continue;
    }

    // Reset position tracking on BT (begin text)
    if (trimmed === "BT") {
      tx = 0;
      ty = 0;
      positionUncertain = false;
      result.push(line);
      continue;
    }

    // T* moves to the next line (0 -TL Td) but we don't
    // track TL, so mark position as uncertain.
    if (trimmed === "T*") {
      positionUncertain = true;
      result.push(line);
      continue;
    }

    // Replace string content in text-showing operators
    // when current position is in a redaction zone.
    // ' and " imply T* before showing text, so they
    // also make position uncertain.
    const isTextOp = /(?:Tj|TJ|'|")\s*$/u.test(trimmed);
    if (isTextOp && (trimmed.endsWith("'") || trimmed.endsWith('"'))) {
      positionUncertain = true;
    }
    const inZone = positionUncertain
      ? boxes.length > 0
      : isInRedactionZone(tx, ty, boxes);
    if (inZone && isTextOp) {
      result.push(replaceStringContent(line));
      continue;
    }

    // Detect start of a multi-line TJ array in a
    // redaction zone: line has '[' but no closing '] TJ'.
    if (inZone && trimmed.includes("[") && !/\]\s*TJ\s*$/u.test(trimmed)) {
      tjBuffer = [line];
      continue;
    }

    result.push(line);
  }

  // Flush any unterminated TJ buffer (malformed stream;
  // pass through unchanged to avoid corruption).
  if (tjBuffer !== null) {
    for (const buffered of tjBuffer) {
      result.push(buffered);
    }
  }

  // Rejoin with each line's original ending preserved
  const output: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const line = result[i];
    if (line !== undefined) {
      output.push(line);
    }
    if (i < eols.length) {
      const eol = eols[i];
      if (eol !== undefined) {
        output.push(eol);
      }
    }
  }
  return output.join("");
};

const HEX_DIGITS = new Set("0123456789abcdefABCDEF");
const isHexDigit = (c: string | undefined): boolean =>
  c !== undefined && HEX_DIGITS.has(c);

/**
 * Replace the content of PDF string literals with spaces.
 * Handles both literal strings `(...)` and hex strings `<...>`
 * per the PDF spec (ISO 32000-1 §7.3.4).
 *
 * Literal strings: handles escaped parentheses (`\)`, `\(`)
 * and balanced nested parentheses. Replaces content with spaces.
 *
 * Hex strings: replaces hex digit pairs with "20" (space byte).
 * Distinguishes `<...>` hex strings from `<<...>>` dict delimiters.
 *
 * Preserves string delimiters and byte length in both cases.
 * E.g., "(Hello)" -> "(     )"
 *       "<48656C6C6F>" -> "<2020202020>"
 */
const replaceStringContent = (line: string): string => {
  let i = 0;
  const result: string[] = [];

  while (i < line.length) {
    if (line[i] === "(") {
      // Literal string — track depth to handle nesting
      result.push("(");
      i++;
      let depth = 1;

      while (i < line.length && depth > 0) {
        if (line[i] === "\\") {
          // Escape sequence: preserve both bytes but
          // replace with spaces
          result.push(" ");
          i++;
          if (i < line.length) {
            result.push(" ");
            i++;
          }
        } else if (line[i] === "(") {
          depth++;
          result.push(" ");
          i++;
        } else if (line[i] === ")") {
          depth--;
          if (depth === 0) {
            result.push(")");
          } else {
            result.push(" ");
          }
          i++;
        } else {
          result.push(" ");
          i++;
        }
      }
    } else if (line[i] === "<" && line[i + 1] !== "<") {
      // Hex string — replace each hex digit pair with "20"
      // (space byte). Skip "<<" which is a dict delimiter.
      result.push("<");
      i++;

      while (i < line.length && line[i] !== ">") {
        if (isHexDigit(line[i])) {
          // Replace hex digit pair with "20" (space byte)
          result.push("2");
          i++;
          // Consume the second digit of the pair
          if (i < line.length && isHexDigit(line[i])) {
            result.push("0");
            i++;
          }
        } else {
          // Whitespace inside hex strings is allowed;
          // preserve it
          result.push(line[i] ?? "");
          i++;
        }
      }

      if (i < line.length) {
        result.push(">");
        i++;
      }
    } else {
      result.push(line[i] ?? "");
      i++;
    }
  }

  return result.join("");
};
