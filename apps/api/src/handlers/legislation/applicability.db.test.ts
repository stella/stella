import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import {
  isEligibleLegislationExpression,
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
  LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";
import type {
  LegislationExpressionKind,
  LegislationWindowDisposition,
  LegislationWindowDispositionBasis,
} from "@stll/api-contract/legislation-expression";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  readStatuteByEliHandler,
  resolveStatuteExpression,
} from "@/api/handlers/legislation/by-eli";
import { readStatuteBySlugHandler } from "@/api/handlers/legislation/by-slug";
import { listStatutesHandler } from "@/api/handlers/legislation/list";
import { resolveStatutesHandler } from "@/api/handlers/legislation/resolve";
import { readLegislationShelf } from "@/api/handlers/legislation/shelf";
import { selectDefaultVersionId } from "@/api/handlers/legislation/work-key";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  eligibleExpression,
  inForceOn,
  legislationVersionRefAt,
} from "@/api/lib/legal-search/legislation-validity-window";
import { resolveWorksAtDate } from "@/api/lib/legal-search/legislation-works-at-date";
import type {
  LegislationReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// Every applicability read answers through one eligibility rule: only an
// effective window of an applicable kind says which text applied on a date.
// A version that never took effect, one whose publisher dates are
// inconsistent, a withdrawn tombstone and a promulgated text keep their dates
// as history, and no read may answer with them or let them hide a version
// that did apply.

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let legislationDb: LegislationReadDb;

const sourceId = createSafeId<"legislationSource">();

type Seed = {
  id?: SafeId<"legislationDocument">;
  eli: string;
  slug?: string;
  language?: string;
  kind?: LegislationExpressionKind;
  disposition?: LegislationWindowDisposition;
  basis?: LegislationWindowDispositionBasis;
  from: string | null;
  to: string | null;
};

const seeds: Seed[] = [];

/** Registers a stored version and returns its id. */
const version = (seed: Seed): SafeId<"legislationDocument"> => {
  const id = seed.id ?? createSafeId<"legislationDocument">();
  seeds.push({ ...seed, id });
  return id;
};

/** A calendar date `days` from today (UTC), as the date columns store it. */
const daysFromToday = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

// --- The two dated canaries ------------------------------------------------
//
// A Work whose publisher states two zero-length windows, stored reversed:
// each stated end is copied from the version before it. Nothing is inferred
// from the successors; the dates between each invalid version and its
// successor have no in-force reading.
const CANARY_ELI = "CZ/2006/110";
const CANARY_SLUG = "110-2006-sb-canary";
const canary = {
  first: version({
    eli: CANARY_ELI,
    slug: CANARY_SLUG,
    from: "2007-01-01",
    to: "2017-01-01",
  }),
  reversed2017: version({
    eli: CANARY_ELI,
    slug: CANARY_SLUG,
    disposition: "invalid-window",
    basis: "reversed",
    from: "2017-01-01",
    to: "2016-12-31",
  }),
  middle: version({
    eli: CANARY_ELI,
    slug: CANARY_SLUG,
    from: "2020-04-01",
    to: "2022-01-01",
  }),
  reversed2022: version({
    eli: CANARY_ELI,
    slug: CANARY_SLUG,
    disposition: "invalid-window",
    basis: "reversed",
    from: "2022-01-01",
    to: "2021-12-31",
  }),
  current: version({
    eli: CANARY_ELI,
    slug: CANARY_SLUG,
    from: "2022-04-01",
    to: null,
  }),
};

// An invalid version with no later effective successor: the effective
// version before it ended, so an ended-act fallback would answer with it.
const NO_SUCCESSOR_ELI = "CZ/2019/478";
const noSuccessor = {
  ended: version({
    eli: NO_SUCCESSOR_ELI,
    from: "2010-01-01",
    to: "2020-01-01",
  }),
  reversed: version({
    eli: NO_SUCCESSOR_ELI,
    disposition: "invalid-window",
    basis: "reversed",
    from: "2020-01-01",
    to: "2019-12-31",
  }),
};

// An invalid version followed by a promulgated text of its own language and
// by a consolidation in another language. Neither is a later version of the
// same consolidation history, so neither may mask the gap.
const SCOPED_ELI = "CZ/2001/1";
const scoped = {
  first: version({ eli: SCOPED_ELI, from: "2010-01-01", to: "2017-01-01" }),
  reversed: version({
    eli: SCOPED_ELI,
    disposition: "invalid-window",
    basis: "reversed",
    from: "2017-01-01",
    to: "2016-12-31",
  }),
  promulgated: version({
    eli: SCOPED_ELI,
    kind: "promulgated",
    from: "2017-06-01",
    to: null,
  }),
  english: version({
    eli: SCOPED_ELI,
    language: "en",
    from: "2017-06-01",
    to: "2018-01-01",
  }),
};

// Versions the publisher gave no start: they cannot be placed in time, so
// they sort below every dated version and name the gap exactly for the dates
// by which no dated version of their language had opened.
const MISSING_ONLY_ELI = "CZ/2002/2";
const missingOnly = version({
  eli: MISSING_ONLY_ELI,
  disposition: "invalid-window",
  basis: "missing-start",
  from: null,
  to: null,
});
const MISSING_BEFORE_DATED_ELI = "CZ/2002/3";
const missingBeforeDated = {
  missing: version({
    eli: MISSING_BEFORE_DATED_ELI,
    disposition: "invalid-window",
    basis: "missing-start",
    from: null,
    to: null,
  }),
  dated: version({
    eli: MISSING_BEFORE_DATED_ELI,
    from: "2015-01-01",
    to: null,
  }),
};

// Every consolidation the publisher flags as never in force.
const NEVER_ELI = "CZ/2005/78";
const neverInForce = version({
  eli: NEVER_ELI,
  disposition: "never-in-force",
  basis: "publisher-flag",
  from: "2006-01-01",
  to: null,
});

// --- The bypass matrix -----------------------------------------------------
//
// One shape per way a version can fail eligibility. For each: a Work holding
// only that version, with a window every read would otherwise match, and a
// Work where it opens after an eligible version it would otherwise hide.
const SHAPE_NAMES = [
  "never-in-force",
  "invalid-window",
  "withdrawn",
  "promulgated",
] as const;

type ShapeName = (typeof SHAPE_NAMES)[number];

const INELIGIBLE_SHAPES = {
  "never-in-force": {
    disposition: "never-in-force",
    basis: "publisher-flag",
  },
  "invalid-window": { disposition: "invalid-window", basis: "reversed" },
  withdrawn: { disposition: "withdrawn", basis: "publisher-unlisted" },
  promulgated: { kind: "promulgated" },
} as const satisfies Record<ShapeName, Partial<Seed>>;

const MATRIX_AS_OF = "2020-06-01";

/** The Works one shape is exercised on; see the matrix tests. */
const matrixWorks = (shape: ShapeName, index: number) => {
  const number = String(index + 1);
  const shaped = INELIGIBLE_SHAPES[shape];
  const alone = { eli: `CZ/2030/${number}`, slug: `matrix-alone-${number}` };
  const hiding = { eli: `CZ/2031/${number}`, slug: `matrix-hiding-${number}` };
  const upcomingHiding = `CZ/2034/${number}`;
  const recentHiding = `CZ/2035/${number}`;
  return {
    alone: {
      ...alone,
      id: version({ ...alone, ...shaped, from: "2010-01-01", to: null }),
    },
    hiding: {
      ...hiding,
      eligible: version({ ...hiding, from: "2010-01-01", to: null }),
      ineligible: version({
        ...hiding,
        ...shaped,
        from: "2015-01-01",
        to: null,
      }),
    },
    recent: version({
      eli: `CZ/2032/${number}`,
      ...shaped,
      from: daysFromToday(-5),
      to: null,
    }),
    upcoming: version({
      eli: `CZ/2033/${number}`,
      ...shaped,
      from: daysFromToday(5),
      to: null,
    }),
    upcomingHiding: {
      eligible: version({
        eli: upcomingHiding,
        from: daysFromToday(20),
        to: null,
      }),
      ineligible: version({
        eli: upcomingHiding,
        ...shaped,
        from: daysFromToday(5),
        to: null,
      }),
    },
    recentHiding: {
      eligible: version({
        eli: recentHiding,
        from: daysFromToday(-20),
        to: null,
      }),
      ineligible: version({
        eli: recentHiding,
        ...shaped,
        from: daysFromToday(-5),
        to: null,
      }),
    },
  };
};

type MatrixWorks = ReturnType<typeof matrixWorks>;

const matrix = SHAPE_NAMES.map(
  (shape, index) => [shape, matrixWorks(shape, index)] as const,
);

// The default-version ranking once put a never-in-force version with no
// dates first, because its empty window read as in force today.
const RANKING_ELI = "CZ/2040/1";
const ranking = {
  ended: version({ eli: RANKING_ELI, from: "2010-01-01", to: "2015-01-01" }),
  undatedNever: version({
    eli: RANKING_ELI,
    disposition: "never-in-force",
    basis: "publisher-flag",
    from: null,
    to: null,
  }),
};

beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  await db.execute(sql.raw("SET TIME ZONE 'UTC'"));
  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "applicability-open",
    name: "Open statutes source",
  });
  await db.insert(legislationDocuments).values(
    seeds.map((seed) => ({
      id: seed.id ?? createSafeId<"legislationDocument">(),
      sourceId,
      eli: seed.eli,
      slug: seed.slug ?? null,
      title: `Act ${seed.eli}`,
      country: "CZE",
      language: seed.language ?? "cs",
      documentType: "act",
      status: "current",
      versionValidFrom: seed.from,
      versionValidTo: seed.to,
      expressionKind: seed.kind ?? "consolidation",
      windowDisposition: seed.disposition ?? "effective",
      windowDispositionBasis: seed.basis ?? null,
    })),
  );

  legislationDb = async (read) =>
    await withPublicLawReaderRole(
      db,
      async (tx) =>
        // SAFETY: this PGlite transaction executes under the production
        // public-law role and exposes the same read surface to the callback.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded role transaction stands in for LegislationReadTransaction
        await read(tx as unknown as LegislationReadTransaction),
    );
});

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

