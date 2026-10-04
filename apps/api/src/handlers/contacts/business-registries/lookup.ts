import { Result } from "better-result";
import { t } from "elysia";

import {
  BUSINESS_REGISTRY_LOOKUP_DETAILS,
  type BusinessRegistryLookupDetail,
} from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  BUSINESS_REGISTRY_SLUGS,
  LOOKUP_DETAIL_DESCRIPTION,
} from "@/api/lib/business-registries/dispatch";
import { lookupBusinessRegistryShared } from "@/api/lib/business-registries/registry-lookup";
import {
  ACTION_COST_CALL_KIND,
  actionRequestObserver,
} from "@/api/lib/usage/action-costs/context";

// A tuple of literals keeps each option in the route types, where a mapped
// array widens to `never`; `satisfies` fails when the contract list changes.
const [standardDetail, fullDetail] =
  BUSINESS_REGISTRY_LOOKUP_DETAILS satisfies readonly [
    BusinessRegistryLookupDetail,
    BusinessRegistryLookupDetail,
  ];

const querySchema = t.Object({
  registry: t.UnionEnum(BUSINESS_REGISTRY_SLUGS, {
    description: "Business register to query",
  }),
  q: t.String({
    minLength: 1,
    maxLength: 256,
    description:
      "Canonical identifier (e.g. company number, VAT number) or company name",
  }),
  detail: t.Optional(
    t.Union([t.Literal(standardDetail), t.Literal(fullDetail)], {
      description: LOOKUP_DETAIL_DESCRIPTION,
    }),
  ),
});

const businessRegistriesLookup = createSafeRootHandler(
  {
    description:
      "Look up a company in a public business register. Pass a canonical " +
      "identifier (company/registration number, VAT number) for an exact " +
      "match, or a company name to search where the register supports it.",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "tool", name: "lookup_business_registry" },
    access: "read",
    query: querySchema,
  },
  async function* ({ query, scopedDb, session }) {
    const observer = actionRequestObserver(
      session.activeOrganizationId,
      ACTION_COST_CALL_KIND.registryRequest,
    );
    const result = await lookupBusinessRegistryShared({
      observer,
      permit: grantThirdPartyOutboundPermit(),
      scopedDb,
      organizationId: session.activeOrganizationId,
      registry: query.registry,
      q: query.q,
      detail: query.detail,
    });
    if (Result.isError(result)) {
      return yield* Result.err(result.error);
    }
    return Result.ok(result.value);
  },
);

export default businessRegistriesLookup;
