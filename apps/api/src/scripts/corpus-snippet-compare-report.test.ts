import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { tokenizeCorpusFreeText } from "@/api/lib/legal-search/corpus-query";
import {
  compareSnippetFragments,
  DEFAULT_SNIPPET_COMPARE_LIMIT,
  parseSnippetCompareArgs,
  parseSnippetCompareQueryFile,
  passageSkipReason,
  renderSnippetCompareMarkdown,
  SnippetCompareFileError,
  snippetCompareReport,
  summarizeSnippetComparison,
  type SnippetCompareQueryRow,
} from "@/api/scripts/corpus-snippet-compare-report";

/** Argument and query-file parsing, the fragment comparison, the renderings. */

describe("parseSnippetCompareArgs", () => {
  test("parses the required flags and defaults the page size", () => {
    expect(
      parseSnippetCompareArgs([
        "--queries",
        "queries.json",
        "--out-dir",
        ".cache/snippets",
      ]),
    ).toEqual({
      type: "parsed",
      args: {
        queriesPath: "queries.json",
        outDir: ".cache/snippets",
        limit: DEFAULT_SNIPPET_COMPARE_LIMIT,
      },
    });
  });

  test("takes an explicit page size", () => {
    expect(
      parseSnippetCompareArgs([
        "--queries",
        "q.json",
        "--out-dir",
        "out",
        "--limit",
        "3",
      ]),
    ).toEqual({
      type: "parsed",
      args: { queriesPath: "q.json", outDir: "out", limit: 3 },
    });
  });

  test.each([
    [[]],
    [["--queries", "q.json"]],
    [["--out-dir", "out"]],
    [["--queries", "q.json", "--out-dir", "out", "--depth", "3"]],
    [["--queries", "q.json", "--queries", "r.json", "--out-dir", "out"]],
    [["queries.json", "--out-dir", "out"]],
    [["--queries", "--out-dir", "out"]],
    [["--queries", "q.json", "--out-dir", "out", "--limit", "0"]],
    [["--queries", "q.json", "--out-dir", "out", "--limit", "many"]],
  ])("rejects %j", (argv) => {
    expect(parseSnippetCompareArgs(argv).type).toBe("invalid");
  });
});

