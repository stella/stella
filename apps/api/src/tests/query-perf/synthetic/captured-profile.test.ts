import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { LEGAL_LIST_ITEM_REVIEW_STATUSES } from "@/api/db/schema";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";

import aggregateProfile from "./aggregate-profile.json";
import {
  capturedProfileSchema,
  deriveSyntheticProfile,
  GROWTH_TABLE_ROW_COUNTS,
  parseCapturedProfile,
  SMALL_TABLE_ROW_COUNTS,
} from "./captured-profile";
import { HOT_TABLES, PLACEHOLDER_PROFILE } from "./profile";

const NOW = new Date("2026-04-01T00:00:00Z");
const emptyBuckets = {
  "0": 1,
  "1-10": 0,
  "11-100": 0,
  "101-1000": 0,
  "1001-10000": 0,
  "10001-100000": 0,
  "100001-1000000": 0,
  "1000001+": 0,
};
const populatedBuckets = {
  ...emptyBuckets,
  "0": 0.25,
  "1-10": 0.5,
  "11-100": 0.25,
};
const fixtureFraction = (fraction: number) =>
  fraction === 0 ? 0 : Math.max(0.01, Math.round(fraction * 100) / 100);

// These distributions come only from the repository's invented placeholder, not a captured database.
const fixture = () => {
  const tables = Object.fromEntries(
    HOT_TABLES.map((table) => {
      const rowCount = SMALL_TABLE_ROW_COUNTS[table];
      return [
        table,
        {
          smallRowCount: rowCount,
          normalizedWorkspaceBuckets:
            rowCount === 0 ? emptyBuckets : populatedBuckets,
          rowWidthFraction: rowCount === 0 ? 0 : 0.25,
          columns:
            rowCount === 0
              ? {}
              : Object.fromEntries(
                  Object.entries(PLACEHOLDER_PROFILE.tables[table].columns).map(
                    ([column, stats]) => [
                      column,
                      {
                        nullFraction: stats.null_frac,
                        distinctFraction: fixtureFraction(
                          stats.n_distinct < 0
                            ? -stats.n_distinct
                            : stats.n_distinct / rowCount,
                        ),
                        commonValueFrequencies: stats.most_common_freqs,
                        widthFraction: 0.12,
                      },
                    ],
                  ),
                ),
        },
      ];
    }),
  );
  return v.parse(capturedProfileSchema, {
    captureDate: "2026-04-01",
    sourceHash: "a".repeat(64),
    priorCapture: null,
    smallWorkspaceCount: 200,
    legalLists: { source: "observed", listCount: 0, sectionCount: 0 },
    growth: {
      workspaceCount: 2000,
      rowWidthBasisBytes: 4096,
      rowCounts: GROWTH_TABLE_ROW_COUNTS,
      legalLists: {
        ...PLACEHOLDER_PROFILE.legalLists,
        usingWorkspaceCount: 400,
        workspaceFraction: 0.2,
      },
      legalListColumnAssumptions: {
        source: "assumed",
        reason: "no observed population at capture",
        nullableFraction: 0.5,
        widths: { uuid: 16, int4: 4, int8: 8, timestamptz: 8, shorttext: 24 },
      },
    },
    tables,
  });
};

test("captured profiles reject raw values and undeclared fields at every aggregate boundary", () => {
  const profile = fixture();
  const entity = profile.tables.entities;
  const column = entity.columns["kind"];
  expect(column).toBeDefined();
  const invalidInputs = [
    { ...profile, workspaceIds: ["invented-id"] },
    { ...profile, volumeRatioToPriorCapture: 1 },
    {
      ...profile,
      growth: {
        ...profile.growth,
        legalListColumnAssumptions: {
          ...profile.growth.legalListColumnAssumptions,
          fields: {},
        },
      },
    },
    {
      ...profile,
      tables: {
        ...profile.tables,
        entities: { ...entity, samples: ["invented-text"] },
      },
    },
    {
      ...profile,
      tables: {
        ...profile.tables,
        entities: {
          ...entity,
          columns: { ...entity.columns, customer_name: column },
        },
      },
    },
    {
      ...profile,
      tables: {
        ...profile.tables,
        entities: {
          ...entity,
          columns: {
            ...entity.columns,
            kind: { ...column, mostCommonValues: ["invented-value"] },
          },
        },
      },
    },
    {
      ...profile,
      tables: {
        ...profile.tables,
        entities: {
          ...entity,
          normalizedWorkspaceBuckets: { ...populatedBuckets, other: 0 },
        },
      },
    },
  ];
  for (const input of invalidInputs) {
    expect(v.safeParse(capturedProfileSchema, input).success).toBe(false);
  }
});

