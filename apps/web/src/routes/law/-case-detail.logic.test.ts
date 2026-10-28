import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { DECISION_READ_RESOLUTION } from "@stll/api-contract/case-law-decision-resolution";
import {
  CASE_LAW_BROWSER_COUNTRIES,
  publicCaseLawCountry,
} from "@stll/api-contract/case-law-launch-readiness";
import { noDecisionReviewFound } from "@stll/api-contract/case-law-reviews";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { rejectionOf } from "@stll/property-testing/rejection";

import {
  decisionBySlugOptions,
  decisionOptions,
} from "@/features/case-law/queries/decisions";
import { createPublicLawHead } from "@/lib/public-law-seo";
import { toSafeId } from "@/lib/safe-id";
import {
  createPublicCaseLawDecisionHead,
  loadPublicCaseLawDecisionRoute,
} from "@/routes/law/-case-detail.logic";

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
  appealReviews: noDecisionReviewFound(),
  citationCount: 0,
  caseNumber: "SYN 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  citationsFrom: [],
  citationsNextCursor: null,
  citationsTo: [],
  country: "XAA",
  court: "Synthetic court",
  courtId: null,
  courtAbbreviation: null,
  courtTier: "other",
  createdAt: "2026-01-01T00:00:00.000Z",
  decisionDate: null,
  decisionType: null,
  documentAst: null,
  documentAstSource: null,
  projectionDigest: null,
  hasDocument: false,
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
  caseFile: { items: [], nextCursor: null, limit: 50 },
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
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies DecisionBySlug;

const PUBLISHED_DECISION = {
  ...UNPUBLISHED_DECISION,
  country: PUBLIC_COUNTRY,
} satisfies DecisionBySlug;

test("textless decision heads stay noindex until the text arrives", async () => {
  for (const country of CASE_LAW_BROWSER_COUNTRIES) {
    const params = {
      country: country.toLowerCase(),
      court: "synthetic-court",
      slug: "synthetic-decision",
    };
    const decision = { ...PUBLISHED_DECISION, country };
    const emptyHead = await createPublicCaseLawDecisionHead({
      decision,
      params,
    });
    expect(emptyHead.meta.at(1)).toEqual(
      createPublicLawHead({
        indexing: "noindex",
        path: "/law/cases",
        title: "Test",
        type: "article",
      }).meta.at(1),
    );
    expect(emptyHead.links).toEqual([]);
    const textHead = await createPublicCaseLawDecisionHead({
      decision: {
        ...decision,
        fulltext: "Published judgment",
        hasDocument: true,
      },
      params,
    });
    const existingHead = createPublicLawHead({
      path: "/law/cases",
      title: "Test",
      type: "article",
    });
    expect(textHead.meta.at(1)).toEqual(existingHead.meta.at(1));
    for (const flags of [
      { hasDocument: true, documentPending: false, documentReadFailed: true },
      { hasDocument: false, documentPending: true, documentReadFailed: false },
      { hasDocument: false, documentPending: false, documentReadFailed: true },
    ]) {
      const transientHead = await createPublicCaseLawDecisionHead({
        decision: { ...decision, ...flags },
        params,
      });
      expect(transientHead.meta.at(1)).toEqual(existingHead.meta.at(1));
      expect(transientHead.links).toEqual(textHead.links);
    }
  }
});

test("a readable decision omits textless language variants from alternate links", async () => {
  const variant = {
    caseNumber: "1",
    country: "CZE",
    court: "Synthetic court",
    decisionDate: null,
    id: PUBLISHED_DECISION.id,
    slug: "synthetic-decision",
  };
  const decision = {
    ...PUBLISHED_DECISION,
    hasDocument: true,
    languageAlternates: [
      { ...variant, language: "cs", hasDocument: true },
      { ...variant, language: "en", hasDocument: true },
      { ...variant, language: "de", hasDocument: false },
    ],
  };
  const head = await createPublicCaseLawDecisionHead({
    decision,
    params: {
      country: "cze",
      court: "synthetic-court",
      slug: "synthetic-decision",
    },
  });
  expect(
    head.links.flatMap((link) => ("hrefLang" in link ? [link.hrefLang] : [])),
  ).toEqual(["cs", "en", "x-default"]);
});