// --- Helpers ---------------------------------------------------------------

const idOf = (result: unknown): string | null =>
  typeof result === "object" && result !== null && "id" in result
    ? String(result.id)
    : null;

const readEli = async (eli: string, asOf?: string) =>
  await readStatuteByEliHandler(
    { eli, ...(asOf === undefined ? {} : { asOf }) },
    legislationDb,
  );

const readSlug = async (slug: string, asOf?: string) =>
  await readStatuteBySlugHandler({
    legislationDb,
    params: { slug },
    query: { country: "CZE", ...(asOf === undefined ? {} : { asOf }) },
  });

const resolveOne = async (eli: string, asOf: string) => {
  const { items } = await resolveStatutesHandler(
    { works: [{ country: "CZE", eli, asOf }] },
    legislationDb,
  );
  const [item] = items;
  if (item === undefined) {
    throw new Error("resolve answered no item");
  }
  return { id: item.statute?.id ?? null, reason: item.unresolvedReason };
};

const worksAtDate = async (eli: string, asOf: string) =>
  await legislationDb(
    async (tx) =>
      await resolveWorksAtDate(tx, [{ key: eli, country: "CZE", eli, asOf }]),
  );

const listPageSchema = v.object({
  items: v.array(
    v.object({
      id: v.string(),
      validity: v.string(),
      amendmentCount: v.number(),
    }),
  ),
});

