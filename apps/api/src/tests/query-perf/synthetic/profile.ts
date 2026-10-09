import * as v from "valibot";

export const SYNTHETIC_LANGUAGES = ["en", "cs", "de"] as const;

export const HOT_TABLES = [
  "entities",
  "entity_versions",
  "fields",
  "search_documents",
  "extracted_content",
  "legal_list_items",
  "task_assignees",
] as const;

export const WORKSPACE_BUCKETS = [
  "0",
  "1-10",
  "11-100",
  "101-1000",
  "1001-10000",
  "10001-100000",
  "100001-1000000",
  "1000001+",
] as const;

const countSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const fractionSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));

export const columnStatsSchema = v.pipe(
  v.strictObject({
    null_frac: fractionSchema,
    n_distinct: v.pipe(v.number(), v.finite(), v.minValue(-1)),
    most_common_freqs: v.array(fractionSchema),
    avg_width: v.pipe(v.number(), v.finite(), v.minValue(0)),
  }),
  v.check(
    ({ null_frac, most_common_freqs }) =>
      null_frac + most_common_freqs.reduce((sum, value) => sum + value, 0) <=
      1 + 1e-7,
    "Null and most-common frequencies must sum to at most one",
  ),
);

export type ColumnStats = v.InferOutput<typeof columnStatsSchema>;

export const workspaceHistogramSchema = v.strictObject({
  "0": countSchema,
  "1-10": countSchema,
  "11-100": countSchema,
  "101-1000": countSchema,
  "1001-10000": countSchema,
  "10001-100000": countSchema,
  "100001-1000000": countSchema,
  "1000001+": countSchema,
} as const satisfies Record<
  (typeof WORKSPACE_BUCKETS)[number],
  typeof countSchema
>);

export type WorkspaceHistogram = v.InferOutput<typeof workspaceHistogramSchema>;

const tableProfileSchema = v.pipe(
  v.strictObject({
    rowCount: countSchema,
    averageRowWidth: v.pipe(v.number(), v.finite(), v.minValue(0)),
    workspaceHistogram: workspaceHistogramSchema,
    columns: v.record(v.string(), columnStatsSchema),
  }),
  v.check(
    ({ rowCount, workspaceHistogram }) =>
      rowCount === 0 ||
      WORKSPACE_BUCKETS.some(
        (bucket) => bucket !== "0" && workspaceHistogram[bucket] > 0,
      ),
    "A populated table must have a populated workspace bucket",
  ),
);

export const legalListsSchema = v.variant("source", [
  v.strictObject({
    source: v.literal("observed"),
    listCount: v.literal(0),
    sectionCount: v.literal(0),
  }),
  v.strictObject({
    source: v.literal("assumed"),
    reason: v.literal("no observed population at capture"),
    usingWorkspaceCount: countSchema,
    workspaceFraction: fractionSchema,
    listsPerWorkspace: v.strictObject({
      min: v.literal(1),
      max: v.literal(5),
      distribution: v.literal("uniform"),
    }),
    sectionsPerList: v.strictObject({
      min: v.literal(2),
      max: v.literal(6),
      distribution: v.literal("uniform"),
    }),
    itemEntityFraction: v.literal(0.1),
    itemWorkspaceDistribution: v.literal("proportional-entities"),
    itemSectionDistribution: v.literal("uniform"),
    listItemTypeDistribution: v.literal("uniform"),
    reviewStatusDistribution: v.literal("uniform"),
  }),
]);

export const aggregateProfileSchema = v.pipe(
  v.strictObject({
    status: v.picklist(["synthetic", "reviewed-aggregate"]),
    legalLists: legalListsSchema,
    seed: v.pipe(
      v.number(),
      v.safeInteger(),
      v.minValue(0),
      v.maxValue(0xff_ff_ff_ff),
    ),
    tables: v.strictObject({
      entities: tableProfileSchema,
      entity_versions: tableProfileSchema,
      fields: tableProfileSchema,
      search_documents: tableProfileSchema,
      extracted_content: tableProfileSchema,
      legal_list_items: tableProfileSchema,
      task_assignees: tableProfileSchema,
    } as const satisfies Record<
      (typeof HOT_TABLES)[number],
      typeof tableProfileSchema
    >),
  }),
  v.check(({ tables }) => {
    const workspaceCounts = HOT_TABLES.map((table) =>
      Object.values(tables[table].workspaceHistogram).reduce(
        (sum, count) => sum + count,
        0,
      ),
    );
    return workspaceCounts.every((count) => count === workspaceCounts.at(0));
  }, "Tables must share one workspace universe"),
);