describe("public case-law decision route readiness", () => {
  test("rejects a route outside the generated country list", async () => {
    expect(
      await rejectionOf(
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
      ),
    ).toMatchObject({ isNotFound: true });
  });

  test("rejects a fetched decision outside the generated country list", async () => {
    const queryClient = new QueryClient();
    const options = decisionBySlugOptions({
      country: PUBLIC_COUNTRY,
      slug: "synthetic-decision",
    });
    queryClient.setQueryData(options.queryKey, UNPUBLISHED_DECISION);

    expect(
      await rejectionOf(
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
      ),
    ).toMatchObject({ isNotFound: true });
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

  test.each(["p-12", "par=48", "par=48-53", "par=garbage"])(
    "carries fragment %s to the canonical path",
    async (hash) => {
      // A citation chip opens the decision at a block. Canonicalising the path
      // must not drop the fragment, or the reader lands at the top of the
      // decision instead of on the passage the answer cited.
      const redirected = await loadPublicCaseLawDecisionRoute({
        hash,
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
      expect(redirected).toHaveProperty("options.hash", hash);
    },
  );

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

describe("pre-transliteration path redirect", () => {
  const POLISH_COUNTRY =
    publicCaseLawCountry("POL") ?? panic("Expected Poland to be public.");
  const DECISION_ID = toSafeId<"caseLawDecision">(
    "019dd47d-f507-7c84-b827-980af11b8980",
  );
  const COMPACT_DECISION_ID = "AZ3UffUHfIS4J5gK8RuJgA";
  const LODZ_DECISION = {
    ...PUBLISHED_DECISION,
    caseNumber: "III SA/Łd 223/21",
    country: POLISH_COUNTRY,
    court: "Wojewódzki Sąd Administracyjny w Łodzi",
    id: DECISION_ID,
    // Minted under the old fold and stored, so it stays the canonical slug.
    slug: "iii-sa-d-223-21",
  } satisfies DecisionBySlug;
  const NEW_COURT = "wojewodzki-sad-administracyjny-w-lodzi";
  const OLD_COURT = "wojewodzki-sad-administracyjny-w-odzi";

  const bySlugClient = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      decisionBySlugOptions({
        country: POLISH_COUNTRY,
        slug: LODZ_DECISION.slug,
      }).queryKey,
      LODZ_DECISION,
    );
    return queryClient;
  };

  const byIdClient = () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(decisionOptions(DECISION_ID).queryKey, {
      ...LODZ_DECISION,
      slug: null,
    });
    return queryClient;
  };

  const redirectOf = async (
    params: { country: string; court: string; slug: string },
    queryClient: QueryClient,
  ): Promise<unknown> =>
    await loadPublicCaseLawDecisionRoute({
      hash: "",
      params,
      queryClient,
      search: {},
    }).then(
      () => panic("Expected the path to redirect."),
      (error: unknown) => error,
    );

  test("moves the old court segment permanently to the new one", async () => {
    const redirected = await redirectOf(
      { country: "pol", court: OLD_COURT, slug: LODZ_DECISION.slug },
      bySlugClient(),
    );
    expect(redirected).toMatchObject({
      options: {
        to: "/law/$country/cases/$court/$slug",
        params: { country: "pol", court: NEW_COURT, slug: LODZ_DECISION.slug },
        statusCode: 308,
      },
    });
    // Built from route params alone, so the target stays on this origin.
    expect(redirected).not.toHaveProperty("options.href");
  });

  test("moves the old id-form prefix permanently to the new one", async () => {
    const redirected = await redirectOf(
      {
        country: "pol",
        court: OLD_COURT,
        slug: `iii-sa-d-223-21--${COMPACT_DECISION_ID}`,
      },
      byIdClient(),
    );
    expect(redirected).toMatchObject({
      options: {
        params: {
          court: NEW_COURT,
          slug: `iii-sa-ld-223-21--${COMPACT_DECISION_ID}`,
        },
        statusCode: 308,
      },
    });
  });

  test("keeps a temporary redirect for a path the old fold never published", async () => {
    const redirected = await redirectOf(
      { country: "pol", court: "some-other-court", slug: LODZ_DECISION.slug },
      bySlugClient(),
    );
    expect(redirected).toMatchObject({
      options: { params: { court: NEW_COURT }, statusCode: 307 },
    });
  });

  test("serves the new path without a redirect", async () => {
    const decision = await loadPublicCaseLawDecisionRoute({
      hash: "",
      params: { country: "pol", court: NEW_COURT, slug: LODZ_DECISION.slug },
      queryClient: bySlugClient(),
      search: {},
    });
    expect(decision.id).toBe(DECISION_ID);
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

  test.each(["par=48", "par=48-53", "par=garbage"])(
    "preserves court range %s when reasons resolve to a judgment",
    async (hash) => {
      expect(await redirectFromReasons(hash)).toHaveProperty(
        "options.hash",
        hash,
      );
    },
  );

  test("maps a passage of the reasons onto the same block in the judgment", async () => {
    const redirected = await redirectFromReasons("p-4");

    expect(redirected).toHaveProperty("options.hash", `${ANCHOR_PREFIX}p-4`);
  });
});
