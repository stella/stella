import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@stll/api-contract/mcp";
import { mcpWebHandoffLinkOutputSchema } from "@stll/api-contract/mcp-web-handoff";

import { member, oauthClient, oauthConsent } from "@/api/db/auth-schema";
import { auditLogs } from "@/api/db/schema";
import { mcpWebHandoff } from "@/api/db/schema/mcp-web-handoff";
import { createWebHandoffService } from "@/api/lib/auth/mcp-web-handoff";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { InMemoryRateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import { createWebHandoffToolSet } from "@/api/mcp/web-handoff-links";
import { handoffLinkResult } from "@/api/mcp/web-handoff-links-core";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

type ReadFixture = Awaited<ReturnType<typeof seedEntityReadScaling>>;

export const measureWebHandoff = async (
  fixture: ReadFixture,
  createToolSet: typeof createWebHandoffToolSet = createWebHandoffToolSet,
) => {
  const { db, size, userId, organizationId } = fixture;
  const clients = Array.from({ length: size }, () => Bun.randomUUIDv7());
  const clientId = clients.at(0) ?? panic("Handoff scaling requires a client");
  const membershipId = Bun.randomUUIDv7();
  try {
    await db.insert(member).values({
      id: membershipId,
      userId,
      organizationId,
      role: "owner",
      createdAt: new Date(),
    });
    await db.insert(oauthClient).values(
      clients.map((id) => ({
        id,
        clientId: id,
        name: "Scaling client",
        redirectUris: [],
      })),
    );
    await db.insert(oauthConsent).values(
      clients.map((id) => ({
        id: Bun.randomUUIDv7(),
        clientId: id,
        userId,
        referenceId: organizationId,
        scopes: [...MCP_DEFAULT_RESOURCE_SCOPES],
      })),
    );
    const service = createWebHandoffService({
      db,
      budget: new InMemoryRateLimitContext(),
      enabled: () => true,
      textEnabled: () => true,
    });
    const toolSet = createToolSet(async (result, context, kind) => {
      if (context.credentialType !== "oauth") {
        return result;
      }
      return await handoffLinkResult({
        result,
        appBaseUrl: "https://app.example",
        mint: async (paths) =>
          await service.mint(
            {
              credentialType: "oauth",
              userId,
              organizationId,
              clientId,
              grantedScopes: [...MCP_DEFAULT_RESOURCE_SCOPES],
            },
            paths,
            kind ?? "text",
          ),
      });
    });
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await toolSet.handlers.mint_web_handoff({
        args: { url: "https://app.example/law/example" },
        context: asTestRaw<
          Parameters<typeof toolSet.handlers.mint_web_handoff>[0]["context"]
        >({
          credentialType: "oauth",
          userId,
          organizationId,
          clientId,
          grantedScopes: [...MCP_DEFAULT_RESOURCE_SCOPES],
        }),
      });
      const output = v.safeParse(
        mcpWebHandoffLinkOutputSchema,
        "data" in response ? response.data : undefined,
      );
      if (
        !output.success ||
        !/^sh1_[A-Za-z0-9_-]{43}$/u.test(
          new URLSearchParams(new URL(output.output.url).hash.slice(1)).get(
            "sh",
          ) ?? "",
        )
      ) {
        return panic(
          "Handoff scaling requires a real grant-backed minted credential",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(output.output)),
        rows: 1,
      };
    });
  } finally {
    await db.delete(auditLogs).where(eq(auditLogs.userId, userId));
    await db.delete(mcpWebHandoff).where(eq(mcpWebHandoff.userId, userId));
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
    await db.delete(oauthClient).where(inArray(oauthClient.clientId, clients));
    await db.delete(member).where(eq(member.id, membershipId));
  }
};

export const measurePlainWebHandoff = async (
  fixture: ReadFixture,
  createToolSet: typeof createWebHandoffToolSet = createWebHandoffToolSet,
) => {
  const toolSet = createToolSet();
  return await runWithMeasuredQueryCounter(async (counter) => {
    const url = "https://app.example/law/example";
    const response = await toolSet.handlers.mint_web_handoff({
      args: { url },
      context: asTestRaw<
        Parameters<typeof toolSet.handlers.mint_web_handoff>[0]["context"]
      >({
        credentialType: "api-key",
        userId: fixture.userId,
        organizationId: fixture.organizationId,
      }),
    });
    const output = v.safeParse(
      mcpWebHandoffLinkOutputSchema,
      "data" in response ? response.data : undefined,
    );
    if (!output.success || output.output.url !== url) {
      return panic(
        "Plain handoff scaling requires an unchanged successful URL",
      );
    }
    return {
      statements: counter.count,
      transactionRoundTrips: counter.transactions,
      responseBytes: Buffer.byteLength(JSON.stringify(output.output)),
      rows: 1,
    };
  });
};