test("small fixture sizes accept only the declared rounded public counts", () => {
  const profile = fixture();
  expect(v.safeParse(capturedProfileSchema, profile).success).toBe(true);
  expect(
    v.safeParse(capturedProfileSchema, { ...profile, smallWorkspaceCount: 201 })
      .success,
  ).toBe(false);
  for (const table of HOT_TABLES) {
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        tables: {
          ...profile.tables,
          [table]: {
            ...profile.tables[table],
            smallRowCount: SMALL_TABLE_ROW_COUNTS[table] + 1,
          },
        },
      }).success,
    ).toBe(false);
  }
});

test("growth fixture sizes accept only the declared fixed public counts", () => {
  const profile = fixture();
  expect(v.safeParse(capturedProfileSchema, profile).success).toBe(true);
  for (const table of HOT_TABLES) {
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        growth: {
          ...profile.growth,
          rowCounts: {
            ...profile.growth.rowCounts,
            [table]: GROWTH_TABLE_ROW_COUNTS[table] + 1,
          },
        },
      }).success,
    ).toBe(false);
  }
});

test("committed public volume targets use one significant digit and trailing zeros", () => {
  const profile = v.parse(capturedProfileSchema, aggregateProfile);
  const legalVolumes = [profile.legalLists, profile.growth.legalLists].flatMap(
    (lists) => {
      switch (lists.source) {
        case "observed":
          return [lists.listCount, lists.sectionCount];
        case "assumed":
          return [
            lists.usingWorkspaceCount,
            lists.listsPerWorkspace.min,
            lists.listsPerWorkspace.max,
            lists.sectionsPerList.min,
            lists.sectionsPerList.max,
          ];
        default:
          return lists satisfies never;
      }
    },
  );
  const volumes = [
    ...Object.values(SMALL_TABLE_ROW_COUNTS),
    ...Object.values(GROWTH_TABLE_ROW_COUNTS),
    ...Object.values(profile.tables).map(({ smallRowCount }) => smallRowCount),
    ...Object.values(profile.growth.rowCounts),
    profile.smallWorkspaceCount,
    profile.growth.workspaceCount,
    ...legalVolumes,
  ];
  for (const volume of volumes) {
    expect(volume.toString()).toMatch(/^(?:0|[1-9]0*)$/u);
  }
});

test("public width basis accepts only the fixed physical byte policy", () => {
  const profile = fixture();
  expect(v.safeParse(capturedProfileSchema, profile).success).toBe(true);
  expect(
    v.safeParse(capturedProfileSchema, {
      ...profile,
      growth: {
        ...profile.growth,
        rowWidthBasisBytes: profile.growth.rowWidthBasisBytes + 1,
      },
    }).success,
  ).toBe(false);
});

test("public fractions reject excess precision and positive values below one hundredth at every nested boundary", () => {
  const profile = fixture();
  const entity = profile.tables.entities;
  const column = {
    nullFraction: 0,
    distinctFraction: 0.5,
    commonValueFrequencies: [0.2],
    widthFraction: 0.12,
  };
  for (const value of [0.1234, 0.001, 1e-10]) {
    for (const field of [
      "nullFraction",
      "distinctFraction",
      "widthFraction",
    ] as const) {
      expect(
        v.safeParse(capturedProfileSchema, {
          ...profile,
          tables: {
            ...profile.tables,
            entities: {
              ...entity,
              columns: {
                ...entity.columns,
                created_at: { ...column, [field]: value },
              },
            },
          },
        }).success,
      ).toBe(false);
    }
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        tables: {
          ...profile.tables,
          entities: { ...entity, rowWidthFraction: value },
        },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        tables: {
          ...profile.tables,
          entities: {
            ...entity,
            columns: {
              ...entity.columns,
              created_at: { ...column, commonValueFrequencies: [value] },
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        tables: {
          ...profile.tables,
          entities: {
            ...entity,
            normalizedWorkspaceBuckets: {
              ...emptyBuckets,
              "0": value,
              "1-10": 1 - value,
            },
          },
        },
      }).success,
    ).toBe(false);
  }
});

test("public common-value summaries retain at most 98 shares", () => {
  const profile = fixture();
  const withCommonShares = (count: number) => ({
    ...profile,
    tables: {
      ...profile.tables,
      fields: {
        ...profile.tables.fields,
        columns: {
          ...profile.tables.fields.columns,
          content: {
            nullFraction: 0,
            distinctFraction: 0.5,
            commonValueFrequencies: Array.from({ length: count }, () => 0.01),
            widthFraction: 0.12,
          },
        },
      },
    },
  });
  expect(v.safeParse(capturedProfileSchema, withCommonShares(98)).success).toBe(
    true,
  );
  expect(v.safeParse(capturedProfileSchema, withCommonShares(99)).success).toBe(
    false,
  );
});

