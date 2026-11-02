import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import * as v from "valibot";

import { ORGANIZATION_CREATE_SCOPE } from "@stll/api-contract/organization-create";

import { member, organization, user } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { organizationCreationRequests } from "@/api/db/schema";
import { TOOL_CONFIRMATION } from "@/api/mcp/tool-confirmation";
import { handleMcpToolCall } from "@/api/mcp/tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";
import { modelViewOf } from "@/api/tests/helpers/mcp-model-view";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const createdSchema = v.object({
  organizationId: v.string(),
  name: v.string(),
  slug: v.string(),
  role: v.literal("owner"),
});

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "MCP organization creation on PostgreSQL",
  () => {
    test("requires confirmation and replays the same key without creating another organization", async () => {
      const userId = mintAuthProviderId<"user">();
      const currentOrganizationId = mintAuthProviderId<"organization">();
      const email = `${userId}@example.test`;
      await rootDb.insert(user).values({
        id: userId,
        name: "MCP organization creation fixture",
        email,
        emailVerified: true,
      });
      const forbiddenDatabase = () =>
        panic("Account creation must not read the current organization");
      const context = authorizedMcpContextForTest(
        asTestRaw<AuthorizedMcpRequestContext>({
          organizationId: currentOrganizationId,
          userId,
          userEmail: email,
          credential: { type: "oauth_client", clientId: "organization-replay" },
          grantedScopes: ["stella:write", ORGANIZATION_CREATE_SCOPE],
          toolConfirmation: TOOL_CONFIRMATION.caller,
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
          request: new Request("https://example.test/mcp", {
            method: "POST",
            headers: { "Idempotency-Key": "organization-submission" },
          }),
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
      const args = { name: `MCP organization ${userId}` };
      const unconfirmed = await handleMcpToolCall({
        mode: "advanced",
        toolName: "create_organization",
        args,
        context,
      });
      expect(unconfirmed.isError).toBe(true);
      const refusal = unconfirmed.content.at(0);
      if (refusal?.type !== "text") {
        panic("MCP confirmation refusal requires a text envelope");
      }
      expect(JSON.parse(refusal.text)).toMatchObject({
        error: { code: "confirmation_required" },
      });
      expect(
        await rootDb
          .select({ id: member.id })
          .from(member)
          .where(eq(member.userId, userId)),
      ).toEqual([]);
      const invoke = async () =>
        v.parse(
          createdSchema,
          modelViewOf(
            await handleMcpToolCall({
              mode: "advanced",
              toolName: "create_organization",
              args: { ...args, confirm: true },
              context,
            }),
          ),
        );
      const first = await invoke();
      expect(await invoke()).toStrictEqual(first);
      expect(
        await rootDb
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.userId, userId)),
      ).toEqual([{ organizationId: first.organizationId }]);
      expect(
        await rootDb
          .select({
            organizationId: organizationCreationRequests.organizationId,
          })
          .from(organizationCreationRequests)
          .where(eq(organizationCreationRequests.userId, userId)),
      ).toEqual([{ organizationId: first.organizationId }]);
      // Account audit rows retain the actor in the disposable database.
      await rootDb.delete(organization).where(eq(organization.name, args.name));
    });
  },
);
