import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import * as v from "valibot";

import { ACCOUNT_EXPORT_SCOPES } from "@stll/api-contract";
import { MCP_CAPABILITY_EXECUTORS } from "@stll/api-contract/mcp-capability-executors";

import { member, organization, user } from "@/api/db/auth-schema";
import { rlsDb, rootDb } from "@/api/db/root";
import { accountAuditLogs, accountExports } from "@/api/db/schema";
import {
  createMembershipSafeDb,
  createMembershipScopedDb,
} from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { McpRequestResources } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const EXPORT_ID = Bun.randomUUIDv7();
const OTHER_EXPORT_ID = Bun.randomUUIDv7();
const READY_AT = new Date("2030-01-01T12:00:00.000Z");
const postgresTestsEnabled =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const statusSchema = v.variant("status", [
  v.object({ id: v.string(), status: v.literal("requested") }),
  v.object({ id: v.string(), status: v.literal("processing") }),
  v.object({ id: v.string(), status: v.literal("failed") }),
  v.object({ id: v.string(), status: v.literal("expired") }),
  v.object({
    id: v.string(),
    status: v.literal("ready"),
    expiresAt: v.string(),
  }),
]);
const createSchema = v.intersect([
  statusSchema,
  v.object({
    nextCall: v.strictObject({
      capability: v.literal("account-exports.status.get"),
      input: v.strictObject({
        params: v.strictObject({ exportId: v.string() }),
      }),
    }),
  }),
]);
const latestSchema = v.strictObject({ latest: v.nullable(statusSchema) });
const downloadSchema = v.strictObject({
  id: v.string(),
  download: v.strictObject({
    downloadUrl: v.string(),
    expiresAt: v.string(),
  }),
});

const parsePayload = (
  result: Awaited<ReturnType<typeof handleMcpToolCall>>,
): unknown => {
  const content = result.content.at(0);
  if (content?.type !== "text") {
    throw new Error("Expected a text MCP response");
  }
  const parsed: unknown = JSON.parse(content.text);
  if (parsed !== null && typeof parsed === "object" && "result" in parsed) {
    return parsed.result;
  }
  return parsed;
};

const invoke = async (
  context: McpRequestResources,
  capability: string,
  input: Record<string, unknown> = {},
) =>
  await handleMcpToolCall({
    mode: "advanced",
    toolName:
      capability === "account-exports.create"
        ? MCP_CAPABILITY_EXECUTORS.write
        : MCP_CAPABILITY_EXECUTORS.read,
    args: { capability, input },
    context,
  });

