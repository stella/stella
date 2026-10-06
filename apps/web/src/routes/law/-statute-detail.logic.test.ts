import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import type {
  LegislationWindowDisposition,
  LegislationWindowDispositionBasis,
} from "@stll/api-contract/legislation-expression";
import { createStatuteRouteParams } from "@stll/api-contract/statute-route";

import {
  publicStatuteOptions,
  statuteBySlugOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import type {
  PublicStatute,
  PublicStatuteVersion,
} from "@/features/statutes/queries/statutes";
import type { StatuteWindowGap } from "@/features/statutes/statute-expression";
import { publicStatuteSearchSchema } from "@/features/statutes/statute-page-search";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import {
  loadPublicStatuteRoute,
  statuteVersionRouteParams,
} from "@/routes/law/-statute-detail.logic";

const SLUG = "89-2012-sb-obcansky-zakonik";
const COUNTRY_SEGMENT = "cze";
const JUMP = "§ 2079";

const CURRENT_ID = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000001",
);
const OPEN_OLDER_ID = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000002",
);
const FUTURE_ID = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000003",
);

type StatuteSeed = {
  id: SafeId<"legislationDocument">;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  windowDisposition?: LegislationWindowDisposition;
  windowDispositionBasis?: LegislationWindowDispositionBasis;
};

const statute = ({
  id,
  versionValidFrom,
  versionValidTo,
  windowDisposition = "effective",
  windowDispositionBasis,
}: StatuteSeed): PublicStatute => ({
  expressionKind: "consolidation",
  windowDisposition,
  windowDispositionBasis: windowDispositionBasis ?? null,
  allowsDerivedAi: true,
  citationCaseCount: null,
  country: "CZE",
  createdAt: "2026-01-01T00:00:00.000Z",
  documentAst: null,
  documentType: "act",
  documentUrl: null,
  effectiveDate: versionValidFrom,
  eli: "/eli/cz/sb/2012/89",
  fulltext: null,
  id,
  language: "cs",
  sections: null,
  slug: SLUG,
  sourceUrl: null,
  status: "current",
  title: "89/2012 Sb., občanský zákoník",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versionValidFrom,
  versionValidTo,
});

