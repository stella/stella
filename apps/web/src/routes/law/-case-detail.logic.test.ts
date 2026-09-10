import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { decisionBySlugOptions } from "@/features/case-law/queries/decisions";
import { toSafeId } from "@/lib/safe-id";
import { loadPublicCaseLawDecisionRoute } from "@/routes/law/-case-detail.logic";

const ABSENT_TEXT_FIELD = {
  reason: "not_published",
  type: "absent",
} as const;

const PUBLIC_COUNTRY =
  publicCaseLawCountry("CZE") ?? panic("Expected a public test country.");

type DecisionBySlug = Awaited<
  ReturnType<NonNullable<ReturnType<typeof decisionBySlugOptions>["queryFn"]>>
>;

const UNPUBLISHED_DECISION = {
  caseNumber: "SYN 1/2026",
  citationsFrom: [],
  citationsNextCursor: null,
  citationsTo: [],
  country: "XAA",
  court: "Synthetic court",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  decisionDate: null,
  decisionType: null,
  documentAst: null,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  documentUrl: null,
  ecli: null,
  fulltext: null,
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000001"),
  identifiers: [
    {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "SYN 1/2026",
    },
  ],
  language: "en",
  languageAlternates: [],
  languageGroupKey: null,
  metadata: {},
  sections: null,
  slug: "synthetic-decision",
  source: {
    adapterKey: "synthetic",
    allowsDerivedAi: false,
    id: toSafeId<"caseLawSource">("00000000-0000-4000-8000-000000000002"),
    name: "Synthetic source",
  },
  sourceUrl: null,
  textFields: {
    abstract: ABSENT_TEXT_FIELD,
    headnote: ABSENT_TEXT_FIELD,
    legalSentence: ABSENT_TEXT_FIELD,
    summary: ABSENT_TEXT_FIELD,
  },
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DecisionBySlug;

describe("public case-law decision route readiness", () => {
  test("rejects a route outside the generated country list", async () => {
    await expect(
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

  test("rejects a fetched decision outside the generated country list", async () => {
    const queryClient = new QueryClient();
    const options = decisionBySlugOptions({
      country: PUBLIC_COUNTRY,
      slug: "synthetic-decision",
    });
    queryClient.setQueryData(options.queryKey, UNPUBLISHED_DECISION);

    await expect(
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