test("aggregate captures expire only after 31 calendar days and every derivation checks freshness", () => {
  const profile = fixture();
  for (const days of [-7, 0, 30, 31]) {
    const now = new Date(NOW.getTime() + days * 86_400_000 + 86_399_999);
    expect(parseCapturedProfile(profile, now).captureDate).toBe(
      profile.captureDate,
    );
    expect(
      deriveSyntheticProfile({ profile, profileId: "small", now }).tables
        .entities.rowCount,
    ).toBe(600);
  }
  const expired = new Date(NOW.getTime() + 32 * 86_400_000);
  expect(() => parseCapturedProfile(profile, expired)).toThrow(
    "older than 31 days",
  );
  expect(() =>
    deriveSyntheticProfile({ profile, profileId: "growth", now: expired }),
  ).toThrow("older than 31 days");
});

test("prior volume metadata remains review evidence and does not change CI freshness", () => {
  const profile = fixture();
  expect(v.safeParse(capturedProfileSchema, profile).success).toBe(true);
  for (const volumeRatio of [0.01, 0.5, 1, 1.99, 2, 3]) {
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        priorCapture: {
          captureDate: "2026-03-01",
          sourceHash: "b".repeat(64),
          volumeRatio,
        },
      }).success,
    ).toBe(true);
  }
  for (const volumeRatio of [
    0,
    0.001,
    1.999,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    expect(
      v.safeParse(capturedProfileSchema, {
        ...profile,
        priorCapture: {
          captureDate: "2026-03-01",
          sourceHash: "b".repeat(64),
          volumeRatio,
        },
      }).success,
    ).toBe(false);
  }
  expect(
    v.safeParse(capturedProfileSchema, {
      ...profile,
      priorCapture: {
        captureDate: profile.captureDate,
        sourceHash: "b".repeat(64),
        volumeRatio: 1,
      },
    }).success,
  ).toBe(false);
});

test("finite domain cardinality remains absolute while unbounded cardinality scales", () => {
  assertProperty(
    "finite domain cardinality remains absolute while unbounded cardinality scales",
    fc.property(fc.integer({ min: 1, max: 100 }), (hundredths) => {
      const profile = fixture();
      const fraction = hundredths / 100;
      const input = {
        ...profile,
        tables: {
          ...profile.tables,
          task_assignees: {
            ...profile.tables.task_assignees,
            columns: {
              ...profile.tables.task_assignees.columns,
              role: {
                nullFraction: 0,
                distinctFraction: fraction,
                commonValueFrequencies: [],
                widthFraction: 0.12,
              },
            },
          },
          entities: {
            ...profile.tables.entities,
            columns: {
              ...profile.tables.entities.columns,
              created_at: {
                nullFraction: 0,
                distinctFraction: fraction,
                commonValueFrequencies: [],
                widthFraction: 0.12,
              },
            },
          },
        },
      };
      const small = deriveSyntheticProfile({
        profile: input,
        profileId: "small",
        now: NOW,
      });
      const growth = deriveSyntheticProfile({
        profile: input,
        profileId: "growth",
        now: NOW,
      });
      expect(growth.tables.task_assignees.columns["role"]?.n_distinct).toBe(
        small.tables.task_assignees.columns["role"]?.n_distinct,
      );
      expect(small.tables.entities.columns["created_at"]?.n_distinct).toBe(
        -fraction,
      );
      expect(growth.tables.entities.columns["created_at"]?.n_distinct).toBe(
        -fraction,
      );
      expect(growth.tables.entities.rowCount).toBeGreaterThan(
        small.tables.entities.rowCount,
      );
    }),
    { numRuns: 30 },
  );
});

test("rounded finite cardinalities never exceed their declared domain", () => {
  assertProperty(
    "rounded finite cardinalities never exceed their declared domain",
    fc.property(
      fc.integer({
        min: TASK_ASSIGNEE_ROLES.length + 1,
        max: SMALL_TABLE_ROW_COUNTS.task_assignees,
      }),
      (estimate) => {
        const profile = fixture();
        const input = {
          ...profile,
          tables: {
            ...profile.tables,
            task_assignees: {
              ...profile.tables.task_assignees,
              columns: {
                ...profile.tables.task_assignees.columns,
                role: {
                  nullFraction: 0,
                  distinctFraction:
                    estimate / SMALL_TABLE_ROW_COUNTS.task_assignees,
                  commonValueFrequencies: [],
                  widthFraction: 0.12,
                },
              },
            },
          },
        };
        for (const profileId of ["small", "growth"] as const) {
          const derived = deriveSyntheticProfile({
            profile: input,
            profileId,
            now: NOW,
          });
          expect(
            derived.tables.task_assignees.columns["role"]?.n_distinct,
          ).toBe(TASK_ASSIGNEE_ROLES.length);
        }
      },
    ),
    { numRuns: 20 },
  );
});

