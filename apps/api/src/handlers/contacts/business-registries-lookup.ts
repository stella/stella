import { Result } from "better-result";
import { t } from "elysia";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import { isNativeToolEnabledForOrg } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUSINESS_REGISTRY_DISPATCH,
  BUSINESS_REGISTRY_SLUGS,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import type {
  BusinessRegistrySlug,
  RegistryLookupResponse,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

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
});

export type LookupBusinessRegistryProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  registry: BusinessRegistrySlug;
  q: string;
};

// Shared business-registry lookup logic reused by the HTTP handler and
// the `lookup_business_registry` MCP tool, so both apply identical
// deployment and per-organization gating.
export const lookupBusinessRegistryShared = async ({
  safeDb,
  organizationId,
  registry,
  q,
}: LookupBusinessRegistryProps): Promise<
  Result<RegistryLookupResponse, HandlerError | SafeDbError>
> => {
  const handler = BUSINESS_REGISTRY_DISPATCH[registry];
  if (!handler.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: `Registry '${registry}' is not configured for this deployment`,
      }),
    );
  }

  const settingsResult = await safeDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        practiceJurisdictions: true,
        nativeToolOverrides: true,
      },
    }),
  );
  if (Result.isError(settingsResult)) {
    return Result.err(settingsResult.error);
  }
  const settings = settingsResult.value;

  const enabled = isNativeToolEnabledForOrg({
    slug: handler.nativeToolSlug,
    practiceJurisdictions: arrayOrEmpty(settings?.practiceJurisdictions),
    nativeToolOverrides: settings?.nativeToolOverrides ?? {},
  });
  if (!enabled) {
    return Result.err(
      new HandlerError({
        status: 403,
        message: `Registry '${registry}' is disabled for this organization`,
      }),
    );
  }

  const result = await executeRegistryLookup({ handler, query: q });
  if (result instanceof HandlerError) {
    return Result.err(result);
  }
  return Result.ok(result);
};

const businessRegistriesLookup = createSafeRootHandler(
  {
    description:
      "Look up a company in a public business register (ARES, Brreg, " +
      "Companies House, EDGAR, GCIS, KRS, ORSR, PRH, recherche-entreprises, " +
      "or VIES). Pass a canonical identifier (company/registration number, " +
      "VAT number) for an exact match, or a company name to search where the " +
      "register supports it. Returns registered names, addresses, and " +
      "registry-specific details.",
    permissions: { workspace: ["read"] },
    mcp: { type: "tool", name: "lookup_business_registry" },
    access: "read",
    query: querySchema,
  },
  async function* ({ query, safeDb, session }) {
    const result = await lookupBusinessRegistryShared({
      safeDb,
      organizationId: session.activeOrganizationId,
      registry: query.registry,
      q: query.q,
    });
    if (Result.isError(result)) {
      return yield* Result.err(result.error);
    }
    return Result.ok(result.value);
  },
);

export default businessRegistriesLookup;
