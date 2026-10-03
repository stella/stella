/**
 * Seed usage policies from deployment-owned JSON config.
 *
 * Idempotent: repeated runs upsert by `policyKey` and
 * leave existing rows in place. Source defaults are intentionally
 * empty so the public repo does not encode an operator policy.
 */

import { Result } from "better-result";
import {
  and,
  eq,
  inArray,
  notInArray,
  sql,
  getTableColumns,
} from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { openSync, closeSync, writeFileSync } from "node:fs";
import * as v from "valibot";

import {
  USAGE_POLICY_BILLING_INTERVALS,
  USAGE_POLICY_KINDS,
  USAGE_POLICY_PRICE_BASES,
  USAGE_POLICY_VISIBILITIES,
  usagePolicies,
} from "@/api/db/schema";
import { MAX_CATALOG_ROWS } from "@/api/lib/usage/policy-catalog";

// PostgreSQL int4 ceiling: values beyond it would fail at write time
// with an opaque driver error instead of a seed validation message.
const PG_INT4_MAX = 2_147_483_647;

const usagePolicySeedSchema = v.pipe(
  v.strictObject({
    key: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)),
    displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
    description: v.optional(v.nullable(v.pipe(v.string(), v.trim())), null),
    kind: v.optional(v.picklist(USAGE_POLICY_KINDS), "subscription"),
    monthlyUsageUnits: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(0),
      v.maxValue(PG_INT4_MAX),
    ),
    hostedPolicyRef: v.optional(v.nullable(v.string()), null),
    priceAmountCents: v.optional(
      v.nullable(
        v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PG_INT4_MAX)),
      ),
      null,
    ),
    priceCurrency: v.optional(
      // Strict ISO 4217 alpha code: a malformed value would make the
      // picker's Intl.NumberFormat throw at render time.
      v.nullable(v.pipe(v.string(), v.trim(), v.regex(/^[A-Z]{3}$/u))),
      null,
    ),
    billingInterval: v.optional(
      v.nullable(v.picklist(USAGE_POLICY_BILLING_INTERVALS)),
      null,
    ),
    priceBasis: v.optional(v.picklist(USAGE_POLICY_PRICE_BASES), "flat"),
    storageBytesPerAssignment: v.optional(
      v.nullable(
        v.pipe(
          v.number(),
          v.integer(),
          v.minValue(0),
          v.maxValue(Number.MAX_SAFE_INTEGER),
        ),
      ),
      null,
    ),
    serviceActionsPerPeriod: v.optional(
      v.nullable(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(PG_INT4_MAX)),
      ),
      null,
    ),
    maxMembers: v.optional(
      v.nullable(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(PG_INT4_MAX)),
      ),
      null,
    ),
    visibility: v.optional(v.picklist(USAGE_POLICY_VISIBILITIES), "hidden"),
    sortOrder: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(-PG_INT4_MAX - 1),
        v.maxValue(PG_INT4_MAX),
      ),
      0,
    ),
  }),
  v.check(
    (seed) =>
      (seed.priceAmountCents === null) === (seed.priceCurrency === null) &&
      (seed.priceAmountCents === null) === (seed.billingInterval === null),
    "price fields must be set together (amount + currency + interval)",
  ),
);

// Bounded to the catalog read ceiling (MAX_CATALOG_ROWS): an oversized
// operator config fails loudly at seed time instead of silently
// truncating the checkout picker.
const usagePolicySeedsSchema = v.pipe(
  v.array(usagePolicySeedSchema),
  v.maxLength(MAX_CATALOG_ROWS),
);

type UsagePolicySeed = v.InferOutput<typeof usagePolicySeedSchema>;

export const parseSeeds = (input: string) => {
  const parsed = JSON.parse(input);
  return v.parse(usagePolicySeedsSchema, parsed);
};

type SeedRowResult =
  | {
      policyKey: string;
      outcome: "inserted" | "updated" | "unchanged" | "hidden";
    }
  | { policyKey: string; outcome: "failed"; reason: string };

type SeedPoliciesOptions = {
  db: Pick<PgAsyncDatabase<PgQueryResultHKT>, "transaction">;
  seeds: UsagePolicySeed[];
};

