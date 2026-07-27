import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { usagePolicies } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

/**
 * List the publicly visible usage-policy catalog (plans and add-on
 * packs) for the checkout picker.
 *
 * The catalog is deployment-owned config seeded by the operator
 * (`STELLA_USAGE_POLICY_SEEDS`), so the result set is bounded by that
 * config, not by tenant data; `MAX_CATALOG_ROWS` is a hard ceiling,
 * not a page size, which is why this endpoint returns a plain list
 * instead of the cursor `Page<T>` envelope.
 */

const MAX_CATALOG_ROWS = 100;

const config = {
  description:
    "List the plans and add-on packs available to this deployment: " +
    "display name, description, included monthly usage units, price " +
    "display fields, and whether hosted checkout can be started for " +
    "the entry. Requires organization-settings management access.",
  // Same gate as the other hosted-billing endpoints: the catalog is
  // only actionable by whoever can start a checkout.
  permissions: { organizationSettings: ["update"] },
  access: "read",
  mcp: { type: "internal", reason: "hosted_billing" },
} satisfies HandlerConfig;

type UsagePolicyRow = typeof usagePolicies.$inferSelect;

type CatalogQueryRow = Pick<
  UsagePolicyRow,
  | "id"
  | "displayName"
  | "description"
  | "kind"
  | "monthlyUsageUnits"
  | "priceAmountCents"
  | "priceCurrency"
  | "billingInterval"
  | "sortOrder"
  | "hostedPolicyRef"
> & { key: UsagePolicyRow["policyKey"] };

type UsagePolicyCatalogEntry = Omit<CatalogQueryRow, "hostedPolicyRef"> & {
  hostedCheckoutAvailable: boolean;
};

type ListPoliciesResult = { policies: UsagePolicyCatalogEntry[] };

// Hoisted read with a sealed result type: the route mount consumes
// `ListPoliciesResult` instead of re-instantiating the query-builder
// projection generics (measured against the typecheck baseline).
export const readUsagePolicyCatalog = async function* ({
  safeDb,
}: {
  safeDb: SafeDb;
}) {
  const rows = yield* Result.await(
    safeDb(
      async (tx): Promise<CatalogQueryRow[]> =>
        await tx
          .select({
            id: usagePolicies.id,
            key: usagePolicies.policyKey,
            displayName: usagePolicies.displayName,
            description: usagePolicies.description,
            kind: usagePolicies.kind,
            monthlyUsageUnits: usagePolicies.monthlyUsageUnits,
            priceAmountCents: usagePolicies.priceAmountCents,
            priceCurrency: usagePolicies.priceCurrency,
            billingInterval: usagePolicies.billingInterval,
            sortOrder: usagePolicies.sortOrder,
            hostedPolicyRef: usagePolicies.hostedPolicyRef,
          })
          .from(usagePolicies)
          .where(
            and(
              eq(usagePolicies.active, true),
              eq(usagePolicies.visibility, "public"),
            ),
          )
          .orderBy(asc(usagePolicies.sortOrder), asc(usagePolicies.id))
          .limit(MAX_CATALOG_ROWS),
    ),
  );

  // The provider reference itself stays server-side; the picker
  // only needs to know whether checkout can be started.
  const policies: UsagePolicyCatalogEntry[] = rows.map(
    ({ hostedPolicyRef, ...policy }) =>
      Object.assign(policy, {
        hostedCheckoutAvailable: hostedPolicyRef !== null,
      }),
  );

  const result: ListPoliciesResult = { policies };
  return Result.ok(result);
};

const listPolicies = createSafeRootHandler(
  config,
  async function* ({ safeDb }) {
    return yield* readUsagePolicyCatalog({ safeDb });
  },
);

export default listPolicies;
