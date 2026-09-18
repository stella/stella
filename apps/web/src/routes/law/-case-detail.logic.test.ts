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
  courtAbbreviation: null,
  courtTier: "other",
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
  headnote: ABSENT_TEXT_FIELD,
  id: toSafeId<"caseLawDecision">("00000000-0000-4000-8000-000000000001"),
  identifiers: [
    {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "SYN 1/2026",
    },
  ],
  judges: [],
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
  sourceAttributionUrl: null,
  sourceUrl: null,
  textFields: {
    abstract: ABSENT_TEXT_FIELD,
    headnote: ABSENT_TEXT_FIELD,
    legalSentence: ABSENT_TEXT_FIELD,
    summary: ABSENT_TEXT_FIELD,
  },
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
} satisfies DecisionBySlug;

const PUBLISHED_DECISION = {
  ...UNPUBLISHED_DECISION,
  country: PUBLIC_COUNTRY,
} satisfies DecisionBySlug;

describe("public case-law decision route readiness", () => {
  test("rejects a route outside the generated country list", () => {
    expect(
      loadPublicCaseLawDecisionRoute({
        hash: "",
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
    const options = decisionBySlugOptions({
      country: PUBLIC_COUNTRY,
      slug: "synthetic-decision",
    });
    queryClient.setQueryData(options.queryKey, UNPUBLISHED_DECISION);

    expect(
      loadPublicCaseLawDecisionRoute({
        hash: "",
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

describe("canonical decision redirect", () => {
  const seedStaleSlug = () => {
    const queryClient = new QueryClient();
    const options = decisionBySlugOptions({
      country: PUBLIC_COUNTRY,
      slug: "stale-slug",
    });
    queryClient.setQueryData(options.queryKey, PUBLISHED_DECISION);
    return queryClient;
  };

  test("carries the passage the reader came for to the canonical path", async () => {
    // A citation chip opens the decision at a block. Canonicalising the path
    // must not drop the fragment, or the reader lands at the top of the
    // decision instead of on the passage the answer cited.
    const redirected = await loadPublicCaseLawDecisionRoute({
      hash: "p-12",
      params: {
        country: "cze",
        court: "synthetic-court",
        slug: "stale-slug",
      },
      queryClient: seedStaleSlug(),
      search: {},
    }).then(
      () => panic("Expected the stale slug to redirect."),
      (error: unknown) => error,
    );

    expect(redirected).toMatchObject({
      options: { params: { slug: "synthetic-decision" } },
    });
    // The same path the no-fragment case asserts the absence of, so that
    // assertion cannot pass by naming a property neither case carries.
    expect(redirected).toHaveProperty("options.hash", "p-12");
  });

  test("a decision opened at no passage keeps a bare canonical URL", async () => {
    const redirected = await loadPublicCaseLawDecisionRoute({
      hash: "",
      params: {
        country: "cze",
        court: "synthetic-court",
        slug: "stale-slug",
      },
      queryClient: seedStaleSlug(),
      search: {},
    }).then(
      () => panic("Expected the stale slug to redirect."),
      (error: unknown) => error,
    );

    expect(redirected).toMatchObject({
      options: { params: { slug: "synthetic-decision" } },
    });
    expect(redirected).not.toHaveProperty("options.hash");
  });
});