const listed = async (query: { asOf?: string; validity?: "in-force" } = {}) =>
  v.parse(
    listPageSchema,
    await listStatutesHandler(
      { country: "CZE", limit: 100, ...query },
      legislationDb,
    ),
  ).items;

const inconsistentBody = (
  versions: readonly {
    id: string;
    language: string;
    from: string | null;
    to: string | null;
    basis: LegislationWindowDispositionBasis;
  }[],
) => ({
  code: 404,
  response: {
    code: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_CODE,
    message: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT_MESSAGE,
    versions: versions.map((entry) => ({
      id: entry.id,
      language: entry.language,
      versionValidFrom: entry.from,
      versionValidTo: entry.to,
      basis: entry.basis,
    })),
  },
});

// --- Equivalence -----------------------------------------------------------

const WINDOW_EDGES = [null, "2014-01-01", "2016-01-01", "2018-01-01"] as const;
const PROBE_DATES = [
  "2013-12-31",
  "2014-01-01",
  "2015-06-01",
  "2016-01-01",
  "2017-01-01",
  "2018-01-01",
  "2019-01-01",
] as const;

/** The window rule every reader applied before eligibility existed. */
const previousInForceOn = (
  from: string | null,
  to: string | null,
  asOf: string,
): boolean => (from === null || from <= asOf) && (to === null || to > asOf);

