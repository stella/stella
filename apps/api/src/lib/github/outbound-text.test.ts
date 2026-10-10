import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { FEEDBACK_LIMITS } from "@stll/api-contract/feedback";
import { assertProperty } from "@stll/property-testing";

import {
  GITHUB_TITLE_MAX_LENGTH,
  githubMarkdown,
  joinGithubMarkdownLines,
  toGithubUserInline,
  toGithubUserText,
  toGithubUserTitle,
} from "@/api/lib/github/outbound-text";
import {
  readCodeSpan,
  readFencedBlock,
} from "@/api/tests/helpers/commonmark-code-oracle";

const ZERO_WIDTH_SPACE = "\u200B";
const LINE_BREAK = /\r\n|\r|\n/gu;

/**
 * Text built from the pieces that can change how GitHub renders it: fences of
 * every length, line endings of every spelling, sigils, entities, HTML
 * comments and `<details>`, indentation, and ordinary characters between them.
 */
const hostileText = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "`",
        "``",
        "```",
        "````",
        "\n```\n",
        "\r\n   ````  ",
        "~~~",
        "\n",
        "\r",
        "\r\n",
        "    ",
        " ",
        "@octocat",
        "@org/team",
        "#12",
        "GH-7",
        "gh-7",
        "org/repo#3",
        "&#64;octocat",
        "&#x40;x",
        "&commat;y",
        "&#35;5",
        "<!--",
        "-->",
        "<details>",
        "</details>",
        "## Context",
        "---",
        "https://github.com/stella/stella/issues/1",
        ZERO_WIDTH_SPACE,
      ),
      fc.string({ maxLength: 4 }),
    ),
    { maxLength: 24 },
  )
  .map((pieces) => pieces.join(""));

describe("toGithubUserText", () => {
  test("hostile text stays inside one code block, verbatim", () => {
    assertProperty(
      "hostile text stays inside one code block, verbatim",
      fc.property(hostileText, (text) => {
        const block = readFencedBlock(toGithubUserText(text).markdown);
        expect(block.closedOnLastLine).toBe(true);
        expect(block.content).toBe(text.replaceAll(LINE_BREAK, "\n"));
      }),
    );
  });

  test("a run of backticks longer than the default fence cannot close it", () => {
    const text = "````\n@octocat <!-- #1\n````\n```";
    const block = readFencedBlock(toGithubUserText(text).markdown);
    expect(block.closedOnLastLine).toBe(true);
    expect(block.content).toBe(text);
  });
});

describe("toGithubUserInline", () => {
  test("hostile text is one code span on one line, verbatim", () => {
    assertProperty(
      "hostile text is one code span on one line, verbatim",
      fc.property(hostileText, (text) => {
        const markdown = toGithubUserInline(text).markdown;
        expect(markdown).not.toMatch(LINE_BREAK);
        const folded = text.replaceAll(LINE_BREAK, " ");
        const span = readCodeSpan(markdown);
        expect(span.endsAtEnd).toBe(true);
        // CommonMark keeps an all-space span unstripped; the padding then shows.
        expect(span.content).toBe(
          /^ *$/u.test(folded) ? ` ${folded} ` : folded,
        );
      }),
    );
  });
});

