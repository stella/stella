import { Result } from "better-result";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { mcpConnectors } from "@/api/db/schema";
import { discoverMcpIconUrl } from "@/api/handlers/mcp-connectors/icons";
import { probeMcpServer } from "@/api/handlers/mcp-connectors/probe";
import {
  mcpConnectorUrlVariants,
  normalizeMcpConnectorUrl,
} from "@/api/handlers/mcp-connectors/url-normalization";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const requestBody = t.Object({
  url: t.String({ minLength: 1, maxLength: 2048 }),
  displayName: t.Optional(t.String({ minLength: 1, maxLength: 160 })),
  description: t.Optional(t.String({ minLength: 1, maxLength: 1000 })),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: requestBody,
} satisfies HandlerConfig;

const createMcpConnector = createSafeRootHandler(
  config,
  async function* ({ body: input, safeDb, session, recordAuditEvent }) {
    const normalizedUrl = yield* normalizeMcpConnectorUrl(input.url);
    const duplicate = yield* Result.await(
      findDuplicateConnector({
        normalizedUrl,
        organizationId: session.activeOrganizationId,
        safeDb,
      }),
    );
    if (duplicate) {
      return Result.err(
        new HandlerError({
          status: 409,
          message: `MCP connector already exists: ${duplicate.displayName}`,
        }),
      );
    }

    const probeResult = await probeMcpServer(normalizedUrl);
    if (Result.isError(probeResult)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: probeResult.error.message,
          cause: probeResult.error,
        }),
      );
    }
    const probe = probeResult.value;
    const displayName =
      input.displayName?.trim() || new URL(normalizedUrl).hostname;
    const slug = await nextSlug({
      base: slugify(displayName),
      organizationId: session.activeOrganizationId,
      safeDb,
    });
    const iconUrl = await discoverMcpIconUrl(normalizedUrl);

    const inserted = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .insert(mcpConnectors)
          .values({
            slug,
            organizationId: session.activeOrganizationId,
            displayName,
            description: input.description?.trim() ?? "",
            url: normalizedUrl,
            authType: probe.authType,
            isCurated: false,
            oauthRequestedScopes:
              probe.authType === "oauth2" && probe.scopes.length > 0
                ? probe.scopes
                : null,
            oauthIssuer:
              probe.authType === "oauth2" ? probe.authorizationServerUrl : null,
            iconUrl,
          })
          .returning({
            id: mcpConnectors.id,
            slug: mcpConnectors.slug,
            authType: mcpConnectors.authType,
          });

        const row = rows.at(0);
        if (row) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            metadata: {
              field: "mcpConnector",
              connectorId: row.id,
              slug: row.slug,
              displayName,
              url: normalizedUrl,
              authType: row.authType,
            },
          });
        }

        return rows;
      }),
    );

    const connector = inserted.at(0);
    if (!connector) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Failed to create MCP connector",
        }),
      );
    }

    return Result.ok({ connector, probe });
  },
);

export default createMcpConnector;

const findDuplicateConnector = async ({
  normalizedUrl,
  organizationId,
  safeDb,
}: {
  normalizedUrl: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}) => {
  const urlVariants = mcpConnectorUrlVariants(normalizedUrl);
  const result = await safeDb((tx) =>
    tx
      .select({
        displayName: mcpConnectors.displayName,
      })
      .from(mcpConnectors)
      .where(
        and(
          inArray(mcpConnectors.url, urlVariants),
          or(
            isNull(mcpConnectors.organizationId),
            eq(mcpConnectors.organizationId, organizationId),
          ),
        ),
      )
      .limit(1),
  );

  if (Result.isError(result)) {
    return Result.err(result.error);
  }

  return Result.ok(result.value.at(0));
};

const slugify = (value: string): string => {
  let slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .slice(0, 60);

  while (slug.startsWith("-")) {
    slug = slug.slice(1);
  }
  while (slug.endsWith("-")) {
    slug = slug.slice(0, -1);
  }

  return slug || "mcp-server";
};

const nextSlug = async ({
  base,
  organizationId,
  safeDb,
}: {
  base: string;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
}) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await safeDb((tx) =>
      tx
        .select({ id: mcpConnectors.id })
        .from(mcpConnectors)
        .where(
          and(
            eq(mcpConnectors.slug, slug),
            or(
              isNull(mcpConnectors.organizationId),
              eq(mcpConnectors.organizationId, organizationId),
            ),
          ),
        )
        .limit(1),
    );

    if (Result.isError(existing)) {
      throw existing.error;
    }

    if (!existing.value.at(0)) {
      return slug;
    }
  }

  return `${base}-${Bun.randomUUIDv7().slice(0, 8)}`;
};
