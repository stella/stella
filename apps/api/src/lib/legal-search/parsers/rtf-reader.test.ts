import { panic, Result } from "better-result";
/**
 * The RTF reader against the constructs the court dialect states.
 *
 * Fixture-free on purpose: every case here is one construct written out, so a
 * failure names the construct rather than a document. The end-to-end reading of
 * a real decision is `parsers/hu-bhgy.test.ts`, which drives the same reader
 * from a captured file.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { BlockContent, Paragraph, Run } from "@stll/docx-core/model";
import { assertProperty } from "@stll/property-testing";

import { markupResidueIn } from "@/api/lib/legal-search/parsers/markup-residue";
import {
  embeddedTextFixtures,
  embeddedTextRtf,
} from "@/api/lib/legal-search/parsers/rtf-destinations.fixtures";
import {
  isRtf,
  readRtf,
  readRtfString,
} from "@/api/lib/legal-search/parsers/rtf-reader";

import { runContentVisibleText } from "./run-content-text";

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

const textOf = (block: BlockContent): string => {
  if (block.type !== "paragraph") {
    return "";
  }
  return runsOf(block)
    .flatMap((run) => run.content)
    .map(runContentVisibleText)
    .join("");
};

const paragraphsOf = (rtf: string): string[] =>
  readRtf(bytesOf(rtf)).package.document.content.map(textOf);

const HEADER = String.raw`{\rtf1\ansi\ansicpg1250\deff0{\fonttbl{\f0\froman Times;}}{\colortbl ;\red0\green0\blue0;\red0\green0\blue0;}\viewkind4\uc1\pard\qj\f0\fs24 `;

test("invalid Unicode code points fail RTF parsing instead of publishing partial text", () => {
  assertProperty(
    "invalid Unicode code points fail RTF parsing instead of publishing partial text",
    fc.property(
      fc.oneof(
        fc.integer({ min: 0x11_00_00, max: 0x7f_ff_ff_ff }),
        fc.integer({ min: -0x7f_ff_ff_ff, max: -65_537 }),
      ),
      (parameter) => {
        expect(() =>
          readRtfString(`{\\rtf1 before\\u${parameter} after}`),
        ).toThrow(RangeError);
      },
    ),
    { numRuns: 100 },
  );
});

test("generated RTF retains plain text without markup residue", () => {
  const plainText = fc
    .array(fc.constantFrom("alpha", "beta", "gamma", "delta", "šťáva😀"), {
      minLength: 1,
      maxLength: 8,
    })
    .map((words) => words.join(" "));
  const destination = fc.constantFrom(
    String.raw`{\*\unknown \rtf1\ansi hidden}`,
    String.raw`{\*\unknown \result hidden}`,
    String.raw`{\*\unknown{\footnote hidden}}`,
    String.raw`{\info\trowd hidden\cell\row}`, // unknown destination
    String.raw`{\pict\pngblip 89504e470d0a1a0000000d4948445200000000}`,
    String.raw`{\object{\*\objdata\bin4 abcd}}`,
    String.raw`{\*\unknown \rtf1\ansi hidden`, // unbalanced group
  );
  const binaryPayload = fc
    .array(fc.integer({ min: 0, max: 255 }), { maxLength: 48 })
    .map((bytes) => String.fromCodePoint(...bytes));
  const encoded = fc.constantFrom(
    String.raw`\'e1`,
    String.raw`\u225?`,
    String.raw`\uc2\u225??\uc1 `,
  );

  assertProperty(
    "generated RTF retains plain text without markup residue",
    fc.property(
      plainText,
      fc.array(encoded, { minLength: 1, maxLength: 8 }),
      fc.array(destination, { maxLength: 8 }),
      fc.nat({ max: 6 }),
      fc.nat({ max: 4 }),
      fc.array(binaryPayload, { minLength: 1, maxLength: 4 }),
      (text, escapes, destinations, nesting, unmatchedClosings, payloads) => {
        const visible = `${text}${escapes.join("")}`;
        const nested = `${"{".repeat(nesting)}${visible}${"}".repeat(nesting)}`;
        const binary = payloads
          .map((payload) => `\\bin${String(payload.length)} ${payload}`)
          .join("");
        const rtf = `${HEADER}${nested}${binary}tail${destinations.join("")}\\par }${"}".repeat(unmatchedClosings)}`;
        const document = readRtfString(rtf);
        const output = [
          ...document.package.document.content.map(textOf),
          ...(document.package.footnotes ?? []).flatMap(({ content }) =>
            content.map(textOf),
          ),
        ].join(" ");
        expect(output).toBe(`${text}${"á".repeat(escapes.length)}tail`);
        expect(markupResidueIn(output)).toBeUndefined();
      },
    ),
    { numRuns: 300 },
  );
});

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
    assertProperty(
      "every byte reads in the font active when it was written",
      fc.property(
        fc.integer({ min: 0, max: FONTS.length - 1 }),
        fc.array(step(3), { maxLength: 30 }),
        (defaultFont, steps) => {
          const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff${String(defaultFont)}{\fonttbl${fontTable}}\pard ${render(steps)}\par }`;
          const text = expected(steps, defaultFont, defaultFont);
          expect(paragraphsOf(rtf).join("")).toBe(text);
        },
      ),
      { numRuns: 300 },
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
          String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset130 Johab;}}caf\'e9\f1 abc\par }`,
        ),
      ).warnings,
    ).toBeUndefined();
  });

  test("a double-byte font's lead and trail byte read as one character", () => {
    // A Hungarian writer that set "§" in a Japanese font: `\'81\'98` is "§"
    // in Shift-JIS, and two undefined bytes in the document's windows-1250.
    const fonts = String.raw`{\fonttbl{\f0\fcharset128 Arial;}{\f1\fcharset238 Arial CE;}}`;
    const document = readRtf(
      bytesOf(
        String.raw`{\rtf1\ansi\ansicpg1250\deff0${fonts}\f0 Mt.134. \'81\'98 (2) \f1 bekezd\'e9se\par }`,
      ),
    );
    expect(document.warnings).toBeUndefined();
    expect(document.package.document.content.map(textOf)).toEqual([
      "Mt.134. § (2) bekezdése",
    ]);
  });

  test("every double-byte charset reads its pairs through its own code page", () => {
    // Characters each set writes as a lead and a trail byte. A trail byte in
    // the ASCII range is written literally, as RTF writers do: `\'83A` is
    // "ア" in Shift-JIS, `\'bbO` is "臺" in Big5.
    const CHARSETS = [
      {
        charset: 128,
        bytes: String.raw`\'81\'98\'93\'8c\'8b\'9e\'83A\'83C`,
        text: "§東京アイ",
      },
      {
        charset: 129,
        bytes: String.raw`\'a1\'d7\'bc\'ad\'bf\'ef\'b0\'a1\'b3\'aa`,
        text: "§서울가나",
      },
      {
        charset: 134,
        bytes: String.raw`\'a1\'ec\'b1\'b1\'be\'a9\'d6\'d0\'81@`,
        text: "§北京中丂",
      },
      {
        charset: 136,
        bytes: String.raw`\'a1\'b1\'bbO\'a5_\'a4\'a4\'a4\'e5`,
        text: "§臺北中文",
      },
    ] as const;
    for (const { charset, bytes, text } of CHARSETS) {
      const document = readRtf(
        bytesOf(
          String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fcharset0 Arial;}{\f1\fcharset${String(charset)} F;}}a {\f1 ${bytes}} b\par }`,
        ),
      );
      expect(document.warnings).toBeUndefined();
      expect(document.package.document.content.map(textOf)).toEqual([
        `a ${text} b`,
      ]);
    }
  });

  test("Shift-JIS text reads as the decoder reads its bytes whole", () => {
    // Any sequence of valid Shift-JIS characters, written byte by byte, in
    // runs split at character boundaries by group and font changes.
    const decoder = new TextDecoder("shift_jis", { fatal: true });
    const character = fc
      .tuple(
        fc.oneof(
          fc.integer({ min: 0x81, max: 0x9f }),
          fc.integer({ min: 0xe0, max: 0xfc }),
        ),
        fc.oneof(
          fc.integer({ min: 0x40, max: 0x7e }),
          fc.integer({ min: 0x80, max: 0xfc }),
        ),
      )
      .filter((pair) =>
        Result.try(() => decoder.decode(Uint8Array.from(pair))).isOk(),
      );
    const piece = fc.record({
      pairs: fc.array(character, { minLength: 1, maxLength: 6 }),
      grouped: fc.boolean(),
    });
    assertProperty(
      "Shift-JIS text reads as the decoder reads its bytes whole",
      fc.property(fc.array(piece, { minLength: 1, maxLength: 6 }), (pieces) => {
        const written = pieces
          .map(({ pairs, grouped }) => {
            const escaped = pairs
              .flat()
              .map((byte) =>
                byte >= 0x80 || byte === 0x5c || byte === 0x7b || byte === 0x7d
                  ? String.raw`\'${byte.toString(16)}`
                  : String.fromCodePoint(byte),
              )
              .join("");
            return grouped ? `{\\f0 ${escaped}}` : String.raw`\f0 ${escaped}`;
          })
          .join("");
        const expected = pieces
          .map(({ pairs }) => decoder.decode(Uint8Array.from(pairs.flat())))
          .join("");
        const document = readRtf(
          bytesOf(
            String.raw`{\rtf1\ansi\ansicpg1250\deff1{\fonttbl{\f0\fcharset128 MS Mincho;}{\f1\fcharset238 Arial CE;}}${written}\par }`,
          ),
        );
        expect(document.warnings).toBeUndefined();
        expect(document.package.document.content.map(textOf).join("")).toBe(
          expected,
        );
      }),
      { numRuns: 200 },
    );
  });

  test("no byte or escape reaches the text as a C1 control character", () => {
    // 0x81 is undefined in windows-1250; a lone Shift-JIS lead byte has no
    // trail; `\u133` names U+0085. None is a character the writer typed.
    const cases = [
      {
        rtf: String.raw`{\rtf1\ansi\ansicpg1250 a\'81b\par }`,
        warning: "rtf: bytes undefined in windows-1250",
      },
      {
        rtf: String.raw`{\rtf1\ansi\ansicpg1250\deff0{\fonttbl{\f0\fcharset128 F;}}a\'81\par }`,
        warning: "rtf: bytes undefined in shift_jis",
      },
      {
        rtf: String.raw`{\rtf1\ansi\ansicpg1252\uc1 a\u133?b\par }`,
        warning: String.raw`rtf: \u names a C1 control character`,
      },
    ];
    for (const { rtf, warning } of cases) {
      const document = readRtf(bytesOf(rtf));
      const text = document.package.document.content.map(textOf).join("");
      expect(text).not.toMatch(/[\u0080-\u009f]/u);
      expect(text).toContain(String.fromCodePoint(0xff_fd));
      expect(document.warnings).toEqual([warning]);
    }
    assertProperty(
      "no byte under any code page decodes to a C1 control character",
      fc.property(
        fc.constantFrom(1250, 1251, 1252, 1253, 1254, 1257, 874, 932, 949),
        fc.array(fc.integer({ min: 0x80, max: 0xff }), { maxLength: 12 }),
        (codePage, bytes) => {
          const escaped = bytes
            .map((byte) => String.raw`\'${byte.toString(16)}`)
            .join("");
          const document = readRtf(
            bytesOf(
              String.raw`{\rtf1\ansi\ansicpg${String(codePage)} ${escaped}\par }`,
            ),
          );
          const text = document.package.document.content.map(textOf).join("");
          expect(text).not.toMatch(/[\u0080-\u009f]/u);
          expect(document.warnings === undefined).toBe(
            !text.includes(String.fromCodePoint(0xff_fd)),
          );
        },
      ),
      { numRuns: 300 },
    );
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

  test("`\\tab` stays inline while `\\line` ends the parsed line", () => {
    const [paragraph] = readRtf(bytesOf(`${HEADER}a\\tab b\\line c\\par }`))
      .package.document.content;
    expect(paragraph?.type).toBe("paragraph");
    const kinds =
      paragraph?.type === "paragraph"
        ? runsOf(paragraph).flatMap((run) =>
            run.content.map(({ type }) => type),
          )
        : [];
    expect(kinds).toEqual(["text", "tab", "text"]);
    expect(paragraphsOf(`${HEADER}a\\tab b\\line c\\par }`)).toEqual([
      "a\tb",
      "c",
    ]);
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
  test("starred metadata subgroups stay invisible without unsupported-destination warnings", () => {
    for (const metadata of [String.raw`\fonttbl`, String.raw`\info`]) {
      const rtf = String.raw`{\rtf1{${metadata}{\*\fname Hidden name{\*\unknownmetadata{\shptxt Hidden text}}}}Visible\par}`;
      const document = readRtf(bytesOf(rtf));
      expect(document.package.document.content.map(textOf)).toEqual([
        "Visible",
      ]);
      expect(document.warnings ?? []).toEqual([]);
    }
  });

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
    const document = readRtf(bytesOf(`${HEADER}a\\unknownprobe b\\par }`));
    expect(document.warnings).toEqual([
      "rtf: unhandled control word \\unknownprobe",
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

describe("embedded RTF text destinations", () => {
  for (const { name, group } of embeddedTextFixtures) {
    test(`keeps ${name} as separate paragraphs after its anchor`, () => {
      const rtf = embeddedTextRtf(group);
      expect(paragraphsOf(rtf).filter((text) => text.trim())).toEqual([
        "Anchor start  anchor end",
        "Box one",
        "Box two",
        "Next paragraph",
      ]);
      const box = readRtf(bytesOf(rtf)).package.document.content.find(
        (block) => textOf(block) === "Box one",
      );
      expect(box?.type).toBe("paragraph");
      if (box?.type === "paragraph") {
        expect(runsOf(box).at(0)?.formatting?.bold).toBe(true);
      }
    });
  }

  test("does not expose visible destinations nested in metadata or unknown groups", () => {
    const rtf = String.raw`{\rtf1 Before {\info{\shptxt Hidden metadata}}{\*\unknownprobe{\result Hidden unknown}} After\par}`;
    expect(paragraphsOf(rtf).filter((text) => text.trim())).toEqual([
      "Before  After",
    ]);
    expect(readRtf(bytesOf(rtf)).warnings).toContain(
      "rtf: unhandled control word \\unknownprobe",
    );
  });

  test("skips binary bytes without mistaking their braces for group boundaries", () => {
    const rtf = String.raw`{\rtf1 Before {\object{\*\objdata\bin3 }{} }{\result Box}} After\par}`;
    expect(paragraphsOf(rtf).filter((text) => text.trim())).toEqual([
      "Before  After",
      "Box",
    ]);
  });
});

describe("Unicode transport respects counted opaque spans", () => {
  for (const payload of [
    "é}{\\bin99 ",
    "ÿ{\\rtf1\\ansi}",
    "Ā}",
    "é{\\\\bin8 }",
  ]) {
    test(`binary payload ${JSON.stringify(payload)} cannot alter following text`, () => {
      const rtf = `{\\rtf1 Before \\bin${String(payload.length)} ${payload}After\\par}`;
      const document = readRtfString(rtf);
      expect(document.package.document.content.map(textOf)).toEqual([
        "Before After",
      ]);
      expect(document.package.footnotes ?? []).toEqual([]);
    });
  }
  test("Unicode fallbacks retain their scoped character counts", () => {
    const rtf = String.raw`{\rtf1\uc2\u225${"éĀ"}{\uc1\u269${"š"}}\u225${"éĀ"} After\par}`;
    expect(readRtfString(rtf).package.document.content.map(textOf)).toEqual([
      "áčá After",
    ]);
  });
  test("an escaped binary control stays literal", () => {
    expect(
      readRtfString(
        String.raw`{\rtf1 \\bin2 ${"é"}}text}`,
      ).package.document.content.map(textOf),
    ).toEqual([String.raw`\bin2 ${"é"}text`]);
  });
});

test("Unicode transport emits literal characters as complete Unicode controls", () => {
  const source = "šťáva";
  expect(readRtfString(source).package.document.content.map(textOf)).toEqual([
    source,
  ]);
  expect(
    readRtfString(
      String.raw`{\rtf1\ansi Literal ${"šťáva"} \'e1\uc2\u225??}`,
    ).package.document.content.map(textOf),
  ).toEqual(["Literal šťáva áá"]);
});

test("RTF line boundaries never merge a heading or word with following body text", () => {
  assertProperty(
    "RTF line boundaries never merge a heading or word with following body text",
    fc.property(
      fc.constantFrom("Odůvodnění", "Odlišné stanovisko", "Indokolás", "alpha"),
      fc
        .array(fc.constantFrom("a", "b", "c", "é"), {
          minLength: 1,
          maxLength: 20,
        })
        .map((letters) => letters.join("")),
      (heading, body) => {
        const document = readRtfString(
          `{\\rtf1\\b ${heading}\\line\\b0 ${body}\\par}`,
        );
        expect(document.package.document.content.map(textOf)).toEqual([
          heading,
          body,
        ]);
      },
    ),
    { numRuns: 100 },
  );
});

test.each(["line", "par", "sect", "page"])(
  "\\%s separates lines and preserves each line's formatting",
  (boundary) => {
    const document = readRtfString(
      `{\\rtf1\\qc\\b Heading\\${boundary}\\b0\\i Body\\par}`,
    );
    const blocks = document.package.document.content;
    expect(blocks.map(textOf)).toEqual(["Heading", "Body"]);
    expect(
      blocks.map((block) =>
        block.type === "paragraph" ? block.formatting?.alignment : null,
      ),
    ).toEqual(["center", "center"]);
    expect(
      blocks.map((block) =>
        block.type === "paragraph"
          ? runsOf(block).map((run) => [
              run.formatting?.bold ?? false,
              run.formatting?.italic ?? false,
            ])
          : [],
      ),
    ).toEqual([[[true, false]], [[false, true]]]);
  },
);
