import { describe, expect, test } from "bun:test";

import type { Block } from "@stll/legal-ast/document-ast";

import type { DecisionJudge } from "@/features/case-law/decision-judges";
import { withSeparateOpinion } from "@/features/case-law/decision-outline.logic";
import type { DecisionOutline } from "@/features/case-law/decision-outline.logic";

const paragraph = (anchorId: string, role?: "dissent"): Block => ({
  anchorId,
  id: anchorId,
  inlines: [],
  plainText: anchorId,
  role,
  type: "paragraph",
});

const heading = (anchorId: string): Block => ({
  anchorId,
  id: anchorId,
  inlines: [],
  level: 2,
  plainText: anchorId,
  role: "section-heading",
  type: "heading",
});

const judge = (overrides: Partial<DecisionJudge>): DecisionJudge => ({
  judgeId: null,
  name: "Nováková Jana",
  portrait: null,
  role: "dissenting",
  ...overrides,
});

const NO_ANALYSIS: DecisionOutline = { anchorById: new Map(), items: [] };

const place = (
  blocks: readonly Block[],
  judges: readonly DecisionJudge[],
  outline: DecisionOutline = NO_ANALYSIS,
) =>
  withSeparateOpinion({
    blocks,
    formatPortraitCredit: (source) => `Source: ${source}`,
    judges,
    opinionLabel: "Dissenting opinion",
    outline,
    portraitSrc: (path) => `https://api.test${path}`,
  });

const DISSENT = [
  paragraph("reasoning"),
  heading("opinion-title"),
  paragraph("opinion-text", "dissent"),
];

describe("the separate opinion on the reader's rail", () => {
  test("adds a rail to a decision that has no analysis", () => {
    const { anchorById, items } = place(DISSENT, [judge({})]);

    expect(items.map((item) => item.label)).toEqual(["Nováková Jana"]);
    expect(anchorById.get(items[0]?.id ?? "")).toBe("opinion-title");
  });

  test("lands on the paragraph when no heading opens the opinion", () => {
    const blocks = [
      paragraph("reasoning"),
      paragraph("opinion-text", "dissent"),
    ];
    const { anchorById, items } = place(blocks, [judge({})]);

    expect(anchorById.get(items[0]?.id ?? "")).toBe("opinion-text");
  });

  test("draws the court's face, and initials where the roster has none", () => {
    const { items } = place(DISSENT, [
      judge({
        name: "Svatoň Jan",
        portrait: { attribution: "Court", url: "/v1/judges/1/portrait" },
      }),
      judge({ name: "Dvořák Petr" }),
    ]);

    expect(items[0]?.portraits).toEqual([
      { image: "https://api.test/v1/judges/1/portrait", name: "Svatoň Jan" },
      { image: null, name: "Dvořák Petr" },
    ]);
    expect(items[0]?.label).toBe("Svatoň Jan, Dvořák Petr");
  });

  test("credits each portrait source once, and none without a portrait", () => {
    const portrait = { attribution: "Court", url: "/v1/judges/1/portrait" };
    const withPhotos = place(DISSENT, [
      judge({ name: "Svatoň Jan", portrait }),
      judge({ name: "Dvořák Petr", portrait }),
    ]);
    const withoutPhotos = place(DISSENT, [judge({})]);

    expect(withPhotos.items[0]?.portraitCredit).toBe("Source: Court");
    expect(withoutPhotos.items[0]).not.toHaveProperty("portraitCredit");
  });

  test("names a judge once however many rows the read has for them", () => {
    const { items } = place(DISSENT, [judge({}), judge({})]);

    expect(items[0]?.portraits).toHaveLength(1);
  });

  test("keeps reading order among the analysis entries", () => {
    const outline: DecisionOutline = {
      anchorById: new Map([
        ["before", "reasoning"],
        ["after", "closing"],
      ]),
      items: [
        { id: "before", label: "Before", level: 0 },
        { id: "after", label: "After", level: 0 },
      ],
    };
    const { items } = place(
      [...DISSENT, paragraph("closing")],
      [judge({})],
      outline,
    );

    expect(items.map((item) => item.label)).toEqual([
      "Before",
      "Nováková Jana",
      "After",
    ]);
  });

  test("leaves the rail as it was without both the person and the place", () => {
    const onBench = [judge({ role: "rapporteur" })];

    expect(place(DISSENT, onBench)).toBe(NO_ANALYSIS);
    expect(place([paragraph("reasoning")], [judge({})])).toBe(NO_ANALYSIS);
  });
});
