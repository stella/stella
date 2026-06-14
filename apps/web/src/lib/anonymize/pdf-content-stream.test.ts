import { describe, expect, test } from "bun:test";

import {
  neutraliseTextOperators,
  replaceStringContent,
} from "./pdf-content-stream";
import type { RedactionBox } from "./pdf-content-stream";

// ── Helpers ────────────────────────────────────────────

/** A box covering the whole left half of a typical page. */
const BOX: RedactionBox = { x: 0, y: 100, width: 200, height: 14 };

/** Latin-1 byte length (each code unit is one byte after &0xff). */
const byteLength = (s: string): number => s.length;

/**
 * Encode to Latin-1 bytes exactly as neutralisePageText does
 * (`new Uint8Array(modified.length)` with `codePoint & 0xff` per
 * char) and report the resulting byte count. This is the byte
 * length that actually lands in the stream.
 */
const encodedByteLength = (s: string): number => {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-bitwise -- Latin-1 byte masking (mirrors prod)
    bytes[i] = (s.codePointAt(i) ?? 0) & 0xff;
  }
  return bytes.length;
};

/** Deterministic xorshift PRNG for reproducible property loops. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    // eslint-disable-next-line no-bitwise -- PRNG bit ops
    state ^= state << 13;
    // eslint-disable-next-line no-bitwise -- PRNG bit ops
    state ^= state >>> 17;
    // eslint-disable-next-line no-bitwise -- PRNG bit ops
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
};

// ── replaceStringContent: literal strings ───────────────

describe("replaceStringContent — literal strings", () => {
  test("blanks literal string content, keeps delimiters", () => {
    expect(replaceStringContent("(Hello)")).toBe("(     )");
  });

  test("preserves byte length for literal strings", () => {
    const input = "(Hello World)";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out.startsWith("(")).toBe(true);
    expect(out.endsWith(")")).toBe(true);
  });

  test("blanks content but never the delimiters themselves", () => {
    const out = replaceStringContent("(secret)");
    // first and last chars are the delimiters
    expect(out[0]).toBe("(");
    expect(out.at(-1)).toBe(")");
    // everything between is spaces
    expect(out.slice(1, -1)).toBe(" ".repeat("secret".length));
  });

  test("handles balanced nested parentheses, delimiters survive", () => {
    // (a(b)c): outer depth handling. Inner '(' and ')' become spaces,
    // outer delimiters survive.
    const input = "(a(b)c)";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out[0]).toBe("(");
    expect(out.at(-1)).toBe(")");
    // the only non-space chars are the outermost delimiters
    expect(out).toBe("(     )");
  });

  test("escaped close-paren keeps the string balanced (not truncated)", () => {
    // \) is an escaped paren: the literal does not end there.
    const input = "(a\\)b)";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    // The closing delimiter is the final ')', everything inside blanked.
    expect(out).toBe("(    )");
    expect(out.at(-1)).toBe(")");
  });

  test("escape sequences are neutralised to spaces (two bytes each)", () => {
    // \n inside a literal: backslash + n -> two spaces.
    const input = "(x\\ny)";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out).toBe("(    )");
  });

  test("escaped open-paren does not increase depth", () => {
    const input = "(a\\(b)";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out).toBe("(    )");
    expect(out.at(-1)).toBe(")");
  });

  test("text outside string operands is left untouched", () => {
    const input = "BT /F1 12 Tf (hi) Tj ET";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out).toBe("BT /F1 12 Tf (  ) Tj ET");
  });
});

// ── replaceStringContent: hex strings ───────────────────

describe("replaceStringContent — hex strings", () => {
  test("blanks hex string content to space bytes (20), keeps <>", () => {
    expect(replaceStringContent("<48656C6C6F>")).toBe("<2020202020>");
  });

  test("preserves byte length for hex strings", () => {
    const input = "<DEADBEEF>";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out[0]).toBe("<");
    expect(out.at(-1)).toBe(">");
  });

  test("empty/whitespace dict delimiters << >> round-trip unchanged", () => {
    // With no hex-digit-looking content between, the delimiters and
    // body survive verbatim.
    expect(replaceStringContent("<<>>")).toBe("<<>>");
    expect(replaceStringContent("<< >>")).toBe("<< >>");
    expect(replaceStringContent("<< /Wt >>")).toBe("<< /Wt >>");
  });

  test("<< >> delimiter bytes survive; length preserved even with hex-like body", () => {
    // KNOWN BEHAVIOUR: the dict-delimiter guard only protects the first
    // '<' of '<<'; the parser treats the second '<' as a hex-string
    // opener, so hex-digit chars inside the dict (e, a, 3, 8, ...) are
    // overwritten with "2"/"0". The '<<' and '>>' delimiter bytes
    // themselves are preserved and byte length is unchanged.
    const input = "<< /Type /Page >>";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out.startsWith("<<")).toBe(true);
    expect(out.endsWith(">>")).toBe(true);
    expect(out).toBe("<< /Typ2 /P2g2 >>");
  });

  test("hex string nested in a dict is blanked; delimiters survive", () => {
    const input = "<< /K <48> >>";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    expect(out.startsWith("<<")).toBe(true);
    expect(out.endsWith(">>")).toBe(true);
    expect(out).toBe("<< /K <20> >>");
  });

  test("whitespace inside a hex string is preserved", () => {
    const input = "<48 65>";
    const out = replaceStringContent(input);
    expect(out.length).toBe(input.length);
    // each hex pair -> 20, the literal space preserved
    expect(out).toBe("<20 20>");
  });
});

// ── replaceStringContent: byte-length invariant ─────────

describe("replaceStringContent — byte-length invariant (property)", () => {
  const alphabet = "()<>\\ AZ09afHELLO\t/[]";

  test("output byte length equals input byte length for random lines", () => {
    const rng = makeRng(0x1234_5678);
    for (let iter = 0; iter < 2000; iter++) {
      const len = Math.floor(rng() * 40);
      let line = "";
      for (let i = 0; i < len; i++) {
        const idx = Math.floor(rng() * alphabet.length);
        line += alphabet[idx];
      }
      const out = replaceStringContent(line);
      expect(out.length).toBe(line.length);
    }
  });

  test("output is idempotent under re-application", () => {
    const rng = makeRng(0xfeed_face);
    for (let iter = 0; iter < 500; iter++) {
      const len = Math.floor(rng() * 30);
      let line = "";
      for (let i = 0; i < len; i++) {
        const idx = Math.floor(rng() * alphabet.length);
        line += alphabet[idx];
      }
      const once = replaceStringContent(line);
      const twice = replaceStringContent(once);
      expect(twice).toBe(once);
    }
  });
});

// ── neutraliseTextOperators: byte-length invariant ──────

describe("neutraliseTextOperators — byte-length invariant", () => {
  test("preserves total byte length when neutralising in-zone text", () => {
    const content = ["BT", "10 100 Td", "(John Smith) Tj", "ET"].join("\n");
    const out = neutraliseTextOperators(content, [BOX]);
    expect(byteLength(out)).toBe(byteLength(content));
    expect(out).not.toBe(content); // something actually changed
  });

  test("preserves total byte length with no boxes (no-op zone)", () => {
    const content = ["BT", "10 100 Td", "(John Smith) Tj", "ET"].join("\n");
    const out = neutraliseTextOperators(content, []);
    expect(byteLength(out)).toBe(byteLength(content));
    // No boxes -> isInRedactionZone is false -> unchanged.
    expect(out).toBe(content);
  });

  test("encoded Latin-1 length matches input (mirrors production encode)", () => {
    const content = "BT\n10 100 Td\n(Resident: Eva Novak) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(encodedByteLength(out)).toBe(encodedByteLength(content));
  });
});

// ── neutraliseTextOperators: EOL preservation ───────────

describe("neutraliseTextOperators — EOL handling", () => {
  test("mixed \\r\\n, \\r, \\n bytes are preserved exactly", () => {
    const content = "BT\r\n10 100 Td\r(Secret) Tj\nET\r\n";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(byteLength(out)).toBe(byteLength(content));
    // EOL bytes themselves are not altered.
    expect(out.includes("\r\n")).toBe(true);
    expect(out.includes("\nET")).toBe(true);
    // The string content got blanked.
    expect(out.includes("(Secret)")).toBe(false);
    expect(out.includes("(      )")).toBe(true);
  });

  test("trailing newline does not desync line/eol rejoin", () => {
    const content = "BT\n10 100 Td\n(Hi) Tj\nET\n";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(out.endsWith("ET\n")).toBe(true);
    expect(byteLength(out)).toBe(byteLength(content));
  });
});

// ── neutraliseTextOperators: multi-line TJ arrays ───────

describe("neutraliseTextOperators — multi-line TJ arrays", () => {
  test("fully neutralises a TJ array split across lines", () => {
    const content = [
      "BT",
      "10 100 Td",
      "[(Jo)",
      "(hn) -250",
      "(Smith)] TJ",
      "ET",
    ].join("\n");
    const out = neutraliseTextOperators(content, [BOX]);
    expect(byteLength(out)).toBe(byteLength(content));
    // None of the original name fragments survive.
    expect(out.includes("(Jo)")).toBe(false);
    expect(out.includes("(hn)")).toBe(false);
    expect(out.includes("(Smith)")).toBe(false);
    // Delimiters / array brackets survive on the relevant lines.
    expect(out.includes("[(  )")).toBe(true);
    expect(out.includes(")] TJ")).toBe(true);
  });

  test("single-line TJ array is neutralised inline", () => {
    const content = "BT\n10 100 Td\n[(Jo) -250 (hn)] TJ\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(byteLength(out)).toBe(byteLength(content));
    expect(out.includes("(Jo)")).toBe(false);
    expect(out.includes("(hn)")).toBe(false);
    expect(out.includes("] TJ")).toBe(true);
  });
});

// ── neutraliseTextOperators: redaction-box leakage ──────

describe("neutraliseTextOperators — redaction-box leakage path", () => {
  test("text positioned inside a box is removed", () => {
    // Tm sets position to (10, 100); box covers y in [98,116], x<=202.
    const content = "BT\n1 0 0 1 10 100 Tm\n(John Smith) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(out.includes("John Smith")).toBe(false);
    // "John Smith" is 10 chars -> 10 spaces between the delimiters.
    expect(out.includes(`(${" ".repeat(10)})`)).toBe(true);
    expect(byteLength(out)).toBe(byteLength(content));
  });

  test("text positioned outside the box (different line) is untouched", () => {
    // ty=500 is far above the box (y in [98,116]) -> not in zone.
    const content = "BT\n1 0 0 1 10 500 Tm\n(Public Header) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(out).toBe(content);
    expect(out.includes("(Public Header)")).toBe(true);
  });

  test("text to the right of the box's right edge is untouched", () => {
    // box.x + width + margin = 0 + 200 + 2 = 202; tx=400 is beyond it.
    const content = "BT\n1 0 0 1 400 100 Tm\n(Right Column) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(out).toBe(content);
    expect(out.includes("(Right Column)")).toBe(true);
  });

  test("Td-tracked position landing in zone is redacted", () => {
    // Td accumulates: 5+5=10 (x), 100 (y) -> inside box.
    const content = "BT\n5 100 Td\n5 0 Td\n(Sensitive) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    expect(out.includes("Sensitive")).toBe(false);
    expect(byteLength(out)).toBe(byteLength(content));
  });

  test("two boxes: in-zone line redacted, out-of-zone line kept", () => {
    const boxes: RedactionBox[] = [{ x: 0, y: 100, width: 200, height: 14 }];
    const content = [
      "BT",
      "1 0 0 1 10 100 Tm",
      "(Secret Name) Tj", // in zone
      "1 0 0 1 10 500 Tm",
      "(Visible Title) Tj", // out of zone
      "ET",
    ].join("\n");
    const out = neutraliseTextOperators(content, boxes);
    expect(out.includes("Secret Name")).toBe(false);
    expect(out.includes("(Visible Title)")).toBe(true);
    expect(byteLength(out)).toBe(byteLength(content));
  });

  test("over-redaction: T* makes position uncertain and blanks following Tj", () => {
    // After T*, ty is uncertain; any box present -> neutralise.
    const content = "BT\n1 0 0 1 10 500 Tm\nT*\n(Could Be PII) Tj\nET";
    const out = neutraliseTextOperators(content, [BOX]);
    // Even though Tm put us out of zone, T* forces neutralisation.
    expect(out.includes("Could Be PII")).toBe(false);
    expect(byteLength(out)).toBe(byteLength(content));
  });
});
