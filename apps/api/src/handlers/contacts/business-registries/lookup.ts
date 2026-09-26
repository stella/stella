import { Result } from "better-result";
import { t } from "elysia";

import {
  BUSINESS_REGISTRY_LOOKUP_DETAILS,
  type BusinessRegistryLookupDetail,
} from "@stll/api-contract";

import type { ScopedDb } from "@/api/db/safe-db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { getOrganizationRegistryHandler } from "@/api/lib/business-registries/credentials";
import {
  BUSINESS_REGISTRY_SLUGS,
  executeRegistryLookup,
  LOOKUP_DETAIL_DESCRIPTION,
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
  detail: t.Optional(
    t.Union(
      BUSINESS_REGISTRY_LOOKUP_DETAILS.map((detail) => t.Literal(detail)),
      { description: LOOKUP_DETAIL_DESCRIPTION },
    ),
  ),
});

export type LookupBusinessRegistryProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  registry: BusinessRegistrySlug;
  q: string;
  detail?: BusinessRegistryLookupDetail | undefined;
  executeLookup?: typeof executeRegistryLookup | undefined;
};

// Native-tool preferences control discovery, not access to public records.
export const lookupBusinessRegistryShared = async ({
  scopedDb,
  organizationId,
  registry,
  q,
  detail,
  executeLookup = executeRegistryLookup,
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

  const result = await executeLookup({ handler, query: q, detail });
  if (result instanceof HandlerError) {
    return Result.err(result);
  }
  return Result.ok(result);
};

const businessRegistriesLookup = createSafeRootHandler(
  {
    description:
      "Look up a company in a public business register. Pass a canonical " +
      "identifier (company/registration number, VAT number) for an exact " +
      "match, or a company name to search where the register supports it.",
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
      detail: query.detail,
    });
    if (Result.isError(result)) {
      return yield* Result.err(result.error);
    }
    return Result.ok(result.value);
  },
);

export default businessRegistriesLookup;