export type SyntheticProfile = v.InferOutput<typeof aggregateProfileSchema>;

// These invented distributions exercise long-tail tenancy until an aggregate profile is reviewed.
const placeholderTable = {
  rowCount: 100_000,
  averageRowWidth: 128,
  workspaceHistogram: {
    "0": 20,
    "1-10": 50,
    "11-100": 20,
    "101-1000": 8,
    "1001-10000": 3,
    "10001-100000": 1,
    "100001-1000000": 0,
    "1000001+": 0,
  },
  columns: {},
} satisfies SyntheticProfile["tables"]["entities"];

const createdAtStats = {
  null_frac: 0,
  n_distinct: -0.9,
  most_common_freqs: [],
  avg_width: 8,
};
const languageStats = {
  null_frac: 0,
  n_distinct: 3,
  most_common_freqs: [0.7, 0.2],
  avg_width: 4,
};

export const PLACEHOLDER_PROFILE = {
  status: "synthetic",
  seed: 0x57_e1_1a,
  legalLists: {
    source: "assumed",
    reason: "no observed population at capture",
    usingWorkspaceCount: 82,
    workspaceFraction: 82 / 102,
    listsPerWorkspace: { min: 1, max: 5, distribution: "uniform" },
    sectionsPerList: { min: 2, max: 6, distribution: "uniform" },
    itemEntityFraction: 0.1,
    itemWorkspaceDistribution: "proportional-entities",
    itemSectionDistribution: "uniform",
    listItemTypeDistribution: "uniform",
    reviewStatusDistribution: "uniform",
  },
  tables: {
    entities: {
      ...placeholderTable,
      rowCount: 300_000,
      averageRowWidth: 256,
      columns: {
        kind: {
          null_frac: 0,
          n_distinct: 5,
          most_common_freqs: [0.5, 0.4],
          avg_width: 12,
        },
        status: {
          null_frac: 0,
          n_distinct: 3,
          most_common_freqs: [0.65, 0.2],
          avg_width: 12,
        },
        priority: {
          null_frac: 0,
          n_distinct: 4,
          most_common_freqs: [0.4, 0.3],
          avg_width: 4,
        },
        parent_id: {
          null_frac: 0.9,
          n_distinct: -0.1,
          most_common_freqs: [],
          avg_width: 16,
        },
        updated_at: {
          null_frac: 0.02,
          n_distinct: -0.9,
          most_common_freqs: [],
          avg_width: 8,
        },
        due_date: { ...createdAtStats, null_frac: 0.2 },
        created_at: createdAtStats,
      },
    },
    entity_versions: {
      ...placeholderTable,
      rowCount: 600_000,
      columns: {
        deleted_at: {
          null_frac: 0.95,
          n_distinct: -0.05,
          most_common_freqs: [],
          avg_width: 8,
        },
        created_at: createdAtStats,
      },
    },
    fields: {
      ...placeholderTable,
      rowCount: 1_000_000,
      averageRowWidth: 512,
      columns: {
        content: {
          null_frac: 0,
          n_distinct: -0.9,
          most_common_freqs: [],
          avg_width: 256,
        },
      },
    },
    search_documents: {
      ...placeholderTable,
      rowCount: 300_000,
      averageRowWidth: 1024,
      columns: {
        language: languageStats,
        updated_at: createdAtStats,
      },
    },
    extracted_content: {
      ...placeholderTable,
      rowCount: 200_000,
      averageRowWidth: 4096,
      columns: {
        language: languageStats,
        extracted_at: createdAtStats,
      },
    },
    legal_list_items: {
      ...placeholderTable,
      columns: {
        review_status: {
          null_frac: 0,
          n_distinct: 4,
          most_common_freqs: [0.7, 0.2],
          avg_width: 12,
        },
        created_at: createdAtStats,
      },
    },
    task_assignees: {
      ...placeholderTable,
      columns: {
        role: {
          null_frac: 0,
          n_distinct: 2,
          most_common_freqs: [0.7, 0.3],
          avg_width: 12,
        },
        created_at: createdAtStats,
      },
    },
  },
} satisfies SyntheticProfile;

// Park–Miller arithmetic stays inside JavaScript's exact integer range.
export const createSeededRandom = (seed: number) => {
  let state = (seed % 2_147_483_646) + 1;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
};