describe("parseSnippetCompareQueryFile", () => {
  test("parses a query set", () => {
    const parsed = parseSnippetCompareQueryFile(
      JSON.stringify([{ id: "a", text: "náhrada škody", country: "cze" }]),
    );

    expect(Result.isOk(parsed) && parsed.value).toEqual([
      { id: "a", text: "náhrada škody", country: "cze" },
    ]);
  });

  test.each([
    ["not json", "{"],
    ["an empty set", "[]"],
    [
      "duplicate ids",
      JSON.stringify([
        { id: "a", text: "x", country: "cze" },
        { id: "a", text: "y", country: "cze" },
      ]),
    ],
    ["a missing country", JSON.stringify([{ id: "a", text: "x" }])],
    [
      "a country that is not a code",
      JSON.stringify([{ id: "a", text: "x", country: "Czech Republic" }]),
    ],
    [
      "an unknown field",
      JSON.stringify([
        { id: "a", text: "x", country: "cze", jurisdiction: "cze" },
      ]),
    ],
  ])("rejects %s", (_case, content) => {
    const parsed = parseSnippetCompareQueryFile(content);
    expect(Result.isError(parsed)).toBe(true);
    expect(Result.isError(parsed) && parsed.error).toBeInstanceOf(
      SnippetCompareFileError,
    );
  });

  test("the committed sample covers the query shapes the run is for", async () => {
    const parsed = parseSnippetCompareQueryFile(
      await Bun.file(
        `${import.meta.dir}/corpus-snippet-compare.sample.json`,
      ).text(),
    );
    if (!Result.isOk(parsed)) {
      throw new Error(
        `sample query file does not parse: ${parsed.error.message}`,
      );
    }
    const queries = parsed.value;

    expect(new Set(queries.map(({ country }) => country)).size).toBeGreaterThan(
      1,
    );
    // A phrase, so the comparison covers a fragment that has to hold adjacent
    // words; a single term, where a window has only one thing to centre on.
    expect(
      queries.some(({ text }) =>
        tokenizeCorpusFreeText(text).some(({ type }) => type === "phrase"),
      ),
    ).toBe(true);
    expect(
      queries.some(({ text }) => tokenizeCorpusFreeText(text).length === 1),
    ).toBe(true);
    // Diacritics on one side only: the fold is what has to reach the corpus.
    expect(queries.some(({ text }) => /[ěščřžýáíéůńśźżôäü]/u.test(text))).toBe(
      true,
    );
    expect(queries.some(({ text }) => /^[\w\s"]+$/u.test(text))).toBe(true);
  });
});

describe("compareSnippetFragments", () => {
  test("scores an identical fragment as agreement", () => {
    const snippet = "náhrada <mark>škody</mark> z prodlení";

    expect(
      compareSnippetFragments({
        snippetFragment: snippet,
        passageFragment: snippet,
      }),
    ).toEqual({
      overlap: 1,
      snippetMarks: ["skody"],
      passageMarks: ["skody"],
      marks: "identical",
    });
  });

  test("reports the passage side marking more than the snippet", () => {
    const comparison = compareSnippetFragments({
      snippetFragment: "náhrada <mark>škody</mark> z prodlení",
      passageFragment: "náhrada <mark>škody</mark> z <mark>prodlení</mark>",
    });

    expect(comparison.overlap).toBe(1);
    expect(comparison.marks).toBe("passage_superset");
    expect(comparison.passageMarks).toEqual(["prodleni", "skody"]);
  });

  test("reports marks neither side covers", () => {
    expect(
      compareSnippetFragments({
        snippetFragment: "<mark>škody</mark> a prodlení",
        passageFragment: "škody a <mark>prodlení</mark>",
      }).marks,
    ).toBe("divergent");
  });

  test("scores fragments cut from different places of the passage", () => {
    const comparison = compareSnippetFragments({
      snippetFragment: "alpha beta gamma delta",
      passageFragment: "gamma delta epsilon zeta",
    });

    // Two words shared of six distinct.
    expect(comparison.overlap).toBeCloseTo(2 / 6, 10);
  });

  test("scores disjoint fragments as no overlap", () => {
    expect(
      compareSnippetFragments({
        snippetFragment: "alpha beta",
        passageFragment: "gamma delta",
      }).overlap,
    ).toBe(0);
  });

  test("compares the escaped text, not the entities", () => {
    expect(
      compareSnippetFragments({
        snippetFragment: "smlouva &amp; podmínky",
        passageFragment: "smlouva &amp; podmínky",
      }).overlap,
    ).toBe(1);
  });
});

test("passageSkipReason names every miss the reader can report", () => {
  expect(passageSkipReason("unanchored")).toBe("unanchored");
  expect(passageSkipReason("no_payload")).toBe("no_payload");
  expect(passageSkipReason("anchor_not_found")).toBe("anchor_not_found");
});

const row = (): SnippetCompareQueryRow => ({
  query: { id: "cze-a", text: "náhrada škody", country: "cze" },
  searchMs: 40,
  passageReadMs: 10,
  hits: [
    {
      decisionId: "d1",
      anchorId: "p1",
      outcome: {
        status: "compared",
        snippetFragment: "náhrada <mark>škody</mark> z prodlení",
        passageFragment: "náhrada <mark>škody</mark> z prodlení",
        comparison: compareSnippetFragments({
          snippetFragment: "náhrada <mark>škody</mark> z prodlení",
          passageFragment: "náhrada <mark>škody</mark> z prodlení",
        }),
        highlightMs: 2,
      },
    },
    {
      decisionId: "d2",
      anchorId: "p2",
      outcome: {
        status: "compared",
        snippetFragment: "<mark>škody</mark> alpha beta",
        passageFragment: "gamma delta epsilon",
        comparison: compareSnippetFragments({
          snippetFragment: "<mark>škody</mark> alpha beta",
          passageFragment: "gamma delta epsilon",
        }),
        highlightMs: 4,
      },
    },
    {
      decisionId: "d3",
      anchorId: null,
      outcome: { status: "skipped", reason: "unanchored" },
    },
  ],
});

describe("summarizeSnippetComparison", () => {
  test("counts hits, agreement and timings", () => {
    const summary = summarizeSnippetComparison([row()]);

    expect(summary.queries).toBe(1);
    expect(summary.hits).toBe(3);
    expect(summary.compared).toBe(2);
    expect(summary.skipped.unanchored).toBe(1);
    expect(summary.skipped.no_snippet).toBe(0);
    expect(summary.marks.identical).toBe(1);
    // The second hit's passage fragment marks nothing the snippet marked.
    expect(summary.marks.snippet_superset).toBe(1);
    expect(summary.overlapAtLeastHalfShare).toBe(0.5);
    expect(summary.passageMarksCoverSnippetShare).toBe(0.5);
    expect(summary.timings.highlightMsTotal).toBe(6);
    expect(summary.timings.highlightMsMedian).toBe(3);
    expect(summary.timings.searchMsTotal).toBe(40);
    expect(summary.timings.passageReadMsMedian).toBe(10);
  });

  test("an empty run reports zeroes rather than NaN", () => {
    const summary = summarizeSnippetComparison([]);

    expect(summary.overlapAtLeastHalfShare).toBe(0);
    expect(summary.medianOverlap).toBe(0);
    expect(summary.timings.searchMsMedian).toBe(0);
  });
});

describe("renderSnippetCompareMarkdown", () => {
  test("renders the summary, both fragments and the skips", () => {
    const markdown = renderSnippetCompareMarkdown(
      snippetCompareReport([row()]),
    );

    expect(markdown).toContain("- queries: 1");
    expect(markdown).toContain("- overlap >= 0.5: 50.0%");
    expect(markdown).toContain("## cze-a — cze: náhrada škody");
    expect(markdown).toContain("| 1 | snippet |");
    expect(markdown).toContain("| 1 | passage |");
    expect(markdown).toContain("not compared: unanchored");
  });

  test("keeps a fragment inside its table cell", () => {
    const withPipes = row();
    const [first] = withPipes.hits;
    if (first?.outcome.status !== "compared") {
      throw new Error("fixture must hold a compared hit");
    }
    first.outcome.snippetFragment = "alpha | beta\ngamma";

    const markdown = renderSnippetCompareMarkdown(
      snippetCompareReport([withPipes]),
    );

    expect(markdown).toContain("alpha \\| beta gamma");
    expect(markdown.split("\n").some((line) => line === "")).toBe(true);
  });
});