const version = (
  seed: StatuteSeed,
  isDefault: boolean,
): PublicStatuteVersion => {
  const {
    citationCaseCount: _citationCaseCount,
    documentAst: _documentAst,
    fulltext: _fulltext,
    sections: _sections,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = statute(seed);

  return { ...rest, isDefault };
};

/**
 * The publisher left both consolidations open-ended, which the public-read
 * fixture models too: `versionValidTo` alone cannot say which text is the
 * latest, so only the version listing's order can.
 */
const CURRENT = {
  id: CURRENT_ID,
  versionValidFrom: "2024-01-01",
  versionValidTo: null,
} satisfies StatuteSeed;
const OPEN_OLDER = {
  id: OPEN_OLDER_ID,
  versionValidFrom: "2020-01-01",
  versionValidTo: null,
} satisfies StatuteSeed;

/**
 * Newest validity window first, as the versions endpoint orders them, with
 * the endpoint's mark on the text the bare address shows.
 */
const WORK_VERSIONS = [version(CURRENT, true), version(OPEN_OLDER, false)];

const seedWork = (queryClient: QueryClient): void => {
  for (const seed of [CURRENT, OPEN_OLDER]) {
    queryClient.setQueryData(
      publicStatuteOptions(seed.id).queryKey,
      statute(seed),
    );
    queryClient.setQueryData(
      statuteVersionsOptions(seed.id).queryKey,
      WORK_VERSIONS,
    );
  }

  queryClient.setQueryData(
    statuteBySlugOptions({ country: COUNTRY_SEGMENT, slug: SLUG }).queryKey,
    statute(CURRENT),
  );
};

const seedDay = (
  queryClient: QueryClient,
  asOf: string,
  seed: StatuteSeed,
): void => {
  queryClient.setQueryData(
    statuteBySlugOptions({ asOf, country: COUNTRY_SEGMENT, slug: SLUG })
      .queryKey,
    statute(seed),
  );
};

const load = async (
  queryClient: QueryClient,
  {
    hash = "",
    slug,
    search = {},
    version: versionSegment,
  }: {
    hash?: string;
    search?: Parameters<typeof loadPublicStatuteRoute>[0]["search"];
    slug: string;
    version?: string;
  },
) =>
  await loadPublicStatuteRoute({
    hash,
    params: {
      country: COUNTRY_SEGMENT,
      slug,
      ...(versionSegment === undefined ? {} : { version: versionSegment }),
    },
    queryClient,
    search,
  });

/** The redirect the loader threw, or a failure naming what it did instead. */
const canonicalRedirect = async (loading: Promise<unknown>): Promise<unknown> =>
  await loading.then(
    () => panic("Expected the loader to redirect to the canonical address."),
    (error: unknown) => error,
  );

describe("the address a statute consolidation is canonical at", () => {
  test("an older open-ended consolidation stays at its own /v/ path", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    seedDay(queryClient, "2020-01-01", OPEN_OLDER);

    // Both consolidations are open-ended, so reading "latest" off this row
    // would send this one to the bare slug path, where the reader would be
    // shown the 2024 text instead.
    const { statute: resolved } = await load(queryClient, {
      slug: SLUG,
      version: "2020-01-01",
    });

    expect(resolved?.id).toBe(OPEN_OLDER_ID);
  });

  test("the Work's latest consolidation renders at the bare slug path", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);

    const { statute: resolved, versions } = await load(queryClient, {
      slug: SLUG,
    });

    expect(resolved?.id).toBe(CURRENT_ID);
    expect(versions).toHaveLength(2);
  });

  test("a /v/ opening that names the latest text moves to the bare slug", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    seedDay(queryClient, "2024-01-01", CURRENT);

    expect(
      await canonicalRedirect(
        load(queryClient, { slug: SLUG, version: "2024-01-01" }),
      ),
    ).toMatchObject({
      options: {
        params: { country: COUNTRY_SEGMENT, slug: SLUG },
        to: "/law/$country/statutes/$slug",
      },
    });
  });

  test("a published future consolidation keeps its /v/ path; the text in force owns the bare slug", async () => {
    const queryClient = new QueryClient();
    const future = {
      id: FUTURE_ID,
      versionValidFrom: "2099-01-01",
      versionValidTo: null,
    } satisfies StatuteSeed;
    // The future text is the newest window, but the endpoint marks the one in
    // force as the default: the order alone would send readers to a wording
    // that does not apply yet.
    const versions = [
      version(future, false),
      version(CURRENT, true),
      version(OPEN_OLDER, false),
    ];
    for (const seed of [future, CURRENT, OPEN_OLDER]) {
      queryClient.setQueryData(
        publicStatuteOptions(seed.id).queryKey,
        statute(seed),
      );
      queryClient.setQueryData(
        statuteVersionsOptions(seed.id).queryKey,
        versions,
      );
    }
    seedDay(queryClient, "2099-01-01", future);
    seedDay(queryClient, "2024-01-01", CURRENT);

    const { statute: resolved } = await load(queryClient, {
      slug: SLUG,
      version: "2099-01-01",
    });
    expect(resolved?.id).toBe(FUTURE_ID);

    expect(
      await canonicalRedirect(
        load(queryClient, { slug: SLUG, version: "2024-01-01" }),
      ),
    ).toMatchObject({
      options: {
        params: { country: COUNTRY_SEGMENT, slug: SLUG },
        to: "/law/$country/statutes/$slug",
      },
    });
  });

  test("a day resolves to that consolidation's own address", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    seedDay(queryClient, "2021-01-01", OPEN_OLDER);

    // The day is a lookup, not an address: it names the 2020 text, and the
    // reader is sent to that text's URL with the lookup dropped. The anchor
    // and the jump say where in the text to open, so they travel on.
    expect(
      await canonicalRedirect(
        load(queryClient, {
          hash: "#sec-2079",
          search: { asOf: "2021-01-01", jump: JUMP, q: "odpovědnost" },
          slug: SLUG,
        }),
      ),
    ).toMatchObject({
      options: {
        hash: "sec-2079",
        params: {
          country: COUNTRY_SEGMENT,
          slug: SLUG,
          version: "2020-01-01",
        },
        search: { jump: JUMP, q: "odpovědnost" },
        to: "/law/$country/statutes/$slug/v/$version",
      },
    });
  });

  test("a comparison travels with the reader to the canonical address", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    seedDay(queryClient, "2024-01-01", CURRENT);

    // A deep link names the version it was minted on; when that version turns
    // out to be the latest, the comparison must still open at the bare slug.
    expect(
      await canonicalRedirect(
        load(queryClient, {
          search: {
            compare: "2020-01-01",
            provision: "sec-2079",
            show: "all",
          },
          slug: SLUG,
          version: "2024-01-01",
        }),
      ),
    ).toMatchObject({
      options: {
        search: {
          compare: "2020-01-01",
          provision: "sec-2079",
          show: "all",
        },
        to: "/law/$country/statutes/$slug",
      },
    });
  });
});

