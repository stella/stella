import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import confirmAgentClaim from "@/api/handlers/agent-auth/confirm";
import grantDesktopRegistryKey from "@/api/handlers/desktop-registry/grant";
import createReaderAnnotation from "@/api/handlers/legal-reader/annotations/create";
import deleteReaderAnnotation from "@/api/handlers/legal-reader/annotations/delete";
import listReaderAnnotations from "@/api/handlers/legal-reader/annotations/list";
import updateReaderAnnotation from "@/api/handlers/legal-reader/annotations/update";
import connectMcpConnector from "@/api/handlers/mcp-connectors/connect";
import createMcpConnection from "@/api/handlers/mcp-connectors/create-connection";
import deleteMcpConnection from "@/api/handlers/mcp-connectors/delete-connection";
import listMcpConnections from "@/api/handlers/mcp-connectors/list-connections";
import listMcpConnectors from "@/api/handlers/mcp-connectors/list-connectors";
import mcpOAuthCallback from "@/api/handlers/mcp-connectors/oauth-callback";
import updateMcpConnection from "@/api/handlers/mcp-connectors/update-connection";
import createSavedSearch from "@/api/handlers/saved-searches/create";
import deleteSavedSearch from "@/api/handlers/saved-searches/delete";
import updateSavedSearch from "@/api/handlers/saved-searches/update";
import connectSharepoint from "@/api/handlers/sharepoint/connect";
import disconnectSharepoint from "@/api/handlers/sharepoint/disconnect";
import listSharepointDriveRoot from "@/api/handlers/sharepoint/list-drive-root";
import sharepointOAuthCallback from "@/api/handlers/sharepoint/oauth-callback";
import sharepointConnectionStatus from "@/api/handlers/sharepoint/status";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { MemberRole } from "@/api/lib/member-roles";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The writes a member makes to their own work: a mark on a decision or a
 * statute, a stored search, a link between their account and an outside system. Each names the
 * resource it writes instead of riding the baseline `workspace:["read"]` grant
 * every role holds, and each follows the line the time entry, expense and chat
 * grants already draw: staff and interns keep their own work, an external
 * collaborator holds no write grant at all.
 */

const GRANTED_ROLES = ["owner", "admin", "member", "intern"] as const;

const MUTATIONS = {
  "agent-auth/confirm.ts": confirmAgentClaim,
  "desktop-registry/grant.ts": grantDesktopRegistryKey,
  "legal-reader/annotations/create.ts": createReaderAnnotation,
  "legal-reader/annotations/delete.ts": deleteReaderAnnotation,
  "legal-reader/annotations/update.ts": updateReaderAnnotation,
  "mcp-connectors/connect.ts": connectMcpConnector,
  "mcp-connectors/create-connection.ts": createMcpConnection,
  "mcp-connectors/delete-connection.ts": deleteMcpConnection,
  "mcp-connectors/oauth-callback.ts": mcpOAuthCallback,
  "mcp-connectors/update-connection.ts": updateMcpConnection,
  "saved-searches/create.ts": createSavedSearch,
  "saved-searches/delete.ts": deleteSavedSearch,
  "saved-searches/update.ts": updateSavedSearch,
  "sharepoint/connect.ts": connectSharepoint,
  "sharepoint/disconnect.ts": disconnectSharepoint,
  "sharepoint/oauth-callback.ts": sharepointOAuthCallback,
} as const;

/** The sibling reads: on the baseline grant, and affirmed as reads. */
const READS = {
  "legal-reader/annotations/list.ts": listReaderAnnotations,
  "mcp-connectors/list-connections.ts": listMcpConnections,
  "mcp-connectors/list-connectors.ts": listMcpConnectors,
  "sharepoint/list-drive-root.ts": listSharepointDriveRoot,
  "sharepoint/status.ts": sharepointConnectionStatus,
} as const;

