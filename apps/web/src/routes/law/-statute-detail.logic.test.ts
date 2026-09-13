import { QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  publicStatuteOptions,
  statuteBySlugOptions,
  statuteVersionsOptions,
} from "@/features/statutes/queries/statutes";
import type {
  PublicStatute,
  PublicStatuteVersion,
} from "@/features/statutes/queries/statutes";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { loadPublicStatuteRoute } from "@/routes/law/-statute-detail.logic";

const SLUG = "89-2012-sb-obcansky-zakonik";
const COUNTRY_SEGMENT = "cze";

const CURRENT_ID = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000001",
);
const OPEN_OLDER_ID = toSafeId<"legislationDocument">(
  "00000000-0000-4000-8000-000000000002",
);

type StatuteSeed = {
  id: SafeId<"legislationDocument">;
  versionValidFrom: string | null;
  versionValidTo: string | null;
};

const statute = ({
  id,
  versionValidFrom,
  versionValidTo,
}: StatuteSeed): PublicStatute => ({
  citationCaseCount: null,
  country: "CZE",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
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
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  versionValidFrom,
  versionValidTo,
});

const version = (seed: StatuteSeed): PublicStatuteVersion => {
  const {
    citationCaseCount: _citationCaseCount,
    documentAst: _documentAst,
    fulltext: _fulltext,
    sections: _sections,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...rest
  } = statute(seed);

  return rest;
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

/** Newest validity window first, as the versions endpoint orders them. */
const WORK_VERSIONS = [version(CURRENT), version(OPEN_OLDER)];

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

const load = async (
  queryClient: QueryClient,
  {
    hash = "",
    slug,
    search = {},
    version: versionSegment,
  }: {
    hash?: string;
    search?: { asOf?: string; jump?: string };
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
  test("an older open-ended consolidation canonicalises to its own /v/ path", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);

    // Both consolidations are open-ended, so reading "latest" off this row
    // would put two texts on the bare slug path.
    expect(
      await canonicalRedirect(load(queryClient, { slug: OPEN_OLDER_ID })),
    ).toMatchObject({
      options: {
        params: {
          country: COUNTRY_SEGMENT,
          slug: SLUG,
          version: "2020-01-01",
        },
        to: "/law/$country/statutes/$slug/v/$version",
      },
    });
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

  test("a legacy id with ?asOf resolves the day across the Work", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);
    queryClient.setQueryData(
      statuteBySlugOptions({
        asOf: "2021-01-01",
        country: COUNTRY_SEGMENT,
        slug: SLUG,
      }).queryKey,
      statute(OPEN_OLDER),
    );

    // The id names the current text; the day names an earlier one, and the
    // canonical address is that earlier consolidation's, not this id's.
    expect(
      await canonicalRedirect(
        load(queryClient, {
          search: { asOf: "2021-01-01" },
          slug: CURRENT_ID,
        }),
      ),
    ).toMatchObject({
      options: {
        params: {
          country: COUNTRY_SEGMENT,
          slug: SLUG,
          version: "2020-01-01",
        },
        search: {},
        to: "/law/$country/statutes/$slug/v/$version",
      },
    });
  });

  test("the provision anchor survives the canonical redirect", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);

    expect(
      await canonicalRedirect(
        load(queryClient, { hash: "#sec-2079", slug: CURRENT_ID }),
      ),
    ).toMatchObject({
      options: {
        hash: "sec-2079",
        params: { country: COUNTRY_SEGMENT, slug: SLUG },
        to: "/law/$country/statutes/$slug",
      },
    });
  });

  test("a jump query survives the canonical redirect", async () => {
    const queryClient = new QueryClient();
    seedWork(queryClient);

    expect(
      await canonicalRedirect(
        load(queryClient, { search: { jump: "§ 2079" }, slug: CURRENT_ID }),
      ),
    ).toMatchObject({
      options: {
        params: { country: COUNTRY_SEGMENT, slug: SLUG },
        search: { jump: "§ 2079" },
        to: "/law/$country/statutes/$slug",
      },
    });
  });
});
