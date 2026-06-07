/**
 * Seed usage policies from deployment-owned JSON config.
 *
 * Idempotent: repeated runs upsert by `policyKey` and
 * leave existing rows in place. Source defaults are intentionally
 * empty so the public repo does not encode an operator policy.
 */

import * as v from "valibot";

import { rootDb } from "@/api/db/root";
import { usagePolicies } from "@/api/db/schema";
import { env } from "@/api/env";

const usagePolicySeedSchema = v.strictObject({
  key: v.pipe(v.string(), v.trim(), v.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u)),
  displayName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(128)),
  monthlyUsageUnits: v.pipe(v.number(), v.integer(), v.minValue(0)),
  hostedPolicyRef: v.optional(v.nullable(v.string()), null),
});

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
    await rootDb
      .insert(usagePolicies)
      .values({
        policyKey: seedPolicy.key,
        displayName: seedPolicy.displayName,
        monthlyUsageUnits: seedPolicy.monthlyUsageUnits,
        hostedPolicyRef: seedPolicy.hostedPolicyRef,
      })
      .onConflictDoUpdate({
        target: usagePolicies.policyKey,
        set: {
          displayName: seedPolicy.displayName,
          monthlyUsageUnits: seedPolicy.monthlyUsageUnits,
          hostedPolicyRef: seedPolicy.hostedPolicyRef,
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
