import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { magyarKozlonyWorkEli } from "@stll/api-contract/magyar-kozlony-designation";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import {
  actNumberCondition,
  actYearCondition,
} from "@/api/lib/legal-search/legislation-act-number";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const sourceId = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-00000000a501",
);

const workOf = (designation: string): string =>
  magyarKozlonyWorkEli(designation) ??
  `unreachable: ${designation} folds to nothing`;

// Neighbours share digits with each other (1, 11, 123, 1234) and the same
// number recurs across series and years, so only an exact match answers.
const HUNGARIAN_WORKS = [
  "2013. évi V. törvény",
  "2013. évi XV. törvény",
  "2012. évi V. törvény",
  "123/2020. (IV. 30.) Korm. rendelet",
  "1234/2020. (XII. 1.) Korm. rendelet",
  "23/2020. (I. 5.) Korm. rendelet",
  "123/2020. (V. 2.) IM rendelet",
  "123/2021. (IV. 30.) Korm. rendelet",
  "5/2013. (II. 1.) AB határozat",
].map(workOf);

const CZECH_WORKS = [
  "https://www.e-sbirka.cz/eli/cz/sb/2013/5",
  "https://www.e-sbirka.cz/eli/cz/sb/2020/123",
];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(legislationSources).values({
    id: sourceId,
    name: "Act number fixture",
    adapterKey: "act-number-fixture",
  });
  await db.insert(legislationDocuments).values(
    [
      ...HUNGARIAN_WORKS.map((eli) => ({
        eli,
        country: "HUN",
        language: "hu",
      })),
      ...CZECH_WORKS.map((eli) => ({ eli, country: "CZE", language: "cs" })),
    ].map(({ eli, country, language }) => ({
      id: createSafeId<"legislationDocument">(),
      sourceId,
      eli,
      title: eli,
      country,
      language,
      contentHash: "a".repeat(64),
      versionValidFrom: "2021-01-01",
    })),
  );
});

afterAll(async () => {
  await client.close();
});

const worksWhere = async (
  country: string,
  condition: ReturnType<typeof actYearCondition> | null,
) => {
  if (condition === null) {
    return null;
  }
  const rows = await db
    .select({ eli: legislationDocuments.eli })
    .from(legislationDocuments)
    .where(and(eq(legislationDocuments.country, country), condition));
  return rows.map(({ eli }) => eli).toSorted();
};

describe("act numbers of Magyar Közlöny Works", () => {
  test.each([
    ["5/2013", "torveny", ["2013. évi V. törvény"]],
    ["123/2020", "korm-rendelet", ["123/2020. (IV. 30.) Korm. rendelet"]],
    ["123/2020", "im-rendelet", ["123/2020. (V. 2.) IM rendelet"]],
    ["5/2013", "ab-hatarozat", ["5/2013. (II. 1.) AB határozat"]],
    [
      "5/2013",
      undefined,
      ["2013. évi V. törvény", "5/2013. (II. 1.) AB határozat"],
    ],
    [
      "123/2020",
      undefined,
      ["123/2020. (IV. 30.) Korm. rendelet", "123/2020. (V. 2.) IM rendelet"],
    ],
    ["12/2020", "korm-rendelet", []],
  ] as const)(
    "%s in series %s names exactly its Works",
    async (number, collection, expected) => {
      expect(
        await worksWhere(
          "HUN",
          actNumberCondition({ number, collection, country: "HUN" }),
        ),
      ).toEqual(expected.map(workOf).toSorted());
    },
  );

  test("a Czech number keeps reading Czech ELIs", async () => {
    expect(
      await worksWhere(
        "CZE",
        actNumberCondition({
          number: "5/2013",
          collection: "sb",
          country: "CZE",
        }),
      ),
    ).toEqual(["https://www.e-sbirka.cz/eli/cz/sb/2013/5"]);
    expect(
      actNumberCondition({
        number: "5/2013",
        collection: "korm-rendelet",
        country: "CZE",
      }),
    ).toBeNull();
  });

  test("the year filter reads a law's year and a numbered act's year", async () => {
    expect(await worksWhere("HUN", actYearCondition(2013, "HUN"))).toEqual(
      [
        "2013. évi V. törvény",
        "2013. évi XV. törvény",
        "5/2013. (II. 1.) AB határozat",
      ]
        .map(workOf)
        .toSorted(),
    );
    expect(await worksWhere("HUN", actYearCondition(2021, "HUN"))).toEqual([
      workOf("123/2021. (IV. 30.) Korm. rendelet"),
    ]);
    expect(await worksWhere("CZE", actYearCondition(2020, "CZE"))).toEqual([
      "https://www.e-sbirka.cz/eli/cz/sb/2020/123",
    ]);
  });
});
