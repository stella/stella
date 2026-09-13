import { describe, expect, test } from "bun:test";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { preferredDecisionTarget } from "@/features/case-law/decision-cell-target.logic";
import { decisionTabTarget } from "@/features/case-law/decision-inspector.logic";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";

const monolingual: Decision = {
  id: "decision-cs",
  caseNumber: "III. ÚS 649/05",
  slug: "iii-us-649-05",
  ecli: null,
  court: "Ústavní soud",
  country: "CZE",
  language: "cs",
  languageAlternates: [],
  decisionDate: "2006-03-09",
  decisionType: "nález",
  headnote: { type: "absent", reason: "not_published" },
  citationCount: 0,
};

const multilingual: Decision = {
  ...monolingual,
  id: "decision-fr",
  language: "fr",
  anchorId: "p-16",
  languageAlternates: [
    {
      caseNumber: "C-123/20",
      country: "EUR",
      court: "Court of Justice",
      decisionDate: "2021-04-15",
      id: "decision-fr",
      language: "fr",
      slug: "c-123-20-fr",
    },
    {
      caseNumber: "C-123/20",
      country: "EUR",
      court: "Court of Justice",
      decisionDate: "2021-04-15",
      id: "decision-en",
      language: "en",
      slug: "c-123-20-en",
    },
  ],
};

describe("the version a case-number link names", () => {
  test("a decision with no other version is its own target", () => {
    expect(preferredDecisionTarget(monolingual, "en")).toEqual({
      caseNumber: "III. ÚS 649/05",
      country: "CZE",
      court: "Ústavní soud",
      decisionId: "decision-cs",
      language: "cs",
      languageAlternates: [],
      slug: "iii-us-649-05",
    });
  });

  test("the reader's language wins over the version that matched", () => {
    const target = preferredDecisionTarget(multilingual, "en");

    expect(target.decisionId).toBe("decision-en");
    expect(target.slug).toBe("c-123-20-en");
  });

  // The alternates travel with the target: the route addresses a version in
  // its path only for a decision that has several, so dropping them would
  // send the link to a path the chosen version does not live at.
  test("the link the target builds addresses the chosen version", () => {
    const params = createCaseLawDecisionRouteParams(
      preferredDecisionTarget(multilingual, "en"),
    );

    expect(params.language).toBe("en");
    expect(params.slug).toBe("c-123-20-en");
  });
});

describe("the version a matched-passage link names", () => {
  // A block anchor is version-local: it identifies a paragraph of the text
  // that matched and means nothing in a translation, so the passage link
  // stays on that version however the reader's language would choose.
  test("the passage stays on the version that produced it", () => {
    const target = decisionTabTarget(multilingual, "p-16");

    expect(target.decisionId).toBe("decision-fr");
    expect(target.anchorId).toBe("p-16");
    expect(createCaseLawDecisionRouteParams(target).language).toBe("fr");
  });
});
