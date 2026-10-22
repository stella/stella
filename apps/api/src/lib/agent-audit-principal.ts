import { panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { agentRegistration } from "@/api/db/agent-auth-schema";
import { rootDb } from "@/api/db/root";
import { oauthGrantRevocations } from "@/api/db/schema";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { McpSession } from "@/api/mcp/auth";
import { McpAuthenticationError } from "@/api/mcp/errors";

type ResolveAgentAuditExecutionOptions = {
  credential: McpSession["credential"];
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  db?: Pick<typeof rootDb, "select">;
};

/**
 * Resolve the verified MCP credential into activity provenance. The human
 * remains the accountable owner while the credential is the performer. This
 * owner-level lookup is deliberately isolated here because agent-registration
 * control-plane rows deny access to the scoped application role.
 */
export const resolveAgentAuditExecution = async ({
  credential,
  organizationId,
  userId,
  db = rootDb,
}: ResolveAgentAuditExecutionOptions): Promise<
  AuditExecutionContext | undefined
> => {
  if (credential === undefined) {
    return undefined;
  }

  switch (credential.type) {
    case "agent_run":
      return {
        performer: {
          type: "agent",
          id: "stella-assistant",
          name: "Stella AI",
        },
        runId: credential.runId,
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: credential.runId,
        },
      };
    case "delegated_user":
      return {
        performer: { id: userId, type: "user" },
        trigger: { source: "mcp", type: "direct" },
      };
    case "personal_api_key":
    case "machine_api_key":
      return {
        performer: {
          type: "agent",
          id: `${credential.type === "personal_api_key" ? "personal-key" : "machine-key"}:${credential.id}`,
          name: credential.name,
        },
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: credential.id,
        },
      };
    case "oauth_client": {
      const match = await db
        .select({
          registrationId: agentRegistration.id,
          revocationStatus: sql<
            "active" | "revoked"
          >`CASE WHEN ${oauthGrantRevocations.userId} IS NULL THEN 'active' ELSE 'revoked' END`,
        })
        .from(sql`(SELECT 1) AS oauth_session`)
        .leftJoin(
          agentRegistration,
          and(
            eq(agentRegistration.clientId, credential.clientId),
            eq(agentRegistration.boundUserId, userId),
            eq(agentRegistration.boundOrganizationId, organizationId),
            eq(agentRegistration.status, "claimed"),
          ),
        )
        .leftJoin(
          oauthGrantRevocations,
          and(
            eq(oauthGrantRevocations.oauthClientId, credential.clientId),
            eq(oauthGrantRevocations.userId, userId),
            eq(oauthGrantRevocations.organizationId, organizationId),
            sql`${oauthGrantRevocations.revokedAt} >= to_timestamp(${credential.issuedAt})`,
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);

      if (match?.revocationStatus === "revoked") {
        throw new McpAuthenticationError({
          message: "Invalid or expired token",
        });
      }

      if (!match?.registrationId) {
        return {
          performer: { id: userId, type: "user" },
          trigger: { source: "mcp", type: "direct" },
        };
      }

      return {
        performer: {
          type: "agent",
          id: match.registrationId,
          name: null,
        },
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: match.registrationId,
        },
      };
    }
    default: {
      credential satisfies never;
      return panic(`Unhandled credential: ${String(credential)}`);
    }
  }
};
