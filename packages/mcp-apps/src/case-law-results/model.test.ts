import { expect, test } from "bun:test";

import { DECISION_TEXT_AVAILABILITY } from "@stll/api-contract/case-law-text-field";
import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";
import { DECISION_SEARCH_MATCHES } from "@stll/api-contract/search";

import {
  appendCourtCatalogPage,
  courtPickerGroups,
  filterDefaults,
  searchView,
} from "./model";

const CATALOG = {
  country: "SVK",
  courts: [
    {
      tierLabel: "supreme" as const,
      courts: [
        {
          key: "supreme",
          value: "Najvyšší súd",
          aliases: ["Najvyšší súd Slovenskej republiky"],
        },
      ],
    },
    {
      tierLabel: "regional" as const,
      courts: [
        {
          key: "Krajský súd v Bratislave",
          value: "Krajský súd v Bratislave",
          aliases: [],
        },
        {
          key: "Krajský súd v Košiciach",
          value: "Krajský súd v Košiciach",
          aliases: [],
        },
      ],
    },
  ],
  nextCursor: null,
};

test("catalog pages join tier by tier, apex first whichever page names it", () => {
  const first = {
    country: "SVK",
    courts: [
      {
        tierLabel: "regional" as const,
        courts: [
          {
            key: "Krajský súd v Bratislave",
            value: "Krajský súd v Bratislave",
            aliases: [],
          },
        ],
      },
    ],
    nextCursor: "next",
  };
  const second = {
    country: "SVK",
    courts: [
      {
        tierLabel: "constitutional" as const,
        courts: [{ key: "Ústavný súd", value: "Ústavný súd", aliases: [] }],
      },
      {
        tierLabel: "regional" as const,
        courts: [
          {
            key: "Krajský súd v Košiciach",
            value: "Krajský súd v Košiciach",
            aliases: [],
          },
        ],
      },
    ],
    nextCursor: null,
  };
  const joined = appendCourtCatalogPage(
    appendCourtCatalogPage(null, first),
    second,
  );
  expect(joined).toEqual({
    country: "SVK",
    courts: [
      {
        tierLabel: "constitutional",
        courts: [{ key: "Ústavný súd", value: "Ústavný súd", aliases: [] }],
      },
      {
        tierLabel: "regional",
        courts: [
          {
            key: "Krajský súd v Bratislave",
            value: "Krajský súd v Bratislave",
            aliases: [],
          },
          {
            key: "Krajský súd v Košiciach",
            value: "Krajský súd v Košiciach",
            aliases: [],
          },
        ],
      },
    ],
    nextCursor: null,
  });
});

test("a court's spellings on two pages join one entry, wherever it is listed", () => {
  const entry = (value: string) => ({ key: "supreme", value, aliases: [] });
  const page = (value: string, nextCursor: string | null) => ({
    country: "SVK",
    courts: [{ tierLabel: "supreme" as const, courts: [entry(value)] }],
    nextCursor,
  });
  expect(
    appendCourtCatalogPage(
      page("Najvyšší súd", "next"),
      page("Najvyšší súd Slovenskej republiky", null),
    ),
  ).toEqual({
    country: "SVK",
    courts: [
      {
        tierLabel: "supreme",
        courts: [
          {
            key: "supreme",
            value: "Najvyšší súd",
            aliases: ["Najvyšší súd Slovenskej republiky"],
          },
        ],
      },
    ],
    nextCursor: null,
  });
});

test("a search with no results still lists every court of the country", () => {
  expect(
    courtPickerGroups({ catalog: CATALOG, facets: { court: [] } }),
  ).toEqual([
    { tierLabel: "supreme", courts: [{ value: "Najvyšší súd", count: null }] },
    {
      tierLabel: "regional",
      courts: [
        { value: "Krajský súd v Bratislave", count: null },
        { value: "Krajský súd v Košiciach", count: null },
      ],
    },
  ]);
});

test("result counts sum a court's spellings and lead their tier", () => {
  expect(
    courtPickerGroups({
      catalog: CATALOG,
      facets: {
        court: [
          {
            tierLabel: "supreme",
            courts: [
              { value: "Najvyšší súd", count: 3 },
              { value: "Najvyšší súd Slovenskej republiky", count: 4 },
            ],
          },
          {
            tierLabel: "regional",
            courts: [{ value: "Krajský súd v Košiciach", count: 2 }],
          },
        ],
      },
    }),
  ).toEqual([
    { tierLabel: "supreme", courts: [{ value: "Najvyšší súd", count: 7 }] },
    {
      tierLabel: "regional",
      courts: [
        { value: "Krajský súd v Košiciach", count: 2 },
        { value: "Krajský súd v Bratislave", count: null },
      ],
    },
  ]);
});

test("without a catalog the picker falls back to the result facets", () => {
  const facets = {
    court: [
      {
        tierLabel: "regional" as const,
        courts: [{ value: "Krajský súd v Košiciach", count: 2 }],
      },
    ],
  };
  expect(courtPickerGroups({ catalog: null, facets })).toEqual(facets.court);
  expect(courtPickerGroups({ catalog: null, facets: null })).toEqual([]);
});

test.each([
  [{ country: "invalid" }, "invalidCountry"],
  [{ country: "CZE", date_from: "invalid" }, "invalidDateFrom"],
  [{ country: "CZE", date_to: "invalid" }, "invalidDateTo"],
  [{ country: "CZE", courts: [1] }, "invalidCourts"],
] as const)(
  "invalid filter values return a catalog key rather than an English agent hint: %j",
  (input, messageKey) => {
    expect(filterDefaults(input)).toEqual({ status: "invalid", messageKey });
  },
);

// Every match disposition must survive the view projection unchanged.
test.each(DECISION_SEARCH_MATCHES)(
  "search view retains %s matching",
  (match) => {
    const view = searchView({
      ...APP_SEARCH_FIXTURE,
      results: APP_SEARCH_FIXTURE.results.map((row) => ({ ...row, match })),
    });
    expect(view.type).toBe("search");
    if (view.type !== "search") {
      throw new TypeError("Expected a search view");
    }
    expect(view.results.map((row) => row.match)).toEqual(
      APP_SEARCH_FIXTURE.results.map(() => match),
    );
  },
);

test.each(Object.values(DECISION_TEXT_AVAILABILITY))(
  "search view retains %s text availability even when summaries are present",
  (textAvailability) => {
    const view = searchView({
      ...APP_SEARCH_FIXTURE,
      results: APP_SEARCH_FIXTURE.results.map((row) => ({
        ...row,
        textAvailability,
      })),
    });
    expect(view.type).toBe("search");
    if (view.type !== "search") {
      throw new TypeError("Expected a search view");
    }
    expect(view.results.map((row) => row.textAvailability)).toEqual(
      APP_SEARCH_FIXTURE.results.map(() => textAvailability),
    );
  },
);
