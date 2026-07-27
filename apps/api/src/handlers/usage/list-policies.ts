import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

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

const listPolicies = createSafeRootHandler(
  config,
  async function* ({ safeDb }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
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

    return Result.ok({
      policies: rows.map(({ hostedPolicyRef, ...policy }) => ({
        ...policy,
        // The provider reference itself stays server-side; the picker
        // only needs to know whether checkout can be started.
        hostedCheckoutAvailable: hostedPolicyRef !== null,
      })),
    });
  },
);

export default listPolicies;
