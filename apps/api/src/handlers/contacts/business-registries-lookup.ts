import { Result } from "better-result";
import { t } from "elysia";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { getOrganizationRegistryHandler } from "@/api/lib/business-registries/credentials";
import {
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
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  registry: BusinessRegistrySlug;
  q: string;
};

// Native-tool preferences control discovery, not access to public records.
export const lookupBusinessRegistryShared = async ({
  scopedDb,
  organizationId,
  registry,
  q,
}: LookupBusinessRegistryProps): Promise<
  Result<RegistryLookupResponse, HandlerError>
> => {
  const configured = await Result.tryPromise({
    try: async () =>
      await getOrganizationRegistryHandler({
        scopedDb,
        organizationId,
        registry,
      }),
    catch: (cause) =>
      new HandlerError({
        status: 500,
        message: "Could not load registry configuration",
        cause,
      }),
  });
  if (configured.isErr()) {
    return Result.err(configured.error);
  }
  const handler = configured.value;
  if (!handler.isDeployAvailable()) {
    return Result.err(
      new HandlerError({
        status: 428,
        code: "registry_configuration_required",
        message: `Configure credentials for the '${registry}' registry before searching`,
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
  async function* ({ query, scopedDb, session }) {
    const result = await lookupBusinessRegistryShared({
      scopedDb,
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