const seedPolicies = async ({ db, seeds }: SeedPoliciesOptions) => {
  const rows: SeedRowResult[] = [];
  let pendingKey = seeds.at(0)?.key;
  let pendingHiddenKeys: string[] = [];
  const result = await Result.tryPromise(() =>
    db.transaction(async (tx) => {
      for (const seedPolicy of seeds) {
        pendingKey = seedPolicy.key;
        const values = {
          policyKey: seedPolicy.key,
          displayName: seedPolicy.displayName,
          description: seedPolicy.description,
          kind: seedPolicy.kind,
          monthlyUsageUnits: seedPolicy.monthlyUsageUnits,
          hostedPolicyRef: seedPolicy.hostedPolicyRef,
          priceAmountCents: seedPolicy.priceAmountCents,
          priceCurrency: seedPolicy.priceCurrency,
          billingInterval: seedPolicy.billingInterval,
          priceBasis: seedPolicy.priceBasis,
          storageBytesPerAssignment:
            seedPolicy.storageBytesPerAssignment === null
              ? null
              : BigInt(seedPolicy.storageBytesPerAssignment),
          maxMembers: seedPolicy.maxMembers,
          serviceActionsPerPeriod: seedPolicy.serviceActionsPerPeriod,
          visibility: seedPolicy.visibility,
          sortOrder: seedPolicy.sortOrder,
        };
        const { policyKey: _policyKey, ...set } = values;
        // Derive comparison columns from the update projection: newly seeded
        // fields automatically participate in unchanged detection.
        const changed = Object.entries(getTableColumns(usagePolicies))
          .filter(([key]) => key in set)
          .map(
            ([, column]) =>
              sql`${column} IS DISTINCT FROM excluded.${sql.identifier(column.name)}`,
          );
        const written = await tx
          .insert(usagePolicies)
          .values(values)
          .onConflictDoUpdate({
            target: usagePolicies.policyKey,
            set,
            setWhere: sql.join(changed, sql` OR `),
          })
          .returning({ inserted: sql<boolean>`xmax = 0` });
        const row = written.at(0);
        pendingKey = undefined;
        if (row === undefined) {
          rows.push({ policyKey: seedPolicy.key, outcome: "unchanged" });
          continue;
        }
        rows.push({
          policyKey: seedPolicy.key,
          outcome: row.inserted ? "inserted" : "updated",
        });
      }
      if (seeds.length === 0) {
        return;
      }
      const retiring = and(
        notInArray(
          usagePolicies.policyKey,
          seeds.map((seedPolicy) => seedPolicy.key),
        ),
        eq(usagePolicies.visibility, "public"),
      );
      // Lock retirement candidates so failure evidence includes every attempted
      // row, even when the bulk update itself throws before RETURNING.
      const candidates = await tx
        .select({ policyKey: usagePolicies.policyKey })
        .from(usagePolicies)
        .where(retiring)
        .for("update");
      pendingHiddenKeys = candidates.map(({ policyKey }) => policyKey);
      if (pendingHiddenKeys.length === 0) {
        return;
      }
      const hidden = await tx
        .update(usagePolicies)
        .set({ visibility: "hidden" })
        .where(inArray(usagePolicies.policyKey, pendingHiddenKeys))
        .returning({ policyKey: usagePolicies.policyKey });
      pendingHiddenKeys = [];
      for (const row of hidden) {
        rows.push({ policyKey: row.policyKey, outcome: "hidden" });
      }
    }),
  );
  if (result.isOk()) {
    return { status: "complete", rows } as const;
  }
  // All attempted mutations rolled back, including any rows before the failure.
  const failedRows: SeedRowResult[] = rows.map(({ policyKey }) => ({
    policyKey,
    outcome: "failed",
    reason: "Transaction rolled back.",
  }));
  if (pendingKey !== undefined) {
    failedRows.push({
      policyKey: pendingKey,
      outcome: "failed",
      reason: "Policy write failed; transaction rolled back.",
    });
  }
  for (const policyKey of pendingHiddenKeys) {
    failedRows.push({
      policyKey,
      outcome: "failed",
      reason: "Retirement failed; transaction rolled back.",
    });
  }
  return { status: "failed", rows: failedRows } as const;
};

type SeedReportOptions = {
  input: string;
  resultsPath: string;
  openDb: () => SeedPoliciesOptions["db"] | Promise<SeedPoliciesOptions["db"]>;
};

export const runSeedReport = async ({
  input,
  resultsPath,
  openDb,
}: SeedReportOptions) => {
  // Refuse an existing path and verify writability before opening the database.
  const fd = openSync(resultsPath, "wx", 0o600);
  let seeds: UsagePolicySeed[] = [];
  const result = await Result.tryPromise(async () => {
    seeds = parseSeeds(input);
    if (seeds.length === 0) {
      return { status: "complete", rows: [] } as const;
    }
    return await seedPolicies({ db: await openDb(), seeds });
  });
  const report = result.isOk()
    ? result.value
    : ({
        status: "failed",
        rows: seeds.map(
          ({ key }) =>
            ({
              policyKey: key,
              outcome: "failed",
              reason: "Seed failed; check configuration and database access.",
            }) as const,
        ),
      } as const);
  const lines = report.rows.map((row) => JSON.stringify(row)).join("\n");
  try {
    writeFileSync(fd, lines.length === 0 ? "" : `${lines}\n`);
  } finally {
    closeSync(fd);
  }
  return { ...report, seeded: seeds.length, lines };
};