const refusingDb: SafeDb = async <T>() =>
  Result.err<T, SafeDbError>(
    new DatabaseError({ message: "a denied call must not reach the database" }),
  );

const contextForRole = (role: MemberRole): unknown => ({
  request: new Request("https://example.test/own-work"),
  route: "/own-work",
  body: {},
  params: {},
  query: {},
  set: { headers: {} },
  user: { id: toSafeId<"user">("019e7000-0000-7000-8000-000000000001") },
  session: {
    activeOrganizationId: toSafeId<"organization">(
      "019e7000-0000-7000-8000-000000000002",
    ),
  },
  memberRole: { role },
  safeDb: refusingDb,
  scopedDb: async () => {
    throw new DatabaseError({ message: "scopedDb must not be called" });
  },
  getActiveWorkspaceIds: async () => [],
  getAccessibleWorkspaces: async () => [],
  getWorkspaceAccess: async () => null,
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: async () => undefined,
  createAuditRecorder: () => async () => undefined,
});

describe("own-work permissions", () => {
  test("each mutation declares the resource it writes", () => {
    const declared = Object.fromEntries(
      Object.entries(MUTATIONS).map(([file, endpoint]) => [
        file,
        endpoint.config.permissions,
      ]),
    );

    expect(declared).toEqual({
      "agent-auth/confirm.ts": { integration: ["create"] },
      "desktop-registry/grant.ts": { integration: ["create"] },
      "legal-reader/annotations/create.ts": {
        legalReaderAnnotation: ["create"],
      },
      "legal-reader/annotations/delete.ts": {
        legalReaderAnnotation: ["delete"],
      },
      "legal-reader/annotations/update.ts": {
        legalReaderAnnotation: ["update"],
      },
      "mcp-connectors/connect.ts": { integration: ["create"] },
      "mcp-connectors/create-connection.ts": { integration: ["create"] },
      "mcp-connectors/delete-connection.ts": { integration: ["delete"] },
      "mcp-connectors/oauth-callback.ts": { integration: ["create"] },
      "mcp-connectors/update-connection.ts": { integration: ["update"] },
      "saved-searches/create.ts": { savedSearch: ["create"] },
      "saved-searches/delete.ts": { savedSearch: ["delete"] },
      "saved-searches/update.ts": { savedSearch: ["update"] },
      "sharepoint/connect.ts": { integration: ["create"] },
      "sharepoint/disconnect.ts": { integration: ["delete"] },
      "sharepoint/oauth-callback.ts": { integration: ["create"] },
    });
  });

  test("the sibling reads stay on the baseline grant and affirm themselves reads", () => {
    const declared = Object.fromEntries(
      Object.entries(READS).map(([file, endpoint]) => [
        file,
        {
          permissions: endpoint.config.permissions,
          access: endpoint.config.access,
        },
      ]),
    );

    expect(declared).toEqual(
      Object.fromEntries(
        Object.keys(READS).map((file) => [
          file,
          { permissions: { workspace: ["read"] }, access: "read" },
        ]),
      ),
    );
  });

  test("an external collaborator is refused, before any database work", async () => {
    for (const [file, endpoint] of Object.entries(MUTATIONS)) {
      const result = await endpoint.handler(
        asTestRaw(contextForRole("external")),
      );
      if (!("code" in result)) {
        throw new Error(`${file} as external: expected a status response`);
      }
      expect({ file, code: result.code, body: result.response }).toEqual({
        file,
        code: 403,
        body: { code: "forbidden", message: "Forbidden" },
      });
    }
  });

  test("staff and interns hold every grant these endpoints ask for", () => {
    for (const [file, endpoint] of Object.entries(MUTATIONS)) {
      for (const role of GRANTED_ROLES) {
        expect({
          file,
          role,
          granted: hasMemberPermission({ role }, endpoint.config.permissions),
        }).toEqual({ file, role, granted: true });
      }
    }
  });
});
