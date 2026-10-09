import * as v from "valibot";

import { ENTITY_KINDS } from "@stll/api-contract";
import {
  ENTITY_PRIORITIES,
  TASK_STATUSES,
} from "@stll/api-contract/entity-options";

import { LEGAL_LIST_ITEM_REVIEW_STATUSES } from "@/api/db/schema";
import { TASK_ASSIGNEE_ROLES } from "@/api/lib/entity-constants";

import type { QueryPerfProfileId } from "../profiles";
import {
  aggregateProfileSchema,
  HOT_TABLES,
  legalListsSchema,
  SYNTHETIC_LANGUAGES,
  WORKSPACE_BUCKETS,
} from "./profile";
import type { SyntheticProfile, WorkspaceHistogram } from "./profile";

const FREQUENCY_TOLERANCE = 1e-6;
const MAX_PUBLIC_COMMON_FREQUENCIES = 98;
const MAX_CAPTURE_AGE_DAYS = 31;
const DAY_MS = 86_400_000;
const SYNTHETIC_SEED = 0x57_e1_1a;
// Public fixture sizes are fixed at rounded policy values.
export const SMALL_TABLE_ROW_COUNTS = {
  entities: 600,
  entity_versions: 700,
  fields: 1000,
  search_documents: 600,
  extracted_content: 500,
  legal_list_items: 0,
  task_assignees: 10,
} as const satisfies Record<(typeof HOT_TABLES)[number], number>;
export const GROWTH_TABLE_ROW_COUNTS = {
  entities: 100_000,
  entity_versions: 1_000_000,
  fields: 1_000_000,
  search_documents: 100_000,
  extracted_content: 100_000,
  legal_list_items: 10_000,
  task_assignees: 2000,
} as const satisfies Record<(typeof HOT_TABLES)[number], number>;
const hasHundredthsPrecision = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) <= 1e-7;
const fractionSchema = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1),
  v.check(
    (value) => (value === 0 || value >= 0.01) && hasHundredthsPrecision(value),
    "Public fractions must use at most two decimal places; positive fractions must be at least 0.01",
  ),
);
const sourceHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const captureDateSchema = v.pipe(v.string(), v.isoDate());

const normalizedWorkspaceBucketsSchema = v.pipe(
  v.strictObject({
    "0": fractionSchema,
    "1-10": fractionSchema,
    "11-100": fractionSchema,
    "101-1000": fractionSchema,
    "1001-10000": fractionSchema,
    "10001-100000": fractionSchema,
    "100001-1000000": fractionSchema,
    "1000001+": fractionSchema,
  } as const satisfies Record<
    (typeof WORKSPACE_BUCKETS)[number],
    typeof fractionSchema
  >),
  v.check(
    (buckets) =>
      Math.abs(
        Object.values(buckets).reduce((sum, value) => sum + value, 0) - 1,
      ) <= FREQUENCY_TOLERANCE,
    "Normalized workspace buckets must sum to one",
  ),
);

const capturedColumnSchema = v.pipe(
  v.strictObject({
    nullFraction: fractionSchema,
    distinctFraction: fractionSchema,
    commonValueFrequencies: v.pipe(
      v.array(fractionSchema),
      v.maxLength(MAX_PUBLIC_COMMON_FREQUENCIES),
    ),
    widthFraction: fractionSchema,
  }),
  v.check(
    ({ nullFraction, commonValueFrequencies }) =>
      nullFraction +
        commonValueFrequencies.reduce((sum, value) => sum + value, 0) <=
      1 + FREQUENCY_TOLERANCE,
    "Null and common-value frequencies must sum to at most one",
  ),
);

