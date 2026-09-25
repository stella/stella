/**
 * The RTF reader against the constructs the court dialect states.
 *
 * Fixture-free on purpose: every case here is one construct written out, so a
 * failure names the construct rather than a document. The end-to-end reading of
 * a real decision is `parsers/hu-bhgy.test.ts`, which drives the same reader
 * from a captured file.
 */

import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  BlockContent,
  Paragraph,
  Run,
  RunContent,
} from "@stll/docx-core/model";

import { isRtf, readRtf } from "@/api/lib/legal-search/parsers/rtf-reader";

/**
 * The bytes a document holds, one per character: RTF is a byte format and the
 * reader is given bytes. A character above a byte cannot be one, and
 * `Uint8Array.from` would keep its low eight bits and read as a case that
 * passes, so it is refused rather than truncated.
 */
const bytesOf = (rtf: string): Uint8Array =>
  Uint8Array.from(rtf, (character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 0xff
      ? point
      : panic(`RTF is written a byte at a time: U+${point.toString(16)}`);
  });

const runsOf = (paragraph: Paragraph): Run[] =>
  paragraph.content.filter((item): item is Run => item.type === "run");

const runContentText = (item: RunContent): string => {
  switch (item.type) {
    case "text":
      return item.text;
    case "tab":
      return "\t";
    case "break":
      return "\n";
    // Verbatim-preserved markup folio does not model. Its `text` is what the
    // markup puts on the line (a `w:ruby` base is visible text), so this
    // reads it rather than dropping the characters.
    case "preservedXml":
      return item.text;
    // Carry no characters of their own: a symbol, a note mark, a field's own
    // instruction text, a hyphen the layout inserted, a drawing or a shape all
    // reach the text through the runs around them.
    case "symbol":
    case "footnoteRef":
    case "endnoteRef":
    case "fieldChar":
    case "instrText":
    case "softHyphen":
    case "noBreakHyphen":
    case "renderedPageBreak":
    case "drawing":
    case "shape":
      return "";
    default:
      item satisfies never;
      return panic(`Unhandled run content: ${JSON.stringify(item)}`);
  }
};

const textOf = (block: BlockContent): string => {
  if (block.type !== "paragraph") {
    return "";
  }
  return runsOf(block)
    .flatMap((run) => run.content)
    .map(runContentText)
    .join("");
};

const paragraphsOf = (rtf: string): string[] =>
  readRtf(bytesOf(rtf)).package.document.content.map(textOf);

const HEADER = String.raw`{\rtf1\ansi\ansicpg1250\deff0{\fonttbl{\f0\froman Times;}}{\colortbl ;\red0\green0\blue0;\red0\green0\blue0;}\viewkind4\uc1\pard\qj\f0\fs24 `;

describe("code pages", () => {
  test("reads `\\'xx` against the document's own ansicpg", () => {
    // 0xF5 is ő in windows-1250 and õ in windows-1252: the same byte, two
    // letters, and the collection holds documents in both.
    expect(
      paragraphsOf(String.raw`{\rtf1\ansi\ansicpg1250 Gy\'f5r\par }`),
    ).toEqual(["Győr"]);
    expect(
      paragraphsOf(String.raw`{\rtf1\ansi\ansicpg1252 Gy\'f5r\par }`),
    ).toEqual(["Győr".replace("ő", "õ")]);
  });

  test("a code page outside the map is reported, not guessed at", () => {
    const document = readRtf(
      bytesOf(String.raw`{\rtf1\ansi\ansicpg99999 a\par }`),
    );
    expect(document.warnings).toEqual([
      "rtf: unhandled control word \\ansicpg99999",
    ]);
  });

  test("`\\uN` states a code point the code page cannot", () => {
    // The control word is six ASCII characters, written as such: the character
    // they name is not a byte, so an RTF holding it directly is not a document
    // this reader is ever handed.
    expect(
      paragraphsOf(String.raw`{\rtf1\ansi\ansicpg1250\uc1 a舑 ?b\par }`),
    ).toEqual(["a–b"]);
  });

  test("a `\\'xx` replacement character after `\\uN` is not text", () => {
    expect(
      paragraphsOf(String.raw`{\rtf1\ansi\ansicpg1252\uc1 a\u8211\'96b\par }`),
    ).toEqual(["a–b"]);
  });

  test("a surrogate pair written as two escapes reads as one character", () => {
    // Each half carries its own replacement character, and the writer may
    // break the line between them.
    const [text] = paragraphsOf(
      `{\\rtf1\\ansi\\ansicpg1252\\uc1 a\\u-10179\r\n\\'3f\\u-8704\\'3fb\\par }`,
    );
    expect(text).toBe("a\u{1F600}b");
    expect(text?.isWellFormed()).toBe(true);
  });

  test("`\\ucN` skips exactly N replacement characters, in either form", () => {
    for (const count of [0, 1, 2, 3]) {
      for (const replacement of ["?", String.raw`\'3f`]) {
        const fallback = replacement.repeat(count);
        expect(
          paragraphsOf(
            String.raw`{\rtf1\ansi\ansicpg1252\uc${count} a\u8211${fallback}b\par }`,
          ),
        ).toEqual(["a–b"]);
      }
    }
  });

  test("`\\ucN` holds for its group and the outer count returns after it", () => {
    expect(
      paragraphsOf(
        String.raw`{\rtf1\ansi\ansicpg1252\uc1 {\uc0 a\u8211b}c\u8211?d\par }`,
      ),
    ).toEqual(["a–bc–d"]);
  });
});

