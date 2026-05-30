import { Result } from "better-result";
import { t } from "elysia";

import { isNativeToolEnabledForOrg } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  BUSINESS_REGISTRY_DISPATCH,
  BUSINESS_REGISTRY_SLUGS,
  executeRegistryLookup,
} from "@/api/lib/business-registries/dispatch";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const querySchema = t.Object({
  registry: t.UnionEnum(BUSINESS_REGISTRY_SLUGS),
  q: t.String({ minLength: 1, maxLength: 256 }),
});

const businessRegistriesLookup = createSafeRootHandler(
  {
    permissions: { workspace: ["read"] },
    query: querySchema,
  },
  async function* ({ query, safeDb, session }) {
    const { registry, q } = query;
    const handler = BUSINESS_REGISTRY_DISPATCH[registry];

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            practiceJurisdictions: true,
            nativeToolOverrides: true,
          },
        }),
      ),
    );
    const enabled = isNativeToolEnabledForOrg({
      slug: handler.nativeToolSlug,
      practiceJurisdictions: settings?.practiceJurisdictions ?? [],
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
  },
);

export default businessRegistriesLookup;