const columnNames = {
  entities: [
    "kind",
    "status",
    "due_date",
    "priority",
    "parent_id",
    "created_at",
    "updated_at",
    "workspace_id",
    "list_item_type",
    "current_version_id",
  ],
  entity_versions: [
    "entity_id",
    "created_at",
    "deleted_at",
    "workspace_id",
    "version_number",
  ],
  fields: [
    "content",
    "file_id",
    "property_id",
    "workspace_id",
    "entity_version_id",
  ],
  search_documents: [
    "kind",
    "language",
    "entity_id",
    "updated_at",
    "workspace_id",
    "organization_id",
    "preview_generation",
  ],
  extracted_content: [
    "language",
    "entity_id",
    "char_count",
    "ocr_run_id",
    "extracted_at",
    "workspace_id",
    "source_file_id",
    "organization_id",
    "source_field_id",
    "source_entity_version_id",
  ],
  legal_list_items: [
    "entity_id",
    "workspace_id",
    "list_id",
    "section_id",
    "position",
    "description",
    "review_status",
    "added_by",
    "created_at",
    "updated_at",
  ],
  task_assignees: [
    "role",
    "user_id",
    "entity_id",
    "created_at",
    "workspace_id",
  ],
} as const satisfies Record<(typeof HOT_TABLES)[number], readonly string[]>;

const requiredColumns = {
  entities: [
    "kind",
    "status",
    "due_date",
    "priority",
    "parent_id",
    "created_at",
    "updated_at",
  ],
  entity_versions: ["created_at", "deleted_at"],
  fields: ["content"],
  search_documents: ["language", "updated_at"],
  extracted_content: ["language", "extracted_at"],
  legal_list_items: ["review_status", "created_at"],
  task_assignees: ["role", "created_at"],
} as const satisfies Record<(typeof HOT_TABLES)[number], readonly string[]>;

const tableSchema = (table: (typeof HOT_TABLES)[number]) =>
  v.pipe(
    v.strictObject({
      smallRowCount: v.literal(SMALL_TABLE_ROW_COUNTS[table]),
      normalizedWorkspaceBuckets: normalizedWorkspaceBucketsSchema,
      rowWidthFraction: fractionSchema,
      columns: v.record(v.picklist(columnNames[table]), capturedColumnSchema),
    }),
    v.check(
      ({ smallRowCount, normalizedWorkspaceBuckets, columns }) =>
        smallRowCount === 0
          ? normalizedWorkspaceBuckets["0"] === 1
          : normalizedWorkspaceBuckets["0"] < 1 &&
            requiredColumns[table].every((column) => column in columns),
      "Populated tables require nonempty workspace buckets and seed column statistics; empty tables require only the zero bucket",
    ),
  );

const legalListColumnAssumptionsSchema = v.strictObject({
  source: v.literal("assumed"),
  reason: v.literal("no observed population at capture"),
  nullableFraction: v.literal(0.5),
  widths: v.strictObject({
    uuid: v.literal(16),
    int4: v.literal(4),
    int8: v.literal(8),
    timestamptz: v.literal(8),
    shorttext: v.literal(24),
  }),
});

