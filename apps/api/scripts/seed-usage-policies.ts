/**
 * Seed usage policies from deployment-owned JSON config.
 *
 * Idempotent: repeated runs upsert by `policyKey` and
 * leave existing rows in place. Source defaults are intentionally
 * empty so the public repo does not encode an operator policy.
 */

import * as v from "valibot";

import { rootDb } from "@/api/db/root";
import {
  USAGE_POLICY_BILLING_INTERVALS,
  USAGE_POLICY_KINDS,
  USAGE_POLICY_VISIBILITIES,
  usagePolicies,
} from "@/api/db/schema";
import { env } from "@/api/env";

const usagePolicySeedSchema = v.pipe(
  v.strictObject({
    key: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)),
    displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
    description: v.optional(v.nullable(v.pipe(v.string(), v.trim())), null),
    kind: v.optional(v.picklist(USAGE_POLICY_KINDS), "subscription"),
    monthlyUsageUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
    hostedPolicyRef: v.optional(v.nullable(v.string()), null),
    priceAmountCents: v.optional(
      v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0))),
      null,
    ),
    priceCurrency: v.optional(
      v.nullable(v.pipe(v.string(), v.trim(), v.length(3))),
      null,
    ),
    billingInterval: v.optional(
      v.nullable(v.picklist(USAGE_POLICY_BILLING_INTERVALS)),
      null,
    ),
    visibility: v.optional(v.picklist(USAGE_POLICY_VISIBILITIES), "hidden"),
    sortOrder: v.optional(v.pipe(v.number(), v.integer()), 0),
  }),
  v.check(
    (seed) =>
      (seed.priceAmountCents === null) === (seed.priceCurrency === null) &&
      (seed.priceAmountCents === null || seed.billingInterval !== null),
    "price fields must be set together (amount + currency + interval)",
  ),
);

const usagePolicySeedsSchema = v.array(usagePolicySeedSchema);

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

  for (const seedPolicy of seeds) {
    // Upsert by policyKey so edits to the config (display name, units,
    // or a newly created hostedPolicyRef) propagate to the existing row
    // instead of being skipped.
    // oxlint-disable-next-line no-await-in-loop -- sequential seeding preserves upsert order across policies
    await rootDb
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
};

await seed();
process.exit(0);
