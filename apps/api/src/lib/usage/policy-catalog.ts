import { panic, Result } from "better-result";
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

export type UsagePolicyCatalogPrice = {
  amountCents: NonNullable<CatalogQueryRow["priceAmountCents"]>;
  currency: NonNullable<CatalogQueryRow["priceCurrency"]>;
  billingInterval: NonNullable<CatalogQueryRow["billingInterval"]>;
};

export type UsagePolicyCatalogHostedCheckout =
  | { status: "available" }
  | {
      status: "unavailable";
      reason: "provider_unavailable" | "policy_unavailable";
    };

export type UsagePolicyCatalogEntry = Pick<
  CatalogQueryRow,
  | "id"
  | "key"
  | "displayName"
  | "description"
  | "kind"
  | "monthlyUsageUnits"
  | "sortOrder"
> & {
  price: UsagePolicyCatalogPrice | null;
  hostedCheckout: UsagePolicyCatalogHostedCheckout;
};

type ListPoliciesResult = { policies: UsagePolicyCatalogEntry[] };

const catalogPrice = ({
  priceAmountCents,
  priceCurrency,
  billingInterval,
}: CatalogQueryRow): UsagePolicyCatalogPrice | null => {
  if (
    priceAmountCents === null &&
    priceCurrency === null &&
    billingInterval === null
  ) {
    return null;
  }

  if (
    priceAmountCents === null ||
    priceCurrency === null ||
    billingInterval === null
  ) {
    return panic("Usage policy has incomplete catalog price fields");
  }

  return {
    amountCents: priceAmountCents,
    currency: priceCurrency,
    billingInterval,
  };
};

const hostedCheckout = (
  hostedPolicyRef: CatalogQueryRow["hostedPolicyRef"],
  providerConfigured: boolean,
): UsagePolicyCatalogHostedCheckout => {
  if (!providerConfigured) {
    return { status: "unavailable", reason: "provider_unavailable" };
  }
  if (!hostedPolicyRef) {
    return { status: "unavailable", reason: "policy_unavailable" };
  }
  return { status: "available" };
};

export const buildUsagePolicyCatalogEntry = (
  row: CatalogQueryRow,
  providerConfigured: boolean,
): UsagePolicyCatalogEntry => ({
  id: row.id,
  key: row.key,
  displayName: row.displayName,
  description: row.description,
  kind: row.kind,
  monthlyUsageUnits: row.monthlyUsageUnits,
  sortOrder: row.sortOrder,
  price: catalogPrice(row),
  hostedCheckout: hostedCheckout(row.hostedPolicyRef, providerConfigured),
});

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
  const policies = rows.map((row) =>
    buildUsagePolicyCatalogEntry(row, providerConfigured),
  );

  return Result.ok({ policies });
};
