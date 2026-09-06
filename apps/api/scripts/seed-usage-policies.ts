/**
 * Seed usage policies from deployment-owned JSON config.
 *
 * Idempotent: repeated runs upsert by `policyKey` and
 * leave existing rows in place. Source defaults are intentionally
 * empty so the public repo does not encode an operator policy.
 */

import { and, eq, notInArray } from "drizzle-orm";
import * as v from "valibot";

import { rootDb } from "@/api/db/root";
import {
  USAGE_POLICY_BILLING_INTERVALS,
  USAGE_POLICY_KINDS,
  USAGE_POLICY_PRICE_BASES,
  USAGE_POLICY_VISIBILITIES,
  usagePolicies,
} from "@/api/db/schema";
import { env } from "@/api/env";
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

const parseSeeds = (): UsagePolicySeed[] => {
  const parsed = JSON.parse(env.STELLA_USAGE_POLICY_SEEDS);
  return v.parse(usagePolicySeedsSchema, parsed);
};

const seed = async (): Promise<void> => {
  const seeds = parseSeeds();
  if (seeds.length === 0) {
    console.log("no usage policies configured");
    return;
  }

  // One transaction for upserts + retirement: a mid-run failure (e.g.
  // two seeds colliding on the unique hosted-provider reference) must
  // not leave the catalog as a partial mix of new and stale entries.
  await rootDb.transaction(async (tx) => {
    for (const seedPolicy of seeds) {
      // Upsert by policyKey so edits to the config (display name, units,
      // or a newly created hostedPolicyRef) propagate to the existing row
      // instead of being skipped.
      await tx
        .insert(usagePolicies)
        .values({
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
          visibility: seedPolicy.visibility,
          sortOrder: seedPolicy.sortOrder,
        })
        .onConflictDoUpdate({
          target: usagePolicies.policyKey,
          set: {
            displayName: seedPolicy.displayName,
            description: seedPolicy.description,
            kind: seedPolicy.kind,
            monthlyUsageUnits: seedPolicy.monthlyUsageUnits,
            hostedPolicyRef: seedPolicy.hostedPolicyRef,
            priceAmountCents: seedPolicy.priceAmountCents,
            priceCurrency: seedPolicy.priceCurrency,
            billingInterval: seedPolicy.billingInterval,
            priceBasis: seedPolicy.priceBasis,
            visibility: seedPolicy.visibility,
            sortOrder: seedPolicy.sortOrder,
          },
        });
      console.log(
        `seeded ${seedPolicy.key}: ${seedPolicy.monthlyUsageUnits} units/seat${
          seedPolicy.hostedPolicyRef
            ? " (hosted policy reference configured)"
            : ""
        }`,
      );
    }

    // The seed config is the single source of the PUBLIC catalog: rows
    // whose key left the config are hidden (not deleted or deactivated —
    // existing entitlements keep referencing them), so repeated
    // reconfiguration cannot grow the visible catalog past the seed
    // bound. The empty-config early return above deliberately leaves
    // everything untouched.
    const seededKeys = seeds.map((seedPolicy) => seedPolicy.key);
    const hidden = await tx
      .update(usagePolicies)
      .set({ visibility: "hidden" })
      .where(
        and(
          notInArray(usagePolicies.policyKey, seededKeys),
          eq(usagePolicies.visibility, "public"),
        ),
      )
      .returning({ policyKey: usagePolicies.policyKey });
    for (const row of hidden) {
      console.log(`hid retired policy ${row.policyKey} (absent from seeds)`);
    }
  });
};

await seed();
process.exit(0);
