import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
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
  resolution: { type: DECISION_READ_RESOLUTION.DIRECT },
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

describe("absorbed supplement redirect", () => {
  const ANCHOR_PREFIX = "reasons-syn-2-";
  const JUDGMENT = {
    ...PUBLISHED_DECISION,
    documentAst: {
      version: 1,
      source: { system: "", documentId: "", webUrl: "", printUrl: "" },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [
        {
          id: "b1",
          anchorId: "p-1",
          type: "paragraph",
          inlines: [{ type: "text", text: "Ruling." }],
        },
        {
          id: `${ANCHOR_PREFIX}b1`,
          anchorId: `${ANCHOR_PREFIX}h-1`,
          type: "heading",
          level: 2,
          inlines: [{ type: "text", text: "Reasons" }],
        },
        {
          id: `${ANCHOR_PREFIX}b4`,
          anchorId: `${ANCHOR_PREFIX}p-4`,
          type: "paragraph",
          inlines: [{ type: "text", text: "Uzasadnienie." }],
        },
      ],
    },
    resolution: {
      type: DECISION_READ_RESOLUTION.ABSORBED_SUPPLEMENT,
      absorbedDecisionId: toSafeId<"caseLawDecision">(
        "00000000-0000-4000-8000-000000000003",
      ),
      anchorPrefix: ANCHOR_PREFIX,
    },
  } satisfies DecisionBySlug;

  // The reasons' own slug answers with the judgment they went into.
  const redirectFromReasons = async (hash: string): Promise<unknown> => {
    const queryClient = new QueryClient();
    const options = decisionBySlugOptions({
      country: PUBLIC_COUNTRY,
      slug: "synthetic-reasons",
    });
    queryClient.setQueryData(options.queryKey, JUDGMENT);
    return await loadPublicCaseLawDecisionRoute({
      hash,
      params: {
        country: "cze",
        court: "synthetic-court",
        slug: "synthetic-reasons",
      },
      queryClient,
      search: {},
    }).then(
      () => panic("Expected the absorbed reasons to redirect."),
      (error: unknown) => error,
    );
  };

  test("moves to the judgment, at the reasons' first block", async () => {
    const redirected = await redirectFromReasons("");

    expect(redirected).toMatchObject({
      options: { params: { slug: "synthetic-decision" }, replace: true },
    });
    expect(redirected).toHaveProperty("options.hash", `${ANCHOR_PREFIX}h-1`);
  });

  test("maps a passage of the reasons onto the same block in the judgment", async () => {
    const redirected = await redirectFromReasons("p-4");

    expect(redirected).toHaveProperty("options.hash", `${ANCHOR_PREFIX}p-4`);
  });
});