export const capturedProfileSchema = v.pipe(
  v.strictObject({
    captureDate: captureDateSchema,
    sourceHash: sourceHashSchema,
    priorCapture: v.nullable(
      v.strictObject({
        captureDate: captureDateSchema,
        sourceHash: sourceHashSchema,
        // Doubling requests a new aggregate review; it is not a CI freshness failure.
        volumeRatio: v.pipe(
          v.number(),
          v.finite(),
          v.minValue(0.01),
          v.check(
            hasHundredthsPrecision,
            "Public volume ratios must use at most two decimal places",
          ),
        ),
      }),
    ),
    smallWorkspaceCount: v.literal(200),
    legalLists: v.pipe(
      legalListsSchema,
      v.check(
        ({ source }) => source === "observed",
        "Small legal-list counts must be observed",
      ),
    ),
    growth: v.strictObject({
      workspaceCount: v.literal(2000),
      rowWidthBasisBytes: v.literal(4096),
      rowCounts: v.strictObject({
        entities: v.literal(GROWTH_TABLE_ROW_COUNTS.entities),
        entity_versions: v.literal(GROWTH_TABLE_ROW_COUNTS.entity_versions),
        fields: v.literal(GROWTH_TABLE_ROW_COUNTS.fields),
        search_documents: v.literal(GROWTH_TABLE_ROW_COUNTS.search_documents),
        extracted_content: v.literal(GROWTH_TABLE_ROW_COUNTS.extracted_content),
        legal_list_items: v.literal(GROWTH_TABLE_ROW_COUNTS.legal_list_items),
        task_assignees: v.literal(GROWTH_TABLE_ROW_COUNTS.task_assignees),
      }),
      legalLists: v.pipe(
        legalListsSchema,
        v.check(
          (lists) =>
            lists.source === "assumed" &&
            lists.usingWorkspaceCount === 400 &&
            lists.workspaceFraction === 0.2,
          "Growth legal lists require the declared 400-workspace assumption",
        ),
      ),
      legalListColumnAssumptions: legalListColumnAssumptionsSchema,
    }),
    tables: v.strictObject({
      entities: tableSchema("entities"),
      entity_versions: tableSchema("entity_versions"),
      fields: tableSchema("fields"),
      search_documents: tableSchema("search_documents"),
      extracted_content: tableSchema("extracted_content"),
      legal_list_items: tableSchema("legal_list_items"),
      task_assignees: tableSchema("task_assignees"),
    }),
  }),
  v.check(
    ({ captureDate, priorCapture }) =>
      priorCapture === null || priorCapture.captureDate < captureDate,
    "Prior capture must precede the small capture",
  ),
);

export type CapturedProfile = v.InferOutput<typeof capturedProfileSchema>;

export const parseCapturedProfile = (input: unknown, now = new Date()) =>
  v.parse(
    v.pipe(
      capturedProfileSchema,
      v.check(({ captureDate }) => {
        const currentDay = Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
        );
        return (
          currentDay - Date.parse(captureDate) <= MAX_CAPTURE_AGE_DAYS * DAY_MS
        );
      }, "Aggregate capture is older than 31 days; recapture is required"),
    ),
    input,
  );

const finiteDomains = {
  entities: {
    kind: ENTITY_KINDS.length,
    status: TASK_STATUSES.length,
    priority: ENTITY_PRIORITIES.length,
  },
  entity_versions: {},
  fields: {},
  search_documents: {
    kind: ENTITY_KINDS.length,
    language: SYNTHETIC_LANGUAGES.length,
  },
  extracted_content: { language: SYNTHETIC_LANGUAGES.length },
  legal_list_items: { review_status: LEGAL_LIST_ITEM_REVIEW_STATUSES.length },
  task_assignees: { role: TASK_ASSIGNEE_ROLES.length },
} as const satisfies Record<
  (typeof HOT_TABLES)[number],
  Record<string, number>
>;

type NormalizedWorkspaceBuckets = v.InferOutput<
  typeof normalizedWorkspaceBucketsSchema
>;
const deriveHistogram = (
  buckets: NormalizedWorkspaceBuckets,
  workspaceCount: number,
) => {
  const total = Object.values(buckets).reduce((sum, value) => sum + value, 0);
  const weights = WORKSPACE_BUCKETS.map((bucket) => ({
    bucket,
    exact: (buckets[bucket] / total) * workspaceCount,
  }));
  const histogram: WorkspaceHistogram = {
    "0": 0,
    "1-10": 0,
    "11-100": 0,
    "101-1000": 0,
    "1001-10000": 0,
    "10001-100000": 0,
    "100001-1000000": 0,
    "1000001+": 0,
  };
  for (const { bucket, exact } of weights) {
    histogram[bucket] = Math.floor(exact);
  }
  const remainder =
    workspaceCount -
    Object.values(histogram).reduce((sum, count) => sum + count, 0);
  weights.sort((left, right) => (right.exact % 1) - (left.exact % 1));
  for (const { bucket } of weights.slice(0, remainder)) {
    histogram[bucket]++;
  }
  return histogram;
};