describe("a version or a day that cannot be read as in force", () => {
  const REVERSED_ID = toSafeId<"legislationDocument">(
    "00000000-0000-4000-8000-000000000004",
  );
  const REVERSED = {
    id: REVERSED_ID,
    versionValidFrom: "2022-01-01",
    versionValidTo: "2021-12-31",
    windowDisposition: "invalid-window",
    windowDispositionBasis: "reversed",
  } satisfies StatuteSeed;

  test("a day the publisher's inconsistent dates leave unanswered shows the act and says why", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    const gap: StatuteWindowGap = {
      windowGap: [
        {
          basis: "reversed",
          id: REVERSED_ID,
          language: "cs",
          versionValidFrom: "2022-01-01",
          versionValidTo: "2021-12-31",
        },
      ],
    };
    queryClient.setQueryData(
      statuteBySlugOptions({
        asOf: "2022-02-01",
        country: COUNTRY_SEGMENT,
        slug: SLUG,
      }).queryKey,
      gap,
    );

    const loaded = await load(queryClient, {
      search: { asOf: "2022-02-01" },
      slug: SLUG,
    });

    expect(loaded.statute).toBeNull();
    expect(loaded.windowGap).toEqual(gap.windowGap);
    expect(loaded.work.id).toBe(CURRENT_ID);
  });

  test("a day nothing covers carries no publisher-data reason", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    queryClient.setQueryData(
      statuteBySlugOptions({
        asOf: "1990-01-01",
        country: COUNTRY_SEGMENT,
        slug: SLUG,
      }).queryKey,
      null,
    );

    const loaded = await load(queryClient, {
      search: { asOf: "1990-01-01" },
      slug: SLUG,
    });

    expect(loaded.statute).toBeNull();
    expect(loaded.windowGap).toBeNull();
  });

  test("a version that cannot apply is read at its id, never at a day that does not name it", async () => {
    const queryClient = new QueryClient();
    const versions = [
      version(REVERSED, false),
      version(CURRENT, true),
      version(OPEN_OLDER, false),
    ];
    for (const seed of [REVERSED, CURRENT, OPEN_OLDER]) {
      queryClient.setQueryData(
        publicStatuteOptions(seed.id).queryKey,
        statute(seed),
      );
      queryClient.setQueryData(
        statuteVersionsOptions(seed.id).queryKey,
        versions,
      );
    }
    const idForm = createStatuteRouteParams({
      country: "CZE",
      documentId: REVERSED_ID,
      eli: "/eli/cz/sb/2012/89",
      slug: null,
      version: null,
    });

    expect(
      statuteVersionRouteParams({
        isDefault: false,
        version: statute(REVERSED),
      }),
    ).toEqual(idForm);
    // An older version that can apply keeps its day's address.
    expect(
      statuteVersionRouteParams({
        isDefault: false,
        version: statute(OPEN_OLDER),
      }),
    ).toEqual({ country: COUNTRY_SEGMENT, slug: SLUG, version: "2020-01-01" });

    // The id form is canonical for it, so it renders there instead of being
    // sent to a day the version never applied on.
    const loaded = await load(queryClient, { slug: idForm.slug });
    expect(loaded.statute?.id).toBe(REVERSED_ID);
  });
});

describe("the search a statute address carries", () => {
  // A hand-edited or truncated link must still open the act: a value the
  // reader cannot use is dropped, never a route error.
  test("drops an over-long provision or jump instead of rejecting the address", () => {
    const parsed = v.safeParse(publicStatuteSearchSchema, {
      compare: "2024-01-01",
      jump: "§".repeat(33),
      provision: "a".repeat(257),
    });

    expect(parsed.success).toBe(true);
    expect(parsed.output).toMatchObject({
      compare: "2024-01-01",
      jump: undefined,
      provision: undefined,
    });
  });

  test("keeps reader search terms while trimming the URL input", () => {
    expect(v.parse(publicStatuteSearchSchema, { q: " odpovědnost " }).q).toBe(
      "odpovědnost",
    );
  });

  test("keeps a provision anchor within the bound", () => {
    expect(
      v.parse(publicStatuteSearchSchema, { provision: " par_5 " }).provision,
    ).toBe("par_5");
  });
});
