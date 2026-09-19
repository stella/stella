import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type {
  ConversionRow,
  ConversionSummary,
} from "@/api/lib/house-style/convert";
import {
  parseConvertArgs,
  parseRenameRules,
  renderConversionReport,
} from "@/api/scripts/house-style-convert.logic";

const parsed = (argv: string[]) => {
  const result = parseConvertArgs(argv);
  if (Result.isError(result)) {
    throw new TypeError(result.error.message);
  }
  return result.value;
};

const refused = (argv: string[]): string => {
  const result = parseConvertArgs(argv);
  if (Result.isOk(result)) {
    throw new Error("the arguments were accepted");
  }
  return result.error.message;
};

describe("the conversion script's arguments", () => {
  test("write a catalogue and stop there", () => {
    expect(
      parsed(["--house", "house.docx", "--write-catalogue", "out.json"]),
    ).toEqual({
      type: "catalogue",
      house: "house.docx",
      cataloguePath: "out.json",
      rename: [],
    });
  });

  test("convert with a guide and an output", () => {
    expect(
      parsed([
        "--house",
        "house.docx",
        "--input",
        "draft.docx",
        "--guide",
        "guide.json",
        "--out",
        "converted.docx",
        "--report",
        "report.json",
        "--limit",
        "25",
      ]),
    ).toMatchObject({
      type: "convert",
      out: "converted.docx",
      report: "report.json",
      limit: 25,
    });
  });

  test("take a rename more than once, in the order given", () => {
    expect(
      parsed([
        "--house",
        "house.docx",
        "--write-catalogue",
        "out.json",
        "--rename",
        "Old=New",
        "--rename",
        "Firm=House",
      ]),
    ).toMatchObject({
      rename: [
        { from: "Old", to: "New" },
        { from: "Firm", to: "House" },
      ],
    });
  });

  test("write nothing under a dry run", () => {
    expect(
      parsed([
        "--house",
        "house.docx",
        "--input",
        "draft.docx",
        "--guide",
        "guide.json",
        "--dry-run",
      ]),
    ).toMatchObject({ type: "convert", out: null });
  });

  test("refuse a conversion with no guide", () => {
    expect(
      refused([
        "--house",
        "house.docx",
        "--input",
        "draft.docx",
        "--out",
        "out.docx",
      ]),
    ).toContain("--input and --guide are required");
  });

  test("refuse a conversion that would write nowhere", () => {
    expect(
      refused([
        "--house",
        "house.docx",
        "--input",
        "draft.docx",
        "--guide",
        "guide.json",
      ]),
    ).toContain("--out is required");
  });

  test("refuse an unknown flag rather than ignoring it", () => {
    expect(
      refused(["--house", "house.docx", "--wrte-catalogue", "out.json"]),
    ).toContain("unknown option");
  });

  test("refuse a repeated single-valued flag", () => {
    expect(
      refused([
        "--house",
        "house.docx",
        "--house",
        "other.docx",
        "--write-catalogue",
        "out.json",
      ]),
    ).toContain("more than once");
  });

  test("refuse a limit that is not a positive whole number", () => {
    expect(
      refused([
        "--house",
        "house.docx",
        "--input",
        "draft.docx",
        "--guide",
        "guide.json",
        "--out",
        "out.docx",
        "--limit",
        "0",
      ]),
    ).toContain("--limit must be a positive integer");
  });

  test("ask for a house style before anything else", () => {
    expect(refused(["--input", "draft.docx"])).toContain("--house");
  });
});

describe("a rename rule", () => {
  test("splits on the first equals, so a value may carry one", () => {
    expect(parseRenameRules(["A=B=C"])).toEqual(
      Result.ok([{ from: "A", to: "B=C" }]),
    );
  });

  test.each([["Firm"], ["=House"], ["Firm="]])("refuses %p", (entry) => {
    const rules = parseRenameRules([entry]);
    expect(Result.isError(rules)).toBe(true);
  });
});

const ROWS: ConversionRow[] = [
  {
    index: 0,
    snippet: "SHORT-FORM LOAN AGREEMENT",
    originalStyleId: "Normal",
    originalStyleName: "Normal",
    styleId: "CentredHouse",
    probability: 0.92,
    tier: "decision-model",
  },
  {
    index: 1,
    snippet: "Business Day means a day banks are open.",
    originalStyleId: "Normal",
    originalStyleName: "Normal",
    styleId: "DefinitionHouse",
    probability: null,
    tier: "rule",
  },
];

const SUMMARY: ConversionSummary = {
  paragraphs: 2,
  byTier: { "decision-model": 1, rule: 1 },
  byStyle: [
    { styleId: "CentredHouse", name: "Centred House", count: 1 },
    { styleId: "DefinitionHouse", name: "Definition House", count: 1 },
  ],
  droppedEmptyParagraphs: 3,
  strippedManualMarkers: 4,
  requests: 1,
  inputTokens: 1200,
  usd: 0.0000504,
  latencyP50Ms: 210,
  latencyP95Ms: 480,
  model: "jev-1.13.0",
};

describe("the printed report", () => {
  const report = renderConversionReport({ rows: ROWS, summary: SUMMARY });

  test("shows what each paragraph was and what it became", () => {
    expect(report).toContain("SHORT-FORM LOAN AGREEMENT");
    expect(report).toContain("CentredHouse");
    expect(report).toContain("0.92");
  });

  test("names the tier that decided each paragraph", () => {
    expect(report).toContain("decision-model");
    expect(report).toContain("rule");
  });

  test("carries the run's totals", () => {
    expect(report).toContain("paragraphs: 2");
    expect(report).toContain("input tokens: 1200");
    expect(report).toContain("jev-1.13.0");
    expect(report).toContain("210 ms");
  });

  test("says when nothing answered, rather than printing a blank model", () => {
    expect(
      renderConversionReport({
        rows: ROWS,
        summary: { ...SUMMARY, model: null, latencyP50Ms: null },
      }),
    ).toContain("every paragraph took the rule tier");
  });
});
