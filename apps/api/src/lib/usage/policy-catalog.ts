import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { usagePolicies } from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { getApiCredentials } from "@/api/lib/hosted-usage-provider/config";

/**
 * Read the publicly visible usage-policy catalog (plans and add-on
 * packs) for the checkout picker.
 *
 * The catalog is deployment-owned config seeded by the operator
 * (`STELLA_USAGE_POLICY_SEEDS`, bounded at the seed boundary), so the
 * result set is bounded by that config, not by tenant data;
 * `MAX_CATALOG_ROWS` is a hard ceiling matching the seed bound, not a
 * page size, which is why this read returns a plain list instead of
 * the cursor `Page<T>` envelope.
 */

export const MAX_CATALOG_ROWS = 100;

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

export const readUsagePolicyCatalog = async function* ({
  safeDb,
}: {
  safeDb: SafeDb;
}): SafeHandlerGenerator<ListPoliciesResult> {
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

  // Checkout requires both a provider reference on the policy AND a
  // configured hosted provider on this deployment; advertising either
  // alone would send the picker into a setup call that deterministically
  // fails. The provider reference itself stays server-side.
  const providerConfigured = getApiCredentials() !== null;
  const policies: UsagePolicyCatalogEntry[] = rows.map(
    ({ hostedPolicyRef, ...policy }) =>
      Object.assign(policy, {
        hostedCheckoutAvailable: providerConfigured && Boolean(hostedPolicyRef),
      }),
  );

  return Result.ok({ policies });
};