test("workspace histograms conserve each profile's workspace universe and preserve empty buckets", () => {
  assertProperty(
    "workspace histograms conserve each profile's workspace universe and preserve empty buckets",
    fc.property(fc.integer({ min: 1, max: 99 }), (populatedPercent) => {
      const profile = fixture();
      const workspaceCount = profile.smallWorkspaceCount;
      const input = {
        ...profile,
        tables: {
          ...profile.tables,
          entities: {
            ...profile.tables.entities,
            normalizedWorkspaceBuckets: {
              ...emptyBuckets,
              "0": (100 - populatedPercent) / 100,
              "1-10": populatedPercent / 100,
            },
          },
        },
      };
      for (const profileId of ["small", "growth"] as const) {
        const derived = deriveSyntheticProfile({
          profile: input,
          profileId,
          now: NOW,
        });
        const expectedCount = profileId === "small" ? workspaceCount : 2000;
        for (const table of HOT_TABLES) {
          expect(
            Object.values(derived.tables[table].workspaceHistogram).reduce(
              (sum, count) => sum + count,
              0,
            ),
          ).toBe(expectedCount);
        }
        expect(derived.tables.entities.workspaceHistogram["11-100"]).toBe(0);
        expect(
          derived.tables.entities.workspaceHistogram["1-10"],
        ).toBeGreaterThan(0);
      }
    }),
    { numRuns: 30 },
  );
});

test("zero-row captures remain empty and growth requires declared synthetic assumptions", () => {
  const profile = fixture();
  const small = deriveSyntheticProfile({
    profile,
    profileId: "small",
    now: NOW,
  });
  expect(small.tables.legal_list_items.rowCount).toBe(0);
  expect(small.tables.legal_list_items.workspaceHistogram["0"]).toBe(200);
  expect(small.tables.legal_list_items.columns["review_status"]).toEqual({
    null_frac: 1,
    n_distinct: 0,
    most_common_freqs: [],
    avg_width: 0,
  });
  expect(profile.tables.legal_list_items.columns).toEqual({});
  const growth = deriveSyntheticProfile({
    profile,
    profileId: "growth",
    now: NOW,
  });
  expect(growth.tables.legal_list_items.rowCount).toBe(10_000);
  expect(
    growth.tables.legal_list_items.columns["review_status"]?.n_distinct,
  ).toBe(LEGAL_LIST_ITEM_REVIEW_STATUSES.length);
  expect(growth.tables.legal_list_items.averageRowWidth).toBe(144);
  expect(growth.tables.legal_list_items.workspaceHistogram).toEqual(
    growth.tables.entities.workspaceHistogram,
  );
  expect(
    v.safeParse(capturedProfileSchema, {
      ...profile,
      growth: { ...profile.growth, legalListColumnAssumptions: undefined },
    }).success,
  ).toBe(false);
  const allNull = {
    ...profile,
    tables: {
      ...profile.tables,
      entities: {
        ...profile.tables.entities,
        columns: {
          ...profile.tables.entities.columns,
          due_date: {
            nullFraction: 1,
            distinctFraction: 0,
            commonValueFrequencies: [],
            widthFraction: 0,
          },
        },
      },
    },
  };
  expect(
    deriveSyntheticProfile({ profile: allNull, profileId: "growth", now: NOW })
      .tables.entities.columns["due_date"]?.null_frac,
  ).toBe(1);
});

test("quantized aggregate frequencies tolerate floating-point sums but reject excess mass", () => {
  const profile = fixture();
  const changeFrequencyCount = (count: number) => ({
    ...profile,
    tables: {
      ...profile.tables,
      fields: {
        ...profile.tables.fields,
        columns: {
          ...profile.tables.fields.columns,
          content: {
            nullFraction: 0.14,
            distinctFraction: 0.86,
            commonValueFrequencies: Array.from({ length: count }, () => 0.01),
            widthFraction: 0.12,
          },
        },
      },
    },
  });
  const normalized = deriveSyntheticProfile({
    profile: changeFrequencyCount(86),
    profileId: "small",
    now: NOW,
  }).tables.fields.columns["content"];
  expect(normalized).toBeDefined();
  expect(
    (normalized?.null_frac ?? 0) +
      (normalized?.most_common_freqs.reduce(
        (sum, frequency) => sum + frequency,
        0,
      ) ?? 0),
  ).toBeCloseTo(1, 12);
  expect(
    v.safeParse(capturedProfileSchema, changeFrequencyCount(87)).success,
  ).toBe(false);
});
