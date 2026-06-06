import { describe, expect, test } from "bun:test";

import type { AnalysisHeading } from "@stll/legal-ast/analysis";

import {
  buildCategoryCatalogPrompt,
  normalizeAnalysisHeadingLabels,
} from "@/api/handlers/case-law/analysis/category-catalog";

const heading = ({
  category,
  label,
}: {
  category: string;
  label: string;
}): AnalysisHeading => ({
  id: "heading-1",
  label,
  category,
  startAnchorId: "p-1",
  endAnchorId: "p-1",
  annotations: [],
  children: [],
});

describe("case-law analysis category catalog", () => {
  test("normalizes English core labels to the decision language", () => {
    const normalized = normalizeAnalysisHeadingLabels({
      heading: heading({ category: "holding", label: "holding" }),
      language: "cs",
    });

    expect(normalized.label).toBe("Výrok");
    expect(normalized.category).toBe("holding");
  });

  test("preserves localized specific labels", () => {
    const normalized = normalizeAnalysisHeadingLabels({
      heading: heading({ category: "reasoning", label: "Náklady řízení" }),
      language: "cs",
    });

    expect(normalized.label).toBe("Náklady řízení");
  });

  test("renders a language-aware category prompt", () => {
    const prompt = buildCategoryCatalogPrompt("cs");

    expect(prompt).toContain("| facts | Skutkový stav |");
    expect(prompt).toContain("| holding | Výrok |");
  });
});