describe("paragraphs and alignment", () => {
  test("`\\par` ends a paragraph and `\\qc` centres one", () => {
    const blocks = readRtf(
      bytesOf(`${HEADER}first\\par \\pard\\qc second\\par }`),
    ).package.document.content;
    expect(blocks.map(textOf)).toEqual(["first", "second"]);
    expect(
      blocks.map((block) =>
        block.type === "paragraph" ? block.formatting?.alignment : null,
      ),
    ).toEqual(["both", "center"]);
  });

  test("an unterminated last paragraph is still the document's text", () => {
    expect(paragraphsOf(`${HEADER}first\\par second}`)).toEqual([
      "first",
      "second",
    ]);
  });

  test("`\\tab` and `\\line` are content, not characters of their own", () => {
    const [paragraph] = readRtf(bytesOf(`${HEADER}a\\tab b\\line c\\par }`))
      .package.document.content;
    expect(paragraph?.type).toBe("paragraph");
    const kinds =
      paragraph?.type === "paragraph"
        ? runsOf(paragraph).flatMap((run) =>
            run.content.map(({ type }) => type),
          )
        : [];
    expect(kinds).toEqual(["text", "tab", "text", "break", "text"]);
  });
});

describe("character state", () => {
  test("`\\b` and `\\b0` bound a bold run", () => {
    const [paragraph] = readRtf(
      bytesOf(`${HEADER}plain \\b bold\\b0  after\\par }`),
    ).package.document.content;
    const runs = paragraph?.type === "paragraph" ? runsOf(paragraph) : [];
    expect(
      runs.map((run) => [
        run.formatting?.bold ?? false,
        run.content
          .map((item) => (item.type === "text" ? item.text : ""))
          .join(""),
      ]),
    ).toEqual([
      [false, "plain "],
      [true, "bold"],
      [false, " after"],
    ]);
  });

  test("a coloured run keeps its colour: this publisher marks redactions with it", () => {
    const [paragraph] = readRtf(
      bytesOf(`${HEADER}A \\cf2 alperes neve\\cf0  ellen\\par }`),
    ).package.document.content;
    const runs = paragraph?.type === "paragraph" ? runsOf(paragraph) : [];
    expect(runs.map((run) => run.formatting?.color !== undefined)).toEqual([
      false,
      true,
      false,
    ]);
  });

  test("a group's close restores the state it opened with", () => {
    const [paragraph] = readRtf(bytesOf(`${HEADER}a {\\b b} c\\par }`)).package
      .document.content;
    const runs = paragraph?.type === "paragraph" ? runsOf(paragraph) : [];
    expect(runs.at(-1)?.formatting?.bold ?? false).toBe(false);
  });
});

describe("header tables and destinations", () => {
  test("the colour table's own text never reaches the document", () => {
    expect(paragraphsOf(`${HEADER}body\\par }`)).toEqual(["body"]);
  });

  test("a `\\*` destination is skipped whole", () => {
    expect(
      paragraphsOf(`${HEADER}before {\\*\\generator Word;}after\\par }`),
    ).toEqual(["before after"]);
  });
});

describe("tables", () => {
  test("`\\trowd`/`\\cell`/`\\row` build a table beside the paragraphs", () => {
    const blocks = readRtf(
      bytesOf(
        `${HEADER}intro\\par \\trowd\\cellx3000\\cellx6000\\pard\\intbl left\\cell right\\cell\\row \\pard\\qj after\\par }`,
      ),
    ).package.document.content;
    expect(blocks.map(({ type }) => type)).toEqual([
      "paragraph",
      "table",
      "paragraph",
    ]);
    const [, table] = blocks;
    expect(
      table?.type === "table"
        ? table.rows.map((row) =>
            row.cells.map((cell) =>
              cell.content.map((item) => textOf(item)).join(""),
            ),
          )
        : null,
    ).toEqual([["left", "right"]]);
  });
});

describe("footnotes", () => {
  test("a note's text hangs off the package, not off the sentence", () => {
    const document = readRtf(
      bytesOf(`${HEADER}body{\\footnote\\chftn  the note}text\\par }`),
    );
    expect(document.package.document.content.map(textOf)).toEqual(["bodytext"]);
    expect(
      (document.package.footnotes ?? []).map((note) =>
        note.content.map((item) => textOf(item)).join(""),
      ),
    ).toEqual([" the note"]);
  });
});

describe("what the reader does not recognise", () => {
  test("an unknown control word is reported rather than dropped in silence", () => {
    const document = readRtf(bytesOf(`${HEADER}a\\shpinst b\\par }`));
    expect(document.warnings).toEqual([
      "rtf: unhandled control word \\shpinst",
    ]);
  });

  test("a known word run into the text keeps the text", () => {
    // The court's writer omits the delimiter in its signature blocks:
    // `\tabDr.Kovács` is a tab and a name, and taking the longest run of
    // letters as the control word swallows the `Dr`.
    expect(paragraphsOf(`${HEADER}\\tabDr.Kovács sk.\\par }`)).toEqual([
      "\tDr.Kovács sk.",
    ]);
  });
});

describe("recognising RTF at all", () => {
  test("only the signature says a payload is RTF", () => {
    expect(isRtf(bytesOf("{\\rtf1\\ansi"))).toBe(true);
    expect(isRtf(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
    expect(isRtf(Uint8Array.from([]))).toBe(false);
  });
});