const LIVE_TITLE_TOKEN = /[@#][^\s\u200B]|&[#A-Za-z0-9]|gh-[0-9]|[\r\n]/iu;

const ELLIPSIS = "\u2026";
const stripZeroWidth = (text: string): string =>
  text.replaceAll(ZERO_WIDTH_SPACE, "");

/** Hostile pieces repeated well past the title limit, sigils included. */
const longHostileText = fc
  .array(hostileText, { minLength: 1, maxLength: 40 })
  .map((parts) => parts.join(""));

/**
 * Mostly sigils, so a title at the intake limit grows past GitHub's limit
 * once neutralized (each sigil gains a zero-width space).
 */
const sigilDenseText = fc
  .array(fc.constantFrom("@a", "#1", "&#", "gh-1", "a", "@", " ", "😀"), {
    minLength: 100,
    maxLength: 200,
  })
  .map((parts) => parts.join(""));

/** The title invariants that hold for any input, cut or not. */
const expectSafeTitle = (text: string): void => {
  const title = toGithubUserTitle(text).text;
  expect(title.length).toBeLessThanOrEqual(GITHUB_TITLE_MAX_LENGTH);
  expect(title).not.toMatch(LIVE_TITLE_TOKEN);
  expect(toGithubUserTitle(title).text).toBe(title);
  if (text.isWellFormed()) {
    expect(title.isWellFormed()).toBe(true);
  }
  const folded = stripZeroWidth(text.replaceAll(LINE_BREAK, " "));
  if (stripZeroWidth(title) === folded) {
    return;
  }
  // Cut: a prefix of the text and an ellipsis, as long as the limit allows
  // (one more code point adds at most two units and two zero-width spaces).
  expect(title.endsWith(ELLIPSIS)).toBe(true);
  expect(folded.startsWith(stripZeroWidth(title).slice(0, -1))).toBe(true);
  expect(title.length).toBeGreaterThan(GITHUB_TITLE_MAX_LENGTH - 4);
};

describe("toGithubUserTitle", () => {
  test("no live mention, reference or entity survives, and the visible text does", () => {
    assertProperty(
      "no live mention, reference or entity survives, and the visible text does",
      fc.property(hostileText, (text) => {
        const title = toGithubUserTitle(text).text;
        expect(title).not.toMatch(LIVE_TITLE_TOKEN);
        expect(title.replaceAll(ZERO_WIDTH_SPACE, "")).toBe(
          text.replaceAll(LINE_BREAK, " ").replaceAll(ZERO_WIDTH_SPACE, ""),
        );
        expect(toGithubUserTitle(title).text).toBe(title);
      }),
    );
  });

  test("any title up to the intake limit fits GitHub's limit once neutralized", () => {
    assertProperty(
      "any title up to the intake limit fits GitHub's limit once neutralized",
      fc.property(
        fc
          .oneof(longHostileText, sigilDenseText)
          .map((text) =>
            Array.from(text).slice(0, FEEDBACK_LIMITS.title).join(""),
          ),
        expectSafeTitle,
      ),
    );
  });

  test("any title of any length fits GitHub's limit once neutralized", () => {
    assertProperty(
      "any title of any length fits GitHub's limit once neutralized",
      fc.property(
        fc.oneof(
          longHostileText,
          fc.string({ unit: "binary", maxLength: 600 }),
        ),
        expectSafeTitle,
      ),
    );
  });

  test("a title of sigils at the intake limit is cut to the limit", () => {
    const title = toGithubUserTitle("@a".repeat(100)).text;
    expect(title).toHaveLength(GITHUB_TITLE_MAX_LENGTH);
    expect(title).toBe(`${"@\u200Ba".repeat(85)}${ELLIPSIS}`);
  });

  test("the cut never separates a sigil from its zero-width space", () => {
    expect(toGithubUserTitle(`${"a".repeat(254)}@b`).text).toBe(
      `${"a".repeat(254)}${ELLIPSIS}`,
    );
    // A sigil kept before the ellipsis is broken like any other.
    expect(toGithubUserTitle(`${"a".repeat(253)}#12`).text).toBe(
      `${"a".repeat(253)}#\u200B${ELLIPSIS}`,
    );
  });

  test("the cut falls between code points", () => {
    expect(toGithubUserTitle(`${"a".repeat(254)}😀😀`).text).toBe(
      `${"a".repeat(254)}${ELLIPSIS}`,
    );
    expect(toGithubUserTitle(`${"a".repeat(253)}😀😀`).text).toBe(
      `${"a".repeat(253)}😀${ELLIPSIS}`,
    );
  });

  test("a title that fits is not cut", () => {
    const text = "x".repeat(GITHUB_TITLE_MAX_LENGTH);
    expect(toGithubUserTitle(text).text).toBe(text);
  });

  test("each sigil spelling is broken", () => {
    expect(toGithubUserTitle("@octocat #12 GH-7 &#64;x org/repo#3").text).toBe(
      "@\u200Boctocat #\u200B12 GH\u200B-7 &\u200B#\u200B64;x org/repo#\u200B3",
    );
    expect(toGithubUserTitle("C# and mail@").text).toBe("C# and mail@");
  });
});

describe("githubMarkdown", () => {
  test("joins authored literals with safe values in order", () => {
    const value = toGithubUserInline("@a");
    expect(githubMarkdown`x ${value} y ${value}`.markdown).toBe(
      "x ` @a ` y ` @a `",
    );
    expect(
      joinGithubMarkdownLines([githubMarkdown`a`, githubMarkdown`b`]).markdown,
    ).toBe("a\nb");
  });
});
