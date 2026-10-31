import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";

import { ORGANIZATION_CREATE_SCOPE } from "@stll/api-contract/organization-create";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { organizationCreationRequests } from "@/api/db/schema";
import createOrganization from "@/api/handlers/organizations/create";
import { HttpStatusResponse } from "@/api/http/status";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { isRecord } from "@/api/lib/type-guards";
import { RESEARCH_ADMIN_TOOL_SET } from "@/api/mcp/research-admin-tools";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import type { seedEntityReadScaling } from "@/api/tests/read-scaling/entity-fixture";

const seedCreationHistory = async (size: number) => {
  const userId = mintAuthProviderId<"user">();
  const email = `${userId}@example.test`;
  await rootDb.insert(user).values({
    id: userId,
    email,
    name: "Creation scaling fixture",
    emailVerified: true,
  });
  await rootDb.insert(organizationCreationRequests).values(
    Array.from({ length: size }, (_, index) => ({
      userId,
      key: `history-${index}`,
      fingerprint: `history-${index}`,
    })),
  );
  const history = Array.from({ length: size }, () => ({
    id: mintAuthProviderId<"organization">(),
    name: "Existing organization",
    slug: Bun.randomUUIDv7(),
    createdAt: new Date("2026-10-30T12:00:00Z"),
  }));
  await rootDb.insert(organization).values(history);
  await rootDb.insert(member).values(
    history.map(({ id }) => ({
      id: mintAuthProviderId<"member">(),
      organizationId: id,
      userId,
      role: "owner",
      createdAt: new Date("2026-10-30T12:00:00Z"),
    })),
  );
  return {
    userId,
    email,
    name: `Scaling ${userId}`,
    historyOrganizationIds: history.map(({ id }) => id),
  };
};

type CreationFixture = Awaited<ReturnType<typeof seedCreationHistory>>;

const cleanupCreation = async (fixture: CreationFixture) => {
  await rootDb
    .delete(organization)
    .where(eq(organization.slug, fixture.userId.toLowerCase()));
  await rootDb
    .delete(organization)
    .where(inArray(organization.id, fixture.historyOrganizationIds));
  await rootDb
    .delete(organizationCreationRequests)
    .where(eq(organizationCreationRequests.userId, fixture.userId));
  // The disposable database retains the audited account: account audit rows
  // are append-only and prevent deletion of their actor by construction.
};

export const organizationCreateScalingScenario = {
  name: "organization creation",
  definition: createOrganization,
  measure: async ({ size }: { size: number }) => {
    const fixture = await seedCreationHistory(size);
    try {
      return await runWithMeasuredQueryCounter(async (counter) => {
        const response = await createOrganization.handler(
          createTestHandlerContext<
            Parameters<typeof createOrganization.handler>[0]
          >({
            user: { id: fixture.userId, email: fixture.email },
            body: { name: fixture.name, slug: fixture.userId.toLowerCase() },
            request: new Request("https://example.test/v1/organizations", {
              method: "POST",
              headers: { "Idempotency-Key": "measured-creation" },
            }),
            audit: NO_AUDIT,
            safeDb: NO_DB,
            scopedDb: NO_DB,
          }),
        );
        if (
          response instanceof HttpStatusResponse ||
          response.role !== "owner"
        ) {
          return panic(
            "Creation scaling requires a successful owned organization",
          );
        }
        return {
          statements: counter.count,
          transactionRoundTrips: counter.transactions,
          responseBytes: Buffer.byteLength(JSON.stringify(response)),
          rows: 1,
        };
      });
    } finally {
      await cleanupCreation(fixture);
    }
  },
};

export const measureCreateOrganizationTool = async ({
  size,
  organizationId,
}: Pick<
  Awaited<ReturnType<typeof seedEntityReadScaling>>,
  "size" | "organizationId"
>) => {
  const fixture = await seedCreationHistory(size);
  const forbiddenDatabase = () =>
    panic("Account creation must not read organization data");
  try {
    return await runWithMeasuredQueryCounter(async (counter) => {
      const context = authorizedMcpContextForTest(
        asTestRaw<
          Parameters<
            typeof RESEARCH_ADMIN_TOOL_SET.handlers.create_organization
          >[0]["context"]
        >({
          organizationId,
          userId: fixture.userId,
          userEmail: fixture.email,
          credential: { type: "oauth_client", clientId: "creation-scaling" },
          grantedScopes: [ORGANIZATION_CREATE_SCOPE],
          memberRole: "owner",
          accessibleWorkspaceIds: [],
          accessibleWorkspaceIdSet: new Set(),
          accessibleWorkspaceStatusById: new Map(),
          accessibleWorkspaces: [],
          safeDb: forbiddenDatabase,
          scopedDb: forbiddenDatabase,
          createOperationDatabaseScope: () => ({
            safeDb: forbiddenDatabase,
            scopedDb: forbiddenDatabase,
            pinServerValidatedWorkspaceId: () => false,
          }),
          recordAuditEvent: forbiddenDatabase,
          request: new Request("https://example.test/mcp", { method: "POST" }),
          testDependencies: {
            consumeInvokeCapabilityRateLimit: async () => ({
              ok: true,
              retryAfterSeconds: 3600,
            }),
            loadOrgSettingsForAuth: async () => ({
              orgAIConfig: null,
              orgAIConfigStatus: "ok",
              managedAIResidency: "eu",
              promptCachingEnabled: false,
            }),
          },
        }),
      );
      const response =
        await RESEARCH_ADMIN_TOOL_SET.handlers.create_organization({
          args: {
            name: fixture.name,
            slug: fixture.userId.toLowerCase(),
            confirm: true,
          },
          context,
        });
      if (
        !("egress" in response) ||
        response.egress !== "structured" ||
        !isRecord(response.payload) ||
        response.payload["role"] !== "owner"
      ) {
        return panic(
          "Curated creation scaling requires the real handler's owned organization response",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response.payload)),
        rows: 1,
      };
    });
  } finally {
    await cleanupCreation(fixture);
  }
};
