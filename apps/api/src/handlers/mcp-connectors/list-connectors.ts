import { Result } from "better-result";
import { desc, eq, isNull, or } from "drizzle-orm";

import { mcpConnectors } from "@/api/db/schema";
import {
  getNativeToolCatalog,
  isMcpConnectorRecommendedForPractice,
  mcpConnectorCatalogMetadata,
} from "@/api/handlers/mcp-connectors/catalog-metadata";
import { mcpConnectorUrlIdentity } from "@/api/handlers/mcp-connectors/url-normalization";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listMcpConnectors = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole }) {
    const connectors = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: mcpConnectors.id,
            slug: mcpConnectors.slug,
            organizationId: mcpConnectors.organizationId,
            displayName: mcpConnectors.displayName,
            description: mcpConnectors.description,
            url: mcpConnectors.url,
            authType: mcpConnectors.authType,
            isCurated: mcpConnectors.isCurated,
            oauthRequestedScopes: mcpConnectors.oauthRequestedScopes,
            allowedTools: mcpConnectors.allowedTools,
            documentationUrl: mcpConnectors.documentationUrl,
            tokenHelpUrl: mcpConnectors.tokenHelpUrl,
            iconUrl: mcpConnectors.iconUrl,
          })
          .from(mcpConnectors)
          .where(
            or(
              isNull(mcpConnectors.organizationId),
              eq(mcpConnectors.organizationId, session.activeOrganizationId),
            ),
          )
          .orderBy(desc(mcpConnectors.isCurated), mcpConnectors.displayName)
          .limit(100),
      ),
    );

    const settings = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { practiceJurisdictions: true },
        }),
      ),
    );
    const practiceJurisdictions = settings?.practiceJurisdictions ?? [];

    return Result.ok({
      canManageCustomConnectors: ["admin", "owner"].includes(memberRole.role),
      connectors: uniqueConnectorsByUrl(connectors).map((connector) => {
        const metadata = mcpConnectorCatalogMetadata(connector);
        return {
          id: connector.id,
          slug: connector.slug,
          organizationId: connector.organizationId,
          displayName: connector.displayName,
          description: connector.description,
          url: connector.url,
          authType: connector.authType,
          isCurated: connector.isCurated,
          oauthRequestedScopes: connector.oauthRequestedScopes,
          allowedTools: connector.allowedTools,
          documentationUrl: connector.documentationUrl,
          tokenHelpUrl: connector.tokenHelpUrl,
          iconUrl: connector.iconUrl,
          isRecommended: isMcpConnectorRecommendedForPractice({
            connector,
            practiceJurisdictions,
          }),
          recommendedJurisdictions: metadata.recommendedJurisdictions,
        };
      }),
      nativeTools: getNativeToolCatalog({ practiceJurisdictions }),
    });
  },
);

export default listMcpConnectors;

const uniqueConnectorsByUrl = <T extends { url: string }>(
  connectors: T[],
): T[] => {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const connector of connectors) {
    const identity = mcpConnectorUrlIdentity(connector.url);
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    unique.push(connector);
  }
  return unique;
};