describe("the eligibility rule", () => {
  test("agrees with the previous window rule for every eligible version, and answers nothing for any other", async () => {
    const cases = LEGISLATION_EXPRESSION_KINDS.flatMap((kind) =>
      LEGISLATION_WINDOW_DISPOSITIONS.flatMap((disposition) =>
        WINDOW_EDGES.flatMap((from) =>
          WINDOW_EDGES.flatMap((to) =>
            PROBE_DATES.map((asOf) => ({ kind, disposition, from, to, asOf })),
          ),
        ),
      ),
    );
    const row = legislationVersionRefAt("w");
    const values = sql.join(
      cases.map(
        (entry, index) =>
          sql`(${index}::int, ${entry.from}::date, ${entry.to}::date, ${entry.disposition}::text, ${entry.kind}::text, ${entry.asOf}::date)`,
      ),
      sql`, `,
    );
    const answered = await legislationDb(async (tx) =>
      executedRows(
        await tx.execute(sql`
          SELECT w.i AS i,
                 ${inForceOn(row, sql`w.as_of`)} AS in_force,
                 ${eligibleExpression(row)} AS eligible
            FROM (VALUES ${values})
              AS w(i, version_valid_from, version_valid_to, window_disposition, expression_kind, as_of)
           ORDER BY w.i
        `),
      ).map((result) =>
        v.parse(
          v.object({
            i: v.number(),
            in_force: v.boolean(),
            eligible: v.boolean(),
          }),
          result,
        ),
      ),
    );

    expect(answered).toHaveLength(cases.length);
    const eligibleCases = cases.filter((entry) =>
      isEligibleLegislationExpression({
        expressionKind: entry.kind,
        windowDisposition: entry.disposition,
      }),
    );
    // Both sides of the rule are reached: some versions apply, some never.
    expect(eligibleCases.length).toBeGreaterThan(0);
    expect(eligibleCases.length).toBeLessThan(cases.length);

    for (const [index, entry] of cases.entries()) {
      const eligible = isEligibleLegislationExpression({
        expressionKind: entry.kind,
        windowDisposition: entry.disposition,
      });
      expect({ entry, eligible: answered[index]?.eligible }).toEqual({
        entry,
        eligible,
      });
      expect({ entry, inForce: answered[index]?.in_force }).toEqual({
        entry,
        inForce:
          eligible && previousInForceOn(entry.from, entry.to, entry.asOf),
      });
    }
  });
});

// --- Canaries --------------------------------------------------------------

/** Every read on a canary date names the inconsistent version. */
const canaryTest = ({
  asOf,
  responsible,
}: {
  asOf: string;
  responsible: { id: string; from: string; to: string };
}) => {
  test(`on ${asOf} every read names the inconsistent version, never another text`, async () => {
    const expected = inconsistentBody([
      { ...responsible, language: "cs", basis: "reversed" },
    ]);
    expect(await readEli(CANARY_ELI, asOf)).toMatchObject(expected);
    expect(await readSlug(CANARY_SLUG, asOf)).toMatchObject(expected);
    expect(await resolveOne(CANARY_ELI, asOf)).toEqual({
      id: null,
      reason: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
    });
    const batch = await worksAtDate(CANARY_ELI, asOf);
    expect(batch.idByKey.has(CANARY_ELI)).toBe(false);
    expect(batch.inconsistentKeys.has(CANARY_ELI)).toBe(true);
  });
};

describe("the dated canaries", () => {
  canaryTest({
    asOf: "2018-06-01",
    responsible: {
      id: canary.reversed2017,
      from: "2017-01-01",
      to: "2016-12-31",
    },
  });
  canaryTest({
    asOf: "2022-02-01",
    responsible: {
      id: canary.reversed2022,
      from: "2022-01-01",
      to: "2021-12-31",
    },
  });

  test("the versions around the gaps still answer their own dates", async () => {
    expect(idOf(await readEli(CANARY_ELI, "2016-06-01"))).toBe(canary.first);
    expect(idOf(await readEli(CANARY_ELI, "2021-01-01"))).toBe(canary.middle);
    expect(idOf(await readEli(CANARY_ELI, "2022-06-01"))).toBe(canary.current);
    expect(await resolveOne(CANARY_ELI, "2021-01-01")).toEqual({
      id: canary.middle,
      reason: null,
    });
  });
});

