import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { decisionBySlugOptions } from "@/features/case-law/queries/decisions";
import { loadPublicCaseLawDecisionRoute } from "@/routes/law/-case-detail.logic";

const ABSENT_TEXT_FIELD = {
  reason: "not_published",
  type: "absent",
} as const;

const UNPUBLISHED_DECISION = {
  caseNumber: "SYN 1/2026",
  country: "XAA",
  court: "Synthetic court",
  decisionDate: null,
  decisionType: null,
  documentAst: null,
  ecli: null,
  fulltext: null,
  id: "synthetic-decision",
  language: "en",
  languageAlternates: [],
  metadata: {},
  slug: "synthetic-decision",
  source: null,
  sourceUrl: null,
  textFields: {
    abstract: ABSENT_TEXT_FIELD,
    headnote: ABSENT_TEXT_FIELD,
    legalSentence: ABSENT_TEXT_FIELD,
    summary: ABSENT_TEXT_FIELD,
  },
  updatedAt: null,
} satisfies PublicCaseLawDecision;

describe("public case-law decision route readiness", () => {
  test("rejects a route outside the generated country list", () => {
    expect(
      loadPublicCaseLawDecisionRoute({
        params: {
          country: "xaa",
          court: "synthetic-court",
          slug: "synthetic-decision",
        },
        queryClient: new QueryClient(),
        search: {},
      }),
    ).rejects.toMatchObject({ isNotFound: true });
  });

  test("rejects a fetched decision outside the generated country list", () => {
    const queryClient = new QueryClient();
    const options = decisionBySlugOptions({ slug: "synthetic-decision" });
    queryClient.setQueryData(options.queryKey, UNPUBLISHED_DECISION);

    expect(
      loadPublicCaseLawDecisionRoute({
        params: {
          country: "cze",
          court: "synthetic-court",
          slug: "synthetic-decision",
        },
        queryClient,
        search: {},
      }),
    ).rejects.toMatchObject({ isNotFound: true });
  });
});