type DeriveSyntheticProfileOptions = {
  profile: CapturedProfile;
  profileId: QueryPerfProfileId;
  now?: Date;
};

export const deriveSyntheticProfile = ({
  profile: input,
  profileId,
  now = new Date(),
}: DeriveSyntheticProfileOptions): SyntheticProfile => {
  const profile = parseCapturedProfile(input, now);
  const workspaceCount =
    profileId === "small"
      ? profile.smallWorkspaceCount
      : profile.growth.workspaceCount;
  const { widths, nullableFraction } =
    profile.growth.legalListColumnAssumptions;
  // Three required UUIDs, two required short texts, two timestamps, and three nullable columns.
  const assumedLegalItemWidth =
    widths.uuid * (3 + nullableFraction) +
    widths.shorttext * (2 + 2 * nullableFraction) +
    widths.timestamptz * 2;
  const tables: Record<string, SyntheticProfile["tables"]["entities"]> = {};
  for (const table of HOT_TABLES) {
    const captured = profile.tables[table];
    const rowCount =
      profileId === "small"
        ? captured.smallRowCount
        : profile.growth.rowCounts[table];
    const legalItemsAssumed =
      profileId === "growth" && table === "legal_list_items";
    const averageRowWidth =
      captured.rowWidthFraction * profile.growth.rowWidthBasisBytes;
    const columns: Record<
      string,
      SyntheticProfile["tables"]["entities"]["columns"][string]
    > = {};
    for (const [column, stats] of Object.entries(captured.columns)) {
      const frequencySum =
        stats.nullFraction +
        stats.commonValueFrequencies.reduce(
          (sum, frequency) => sum + frequency,
          0,
        );
      const correction = Math.max(1, frequencySum);
      const domain: Record<string, number> = finiteDomains[table];
      const cardinalityLimit = domain[column];
      columns[column] = {
        null_frac: stats.nullFraction / correction,
        // Rounded fixture sizes can exaggerate finite cardinalities; the declared domain is the upper bound.
        n_distinct:
          cardinalityLimit === undefined
            ? -stats.distinctFraction
            : Math.min(
                cardinalityLimit,
                Math.round(stats.distinctFraction * captured.smallRowCount),
              ),
        most_common_freqs: stats.commonValueFrequencies.map(
          (frequency) => frequency / correction,
        ),
        avg_width: stats.widthFraction * averageRowWidth,
      };
    }
    if (legalItemsAssumed) {
      const reviewCount = LEGAL_LIST_ITEM_REVIEW_STATUSES.length;
      columns["review_status"] = {
        null_frac: 0,
        n_distinct: reviewCount,
        most_common_freqs: LEGAL_LIST_ITEM_REVIEW_STATUSES.map(
          () => 1 / reviewCount,
        ),
        avg_width: widths.shorttext,
      };
      columns["created_at"] = {
        null_frac: 0,
        n_distinct: -1,
        most_common_freqs: [],
        avg_width: widths.timestamptz,
      };
    }
    // Empty captures have no pg_stats rows. These all-null runtime columns are explicit synthetic assumptions, never captured observations.
    if (rowCount === 0) {
      for (const column of requiredColumns[table]) {
        columns[column] ??= {
          null_frac: 1,
          n_distinct: 0,
          most_common_freqs: [],
          avg_width: 0,
        };
      }
    }
    tables[table] = {
      rowCount,
      averageRowWidth: legalItemsAssumed
        ? assumedLegalItemWidth
        : averageRowWidth,
      workspaceHistogram: deriveHistogram(
        legalItemsAssumed
          ? profile.tables.entities.normalizedWorkspaceBuckets
          : captured.normalizedWorkspaceBuckets,
        workspaceCount,
      ),
      columns,
    };
  }
  return v.parse(aggregateProfileSchema, {
    status: "reviewed-aggregate",
    seed: SYNTHETIC_SEED,
    tables,
    legalLists:
      profileId === "small" ? profile.legalLists : profile.growth.legalLists,
  });
};
