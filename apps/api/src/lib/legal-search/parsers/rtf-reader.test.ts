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
import fc from "fast-check";

import type {
  BlockContent,
  Paragraph,
  Run,
  RunContent,
} from "@stll/docx-core/model";
import { propertyConfig } from "@stll/property-testing";

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

  test("a font's `\\fcharsetN` outranks the document's ansicpg for its bytes", () => {
    // Word on a Western-European machine: `\ansicpg1252`, and the Hungarian
    // text in a Central-European font. Read against the document's page,
    // every "ő" and "ű" in the collection printed as "õ" and "û".
    const fonts = String.raw`{\fonttbl{\f0\froman\fcharset238 Times New Roman CE;}{\f1\fswiss\fcharset0 Arial;}}`;
    expect(
      paragraphsOf(
        String.raw`{\rtf1\ansi\ansicpg1252\deff0${fonts}\pard Gy\'f5r b\'fbn\par \f1 Gy\'f5r\par {\f0 Gy\'f5r} Gy\'f5r\par }`,
      ),
    ).toEqual(["Győr bűn", "Gyõr", "Győr Gyõr"]);
  });

  test("bytes before `\\plain` keep the font they were written in", () => {
    const fonts = String.raw`{\fonttbl{\f0\fcharset238 CE;}{\f1\fcharset0 Arial;}}`;
    expect(
      paragraphsOf(
        String.raw`{\rtf1\ansi\ansicpg1252\deff0${fonts}\f1 S\'f8ren\plain , next\par }`,
      ),
    ).toEqual(["Søren, next"]);
    expect(
      paragraphsOf(
        String.raw`{\rtf1\ansi\ansicpg1252\deff1${fonts}\f0 Gy\'f5r\plain , next\par }`,
      ),
    ).toEqual(["Győr, next"]);
  });

  test("every byte reads in the font active when it was written", () => {
    // Font switches, resets and groups in any order: the reader's text must
    // equal what a model of the font state says each byte was written in.
    const FONTS = [
      { charset: 238, label: "windows-1250" },
      { charset: 0, label: "windows-1252" },
      { charset: 204, label: "windows-1251" },
    ] as const;
    type Step =
      | { type: "byte"; byte: number }
      | { type: "font"; font: number }
      | { type: "plain" }
      | { type: "group"; steps: Step[] };
    const step: fc.Memo<Step> = fc.memo((depth) =>
      fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.record({
          type: fc.constant("byte" as const),
          byte: fc.integer({ min: 0xc0, max: 0xff }),
        }),
        fc.record({
          type: fc.constant("font" as const),
          font: fc.integer({ min: 0, max: FONTS.length - 1 }),
        }),
        fc.record({ type: fc.constant("plain" as const) }),
        depth <= 1
          ? fc.record({ type: fc.constant("plain" as const) })
          : fc.record({
              type: fc.constant("group" as const),
              steps: fc.array(step(depth - 1), { maxLength: 6 }),
            }),
      ),
    );
    const render = (steps: readonly Step[]): string =>
      steps
        .map((current) => {
          switch (current.type) {
            case "byte":
              return String.raw`\'${current.byte.toString(16)}`;
            case "font":
              return String.raw`\f${String(current.font)} `;
            case "plain":
              return String.raw`\plain `;
            case "group":
              return `{${render(current.steps)}}`;
            default:
              current satisfies never;
              return panic("Unhandled step");
          }
        })
        .join("");
    const expected = (
      steps: readonly Step[],
      entryFont: number,
      defaultFont: number,
    ): string => {
      let font = entryFont;
      let text = "";
      for (const current of steps) {
        switch (current.type) {
          case "byte":
            text += new TextDecoder(FONTS[font]?.label).decode(
              Uint8Array.of(current.byte),
            );
            break;
          case "font":
            ({ font } = current);
            break;
          case "plain":
            font = defaultFont;
            break;
          case "group":
            text += expected(current.steps, font, defaultFont);
            break;
          default:
            current satisfies never;
            panic("Unhandled step");
        }
      }
      return text;
    };
    const fontTable = FONTS.map(
      ({ charset }, index) =>
        String.raw`{\f${String(index)}\fcharset${String(charset)} F;}`,
    ).join("");
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: FONTS.length - 1 }),
        fc.array(step(3), { maxLength: 30 }),
        (defaultFont, steps) => {
          const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff${String(defaultFont)}{\fonttbl${fontTable}}\pard ${render(steps)}\par }`;
          const text = expected(steps, defaultFont, defaultFont);
          expect(paragraphsOf(rtf).join("")).toBe(text);
        },
      ),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("an OEM code page no decoder here reads is reported, not read as another", () => {
    // Code page 437 byte 0x82 is "é"; IBM866 reads the same byte as "В".
    expect(
      readRtf(bytesOf(String.raw`{\rtf1\ansi\ansicpg437 caf\'82\par }`))
        .warnings,
    ).toEqual(["rtf: unhandled control word \\ansicpg437"]);
    const oemFont = readRtf(
      bytesOf(
        String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset255 Terminal;}}\f1 caf\'82\par }`,
      ),
    );
    expect(oemFont.warnings).toEqual([
      "rtf: unhandled control word \\fcharset255",
    ]);
    const [paragraph] = oemFont.package.document.content;
    expect(paragraph === undefined ? "" : textOf(paragraph)).not.toContain("В");
  });

  test("a font charset no decoder here reads is reported only where the text uses it", () => {
    expect(
      readRtf(
        bytesOf(
          String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset128 MS Mincho;}}caf\'e9\f1 abc\par }`,
        ),
      ).warnings,
    ).toBeUndefined();
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
      paragraphsOf(String.raw`{\rtf1\ansi\ansicpg1250\uc1 a\u8211 ?b\par }`),
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

  test("an escaped brace or backslash replacement character is not text", () => {
    for (const replacement of [
      String.raw`\{`,
      String.raw`\}`,
      String.raw`\\`,
    ]) {
      expect(
        paragraphsOf(
          String.raw`{\rtf1\ansi\ansicpg1252\uc2 a\u8211${replacement}?b\par }`,
        ),
      ).toEqual(["a–b"]);
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