export const apportion = (weights: number[], total: number) => {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (total === 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((weight) => (weight / weightSum) * total);
  const counts = exact.map(Math.floor);
  const remainder = total - counts.reduce((sum, count) => sum + count, 0);
  const order = exact.map((value, index) => ({
    index,
    fraction: value - Math.floor(value),
  }));
  order.sort(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  );
  for (const { index } of order.slice(0, remainder)) {
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
};

const BUCKET_RANGES = {
  "0": [0, 0],
  "1-10": [1, 10],
  "11-100": [11, 100],
  "101-1000": [101, 1000],
  "1001-10000": [1001, 10_000],
  "10001-100000": [10_001, 100_000],
  "100001-1000000": [100_001, 1_000_000],
  "1000001+": [1_000_001, 10_000_000],
} as const satisfies Record<
  (typeof WORKSPACE_BUCKETS)[number],
  readonly [number, number]
>;

type AllocateWorkspaceRowsOptions = {
  histogram: WorkspaceHistogram;
  rowCount: number;
  random: () => number;
};

// Bucket sizes are weights: scaling to a smaller test volume preserves relative skew, not absolute bucket boundaries.
export const allocateWorkspaceRows = ({
  histogram,
  rowCount,
  random,
}: AllocateWorkspaceRowsOptions) => {
  v.parse(workspaceHistogramSchema, histogram);
  v.parse(countSchema, rowCount);
  const weights: number[] = [];
  for (const bucket of WORKSPACE_BUCKETS) {
    const [minimum, maximum] = BUCKET_RANGES[bucket];
    for (let index = 0; index < histogram[bucket]; index++) {
      weights.push(
        minimum === 0
          ? 0
          : minimum + Math.floor(random() * (maximum - minimum + 1)),
      );
    }
  }
  v.parse(
    v.pipe(v.number(), v.minValue(rowCount > 0 ? 1 : 0)),
    weights.reduce((sum, weight) => sum + weight, 0),
  );
  return apportion(weights, rowCount);
};

type CreateColumnSlotsOptions = {
  stats: ColumnStats;
  rowCount: number;
  random: () => number;
};

const greatestCommonDivisor = (left: number, right: number): number => {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
};

// Slots describe synthetic categories only. The caller maps them to valid, invented domain values.
export const createColumnSlots = ({
  stats,
  rowCount,
  random,
}: CreateColumnSlotsOptions) => {
  v.parse(columnStatsSchema, stats);
  v.parse(countSchema, rowCount);
  const residualFrequency = Math.max(
    0,
    1 -
      stats.null_frac -
      stats.most_common_freqs.reduce((sum, frequency) => sum + frequency, 0),
  );
  const counts = apportion(
    [stats.null_frac, ...stats.most_common_freqs, residualFrequency],
    rowCount,
  );
  const nullCount = counts.at(0) ?? 0;
  const mcvCounts = counts.slice(1, -1);
  const residualCount = counts.at(-1) ?? 0;
  const estimatedDistinct =
    stats.n_distinct < 0 ? -stats.n_distinct * rowCount : stats.n_distinct;
  const distinctCount = Math.min(
    rowCount - nullCount,
    mcvCounts.length + residualCount,
    Math.max(
      mcvCounts.length + (residualCount > 0 ? 1 : 0),
      Math.round(estimatedDistinct),
    ),
  );
  let multiplier = Math.max(1, Math.floor(random() * rowCount));
  if (rowCount > 0) {
    while (greatestCommonDivisor(multiplier, rowCount) !== 1) {
      multiplier++;
    }
  }
  const offset = Math.floor(random() * rowCount);
  const boundaries: number[] = [];
  let end = nullCount;
  for (const count of mcvCounts) {
    end += count;
    boundaries.push(end);
  }
  const slotAt = (rowIndex: number) => {
    v.parse(v.pipe(countSchema, v.maxValue(rowCount - 1)), rowIndex);
    const position = (rowIndex * multiplier + offset) % rowCount;
    if (position < nullCount) {
      return null;
    }
    for (const [slot, boundary] of boundaries.entries()) {
      if (position < boundary) {
        return slot;
      }
    }
    return (
      mcvCounts.length + ((position - end) % (distinctCount - mcvCounts.length))
    );
  };
  return {
    nullCount,
    mcvCounts,
    distinctCount,
    multiplier,
    offset,
    residualStart: end,
    slotAt,
  };
};