describe("the gap reason", () => {
  test("an invalid version with no later effective successor answers the gap, not the ended version before it", async () => {
    const asOf = "2021-06-01";
    expect(await readEli(NO_SUCCESSOR_ELI, asOf)).toMatchObject(
      inconsistentBody([
        {
          id: noSuccessor.reversed,
          language: "cs",
          from: "2020-01-01",
          to: "2019-12-31",
          basis: "reversed",
        },
      ]),
    );
    expect(await resolveOne(NO_SUCCESSOR_ELI, asOf)).toEqual({
      id: null,
      reason: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
    });
    const batch = await worksAtDate(NO_SUCCESSOR_ELI, asOf);
    expect(batch.idByKey.get(NO_SUCCESSOR_ELI)).toBeUndefined();
    expect(batch.inconsistentKeys.has(NO_SUCCESSOR_ELI)).toBe(true);
    // Before the invalid version opened, the ended act answers as ever.
    expect(await resolveOne(NO_SUCCESSOR_ELI, "2015-01-01")).toEqual({
      id: noSuccessor.ended,
      reason: null,
    });
  });

  test("a promulgated text or another language's consolidation does not mask the gap", async () => {
    const asOf = "2018-06-01";
    expect(await readEli(SCOPED_ELI, asOf)).toMatchObject(
      inconsistentBody([
        {
          id: scoped.reversed,
          language: "cs",
          from: "2017-01-01",
          to: "2016-12-31",
          basis: "reversed",
        },
      ]),
    );
    // The English consolidation ended before the date, so an ended-act
    // fallback would answer with it; the gap outranks that fallback.
    const batch = await worksAtDate(SCOPED_ELI, asOf);
    expect(batch.idByKey.get(SCOPED_ELI)).toBeUndefined();
    expect(batch.inconsistentKeys.has(SCOPED_ELI)).toBe(true);
    // The other language's own history still answers where it applies.
    expect(idOf(await readEli(SCOPED_ELI, "2017-09-01"))).toBe(scoped.english);
    expect(scoped.promulgated).not.toBe(scoped.english);
  });

  test("a version with no stated start names the gap for every date no dated version of its language had opened by", async () => {
    const onlyMissing = inconsistentBody([
      {
        id: missingOnly,
        language: "cs",
        from: null,
        to: null,
        basis: "missing-start",
      },
    ]);
    expect(await readEli(MISSING_ONLY_ELI, "1990-01-01")).toMatchObject(
      onlyMissing,
    );
    expect(await readEli(MISSING_ONLY_ELI, "2030-01-01")).toMatchObject(
      onlyMissing,
    );
    expect(await resolveOne(MISSING_ONLY_ELI, "2015-01-01")).toEqual({
      id: null,
      reason: LEGISLATION_PUBLISHER_WINDOW_INCONSISTENT,
    });

    expect(await readEli(MISSING_BEFORE_DATED_ELI, "2010-01-01")).toMatchObject(
      inconsistentBody([
        {
          id: missingBeforeDated.missing,
          language: "cs",
          from: null,
          to: null,
          basis: "missing-start",
        },
      ]),
    );
    expect(idOf(await readEli(MISSING_BEFORE_DATED_ELI, "2016-01-01"))).toBe(
      missingBeforeDated.dated,
    );
  });

  test("a Work whose publisher states it never took effect is uncovered, not inconsistent", async () => {
    expect(await readEli(NEVER_ELI, "2010-01-01")).toMatchObject({
      code: 404,
      response: {
        message:
          "No version of this legislation was in force on the given date",
      },
    });
    expect(await resolveOne(NEVER_ELI, "2010-01-01")).toEqual({
      id: null,
      reason: null,
    });
    expect(
      (await listed()).find((item) => item.id === neverInForce)?.validity,
    ).toBe("never-in-force");
  });
});

