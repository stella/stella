import { describe, expect, test } from "bun:test";

import {
  blocksToHtml,
  blocksToText,
  cleanedMarkdown,
  FIRST_PART_CHARACTERS,
  nextCleanupPart,
  paragraphsToHtml,
  parseCleanedInline,
  parseCleanedMarkdown,
  PART_CHARACTERS,
} from "./cleanup";

const LETTER = `Ahoj Petře,

díky za rychlou, první reakci.

K tebou **navrženým termínům jednání** této záležitosti:

1. **čtvrtek** (3. 12. 2026): bohužel ten den nemůžu.
2. můžu nabídnout pátek.

## Závěr
- doručení na adresu sídla,
- doručení *datovou schránkou*.`;

describe("parseCleanedMarkdown", () => {
  test("reads paragraphs, bold, lists and headings", () => {
    const blocks = parseCleanedMarkdown(LETTER);
    expect(blocks.map((block) => block.kind)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "list",
      "heading",
      "list",
    ]);
    expect(blocks[2]).toEqual({
      kind: "paragraph",
      inline: [
        { text: "K tebou ", bold: false, italic: false },
        { text: "navrženým termínům jednání", bold: true, italic: false },
        { text: " této záležitosti:", bold: false, italic: false },
      ],
    });
    const ordered = blocks[3];
    expect(ordered?.kind === "list" && ordered.ordered).toBe(true);
    expect(ordered?.kind === "list" && ordered.items.length).toBe(2);
    const bullets = blocks[5];
    expect(bullets?.kind === "list" && !bullets.ordered).toBe(true);
  });

  test("a list a later part continues keeps its numbering", () => {
    const blocks = parseCleanedMarkdown("4. čtvrtý bod\n5. pátý bod");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true, start: 4 });
    expect(blocksToText(blocks)).toBe("4. čtvrtý bod\n5. pátý bod");
    expect(blocksToHtml(blocks)).toBe(
      '<ol start="4"><li>čtvrtý bod</li><li>pátý bod</li></ol>',
    );
  });

  // Each unmatched opener looks its closer up once; a rescan per opener
  // would run billions of steps here and time the test out.
  test("many unmatched italic marks stay text", () => {
    const source = "*a ".repeat(50_000);
    const runs = parseCleanedInline(source);
    expect(runs).toEqual([{ text: source, bold: false, italic: false }]);
  });

  test("keeps unmatched marks and markup as text", () => {
    expect(parseCleanedInline("5 * 3 = 15 a <b>x</b>")).toEqual([
      { text: "5 * 3 = 15 a <b>x</b>", bold: false, italic: false },
    ]);
    expect(parseCleanedInline("snake_case_name")).toEqual([
      { text: "snake_case_name", bold: false, italic: false },
    ]);
  });
});

describe("copying", () => {
  test("HTML escapes text and keeps structure", () => {
    const html = blocksToHtml(
      parseCleanedMarkdown("**A & B** <script>\n\n1. one"),
    );
    expect(html).toBe(
      "<p><strong>A &amp; B</strong> &lt;script&gt;</p>\n<ol><li>one</li></ol>",
    );
  });

  test("plain text drops marks but keeps list numbers", () => {
    expect(blocksToText(parseCleanedMarkdown(LETTER))).toContain(
      "1. čtvrtek (3. 12. 2026): bohužel ten den nemůžu.",
    );
    expect(blocksToText(parseCleanedMarkdown(LETTER))).not.toContain("**");
  });

  test("raw paragraphs carry their timestamps", () => {
    expect(
      paragraphsToHtml([{ startMs: 0, text: "a < b" }], () => "0:00"),
    ).toBe("<p>[0:00] a &lt; b</p>");
  });

  test("instructions lead the saved Markdown", () => {
    expect(cleanedMarkdown(["Reply to Petr."], "Hi,", "Instructions:")).toBe(
      "> **Instructions:** Reply to Petr.\n\nHi,",
    );
    expect(cleanedMarkdown([], "Hi,", "Instructions:")).toBe("Hi,");
  });
});

const paragraph = (characters: number, startMs = 0) => ({
  startMs,
  text: "x".repeat(characters),
});

describe("nextCleanupPart", () => {
  test("waits while the only paragraph may still grow", () => {
    expect(
      nextCleanupPart({
        paragraphs: [paragraph(5000)],
        from: 0,
        finished: false,
        first: true,
        maxCharacters: 12_000,
      }),
    ).toBeNull();
  });

  test("sends a small first part once it is big enough", () => {
    const paragraphs = [paragraph(800), paragraph(800), paragraph(800)];
    expect(
      nextCleanupPart({
        paragraphs,
        from: 0,
        finished: false,
        first: true,
        maxCharacters: 12_000,
      }),
    ).toEqual({
      from: 0,
      to: 2,
      text: `${"x".repeat(800)}\n\n${"x".repeat(800)}`,
    });
    expect(FIRST_PART_CHARACTERS).toBeLessThan(PART_CHARACTERS);
  });

  test("holds a later part until it reaches its size", () => {
    expect(
      nextCleanupPart({
        paragraphs: [paragraph(100), paragraph(100), paragraph(100)],
        from: 0,
        finished: false,
        first: false,
        maxCharacters: 12_000,
      }),
    ).toBeNull();
  });

  test("sends whatever remains once transcription ended", () => {
    expect(
      nextCleanupPart({
        paragraphs: [paragraph(100), paragraph(100)],
        from: 1,
        finished: true,
        first: false,
        maxCharacters: 12_000,
      }),
    ).toEqual({ from: 1, to: 2, text: "x".repeat(100) });
    expect(
      nextCleanupPart({
        paragraphs: [paragraph(100)],
        from: 1,
        finished: true,
        first: false,
        maxCharacters: 12_000,
      }),
    ).toBeNull();
  });

  test("never exceeds the request limit", () => {
    const part = nextCleanupPart({
      paragraphs: [paragraph(700), paragraph(700), paragraph(700)],
      from: 0,
      finished: true,
      first: false,
      maxCharacters: 1500,
    });
    expect(part?.to).toBe(2);
    // ASCII only, so its length is its code points.
    expect(part?.text.length ?? 0).toBeLessThanOrEqual(1500);
  });
});