describe.skipIf(!postgresTestsEnabled)(
  "account export capability handler dispatch",
  () => {
    const suffix = Bun.randomUUIDv7();
    const userId = toSafeId<"user">(`export-handler-user-${suffix}`);
    const otherUserId = toSafeId<"user">(`export-handler-other-${suffix}`);
    const organizationId = toSafeId<"organization">(
      `export-handler-org-${suffix}`,
    );
    let context: McpRequestResources;

    beforeAll(async () => {
      await rootDb.insert(user).values([
        { id: userId, name: "Export caller", email: `${userId}@test.local` },
        {
          id: otherUserId,
          name: "Other export caller",
          email: `${otherUserId}@test.local`,
        },
      ]);
      await rootDb.insert(organization).values({
        id: organizationId,
        name: "Export handler test",
        slug: `export-handler-${suffix}`,
        createdAt: new Date(),
      });
      await rootDb.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: new Date(),
      });
      await rootDb.insert(accountExports).values([
        { id: EXPORT_ID, userId, status: "requested" },
        { id: OTHER_EXPORT_ID, userId: otherUserId, status: "requested" },
      ]);

      const identity = {
        organizationId,
        serverValidatedWorkspaceIds: [],
        userId,
      };
      const scopedDb = createMembershipScopedDb(rlsDb, identity);
      const safeDb = createMembershipSafeDb(rlsDb, identity);
      context = asTestRaw<McpRequestResources>({
        accessibleWorkspaceIds: [],
        accessibleWorkspaceIdSet: new Set(),
        accessibleWorkspaceStatusById: new Map(),
        accessibleWorkspaces: [],
        createOperationDatabaseScope: () => ({
          pinServerValidatedWorkspaceId: () => false,
          safeDb,
          scopedDb,
        }),
        credential: { type: "oauth_client", clientId: "export-test" },
        grantedScopes: ["stella:read", ...Object.values(ACCOUNT_EXPORT_SCOPES)],
        memberRole: "owner",
        organizationId,
        recordAuditEvent: mock(async () => undefined),
        request: new Request("http://localhost/mcp"),
        safeDb,
        scopedDb,
        testDependencies: {
          consumeInvokeCapabilityRateLimit: async () => ({
            ok: true,
            retryAfterSeconds: 60,
          }),
          loadOrgSettingsForAuth: async () => ({
            orgAIConfig: null,
            orgAIConfigStatus: "ok",
            managedAIResidency: "eu",
            promptCachingEnabled: false,
          }),
        },
        userEmail: `${userId}@test.local`,
        userId,
      });
    });

    afterAll(async () => {
      await rootDb
        .delete(accountAuditLogs)
        .where(inArray(accountAuditLogs.userId, [userId, otherUserId]));
      await rootDb
        .delete(accountExports)
        .where(inArray(accountExports.userId, [userId, otherUserId]));
    });

    test("dispatches every export capability to its real handler with account ownership and schema-safe output", async () => {
      const created = await invoke(context, "account-exports.create");
      expect(created.isError).not.toBe(true);
      const createdPayload = parsePayload(created);
      expect(v.safeParse(createSchema, createdPayload).success).toBe(true);
      expect(createdPayload).toMatchObject({
        id: EXPORT_ID,
        status: "requested",
        nextCall: {
          capability: "account-exports.status.get",
          input: { params: { exportId: EXPORT_ID } },
        },
      });

      const latest = await invoke(context, "account-exports.get");
      expect(latest.isError).not.toBe(true);
      const latestPayload = parsePayload(latest);
      expect(v.safeParse(latestSchema, latestPayload).success).toBe(true);
      expect(latestPayload).toEqual({
        latest: { id: EXPORT_ID, status: "requested" },
      });

      const status = await invoke(context, "account-exports.status.get", {
        params: { exportId: EXPORT_ID },
      });
      expect(status.isError).not.toBe(true);
      const statusPayload = parsePayload(status);
      expect(v.safeParse(statusSchema, statusPayload).success).toBe(true);
      expect(statusPayload).toEqual({ id: EXPORT_ID, status: "requested" });

      const otherStatus = await invoke(context, "account-exports.status.get", {
        params: { exportId: OTHER_EXPORT_ID },
      });
      expect(otherStatus.isError).toBe(true);
      expect(parsePayload(otherStatus)).toEqual({
        error: {
          code: "not_found",
          message: "Export not found.",
          hint: "Call account-exports.get for your latest export ID or account-exports.create to request one.",
        },
      });

      await rootDb
        .update(accountExports)
        .set({
          status: "ready",
          expiresAt: READY_AT,
          objectKey: `account-exports/${userId}/${EXPORT_ID}/archive.zip`,
        })
        .where(
          and(
            eq(accountExports.id, EXPORT_ID),
            eq(accountExports.userId, userId),
          ),
        );
      const download = await invoke(context, "account-exports.download.get", {
        params: { exportId: EXPORT_ID },
      });
      expect(download.isError).not.toBe(true);
      const downloadPayload = parsePayload(download);
      expect(v.safeParse(downloadSchema, downloadPayload).success).toBe(true);
      expect(downloadPayload).toEqual({
        id: EXPORT_ID,
        download: {
          downloadUrl: expect.stringContaining(
            `/me/data-exports/${EXPORT_ID}/download`,
          ),
          expiresAt: READY_AT.toISOString(),
        },
      });

      // The other user's export is downloadable for them, so only the
      // ownership filter can refuse it here.
      await rootDb
        .update(accountExports)
        .set({
          status: "ready",
          expiresAt: READY_AT,
          objectKey: `account-exports/${otherUserId}/${OTHER_EXPORT_ID}/archive.zip`,
        })
        .where(
          and(
            eq(accountExports.id, OTHER_EXPORT_ID),
            eq(accountExports.userId, otherUserId),
          ),
        );
      const otherDownload = await invoke(
        context,
        "account-exports.download.get",
        {
          params: { exportId: OTHER_EXPORT_ID },
        },
      );
      expect(otherDownload.isError).toBe(true);
      expect(parsePayload(otherDownload)).toEqual({
        error: {
          code: "not_found",
          message: "Export is unavailable or expired.",
          hint: "Poll account-exports.status.get while building; call account-exports.create if failed or expired.",
          issues: [
            {
              code: "account_export_download_unavailable",
              message: "Export is unavailable or expired.",
              path: "",
            },
          ],
        },
      });
    });
  },
);