// --- Bypass matrix ---------------------------------------------------------

/** One shape's row of the bypass matrix, across every applicability read. */
const matrixTests = (shape: ShapeName, works: MatrixWorks) => {
  test(`${shape}: the point-in-time reads never answer with it`, async () => {
    expect(idOf(await readEli(works.alone.eli, MATRIX_AS_OF))).toBeNull();
    expect(
      await resolveStatuteExpression(
        { eli: works.alone.eli, asOf: MATRIX_AS_OF },
        legislationDb,
      ),
    ).not.toMatchObject({ type: "expression" });
    expect(idOf(await readSlug(works.alone.slug, MATRIX_AS_OF))).toBeNull();
    expect((await resolveOne(works.alone.eli, MATRIX_AS_OF)).id).toBeNull();
    expect(
      (await worksAtDate(works.alone.eli, MATRIX_AS_OF)).idByKey.size,
    ).toBe(0);
  });

  test(`${shape}: opening later, it hides no version that applies`, async () => {
    const { eligible } = works.hiding;
    expect(idOf(await readEli(works.hiding.eli, MATRIX_AS_OF))).toBe(eligible);
    expect(idOf(await readSlug(works.hiding.slug, MATRIX_AS_OF))).toBe(
      eligible,
    );
    // Without a date the default version answers.
    expect(idOf(await readSlug(works.hiding.slug))).toBe(eligible);
    expect(await resolveOne(works.hiding.eli, MATRIX_AS_OF)).toEqual({
      id: eligible,
      reason: null,
    });
    expect(
      (await worksAtDate(works.hiding.eli, MATRIX_AS_OF)).idByKey.get(
        works.hiding.eli,
      ),
    ).toBe(eligible);
  });

  test(`${shape}: the listing never shows it as in force, nor lets it replace the version that is`, async () => {
    const items = await listed();
    const alone = items.find((item) => item.id === works.alone.id);
    if (shape === "withdrawn") {
      expect(alone).toBeUndefined();
    } else {
      expect(alone?.validity).toBe(
        shape === "never-in-force" ? "never-in-force" : "unknown",
      );
    }
    const hiding = items.find((item) => item.id === works.hiding.eligible);
    expect(hiding).toMatchObject({ validity: "in-force", amendmentCount: 0 });
    expect(items.map((item) => item.id)).not.toContain(works.hiding.ineligible);

    const inForce = (await listed({ validity: "in-force" })).map(
      (item) => item.id,
    );
    expect(inForce).not.toContain(works.alone.id);
    expect(inForce).toContain(works.hiding.eligible);
  });

  test(`${shape}: the shelf neither lists it nor lets it hide the next version that will apply`, async () => {
    const shelf = await readLegislationShelf({
      legislationDb,
      country: "CZE",
    });
    const recent = shelf.recentlyInForce.map((item) => item.id);
    const upcoming = shelf.enteringIntoForce.map((item) => item.id);
    expect(recent).not.toContain(works.recent);
    expect(recent).not.toContain(works.recentHiding.ineligible);
    expect(recent).toContain(works.recentHiding.eligible);
    expect(upcoming).not.toContain(works.upcoming);
    expect(upcoming).not.toContain(works.upcomingHiding.ineligible);
    expect(upcoming).toContain(works.upcomingHiding.eligible);
  });

  if (shape === "withdrawn") {
    test("withdrawn: it is never a Work's default", async () => {
      expect(
        await legislationDb(
          async (tx) =>
            await selectDefaultVersionId(tx, {
              sourceId,
              eli: works.alone.eli,
              language: "cs",
            }),
        ),
      ).toBeNull();
    });
  }
};

describe("no applicability read answers with a version that cannot apply", () => {
  for (const [shape, works] of matrix) {
    matrixTests(shape, works);
  }

  test("the default version is one that applies whenever the Work has one", async () => {
    // Neither applies today; the never-in-force one has no dates at all,
    // which the previous rule read as in force on every date.
    expect(ranking.undatedNever).not.toBe(ranking.ended);
    expect(
      await legislationDb(
        async (tx) =>
          await selectDefaultVersionId(tx, {
            sourceId,
            eli: RANKING_ELI,
            language: "cs",
          }),
      ),
    ).toBe(ranking.ended);
  });
});
