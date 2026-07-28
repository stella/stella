import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readUsagePolicyCatalog } from "@/api/lib/usage/policy-catalog";

/**
 * List the publicly visible usage-policy catalog (plans and add-on
 * packs) for the checkout picker. The read lives in
 * `lib/usage/policy-catalog.ts` so other consumers never import an
 * endpoint module.
 */

const config = {
  description:
    "List the plans and add-on packs available to this deployment: " +
    "display name, description, included monthly usage units, price " +
    "display data, and the hosted-checkout availability state for the " +
    "entry. The catalog is deployment-level: add-on packs " +
    "additionally require the organization to hold an active hosted " +
    "subscription (pair with GET /usage/entitlement). Requires " +
    "organization-settings management access.",
  // Same gate as the other hosted-billing endpoints: the catalog is
  // only actionable by whoever can start a checkout.
  permissions: { organizationSettings: ["update"] },
  access: "read",
  mcp: { type: "internal", reason: "hosted_billing" },
} satisfies HandlerConfig;

const listPolicies = createSafeRootHandler(
  config,
  async function* ({ safeDb }) {
    return yield* readUsagePolicyCatalog({ safeDb });
  },
);

export default listPolicies;
