import { and, eq } from "drizzle-orm";

import { agentRegistration } from "@/api/db/agent-auth-schema";
import { rootDb } from "@/api/db/root";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import type { McpSession } from "@/api/mcp/auth";

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
    case "machine_api_key":
      return {
        performer: {
          type: "agent",
          id: `machine-key:${credential.id}`,
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
      const registration = await db
        .select({ id: agentRegistration.id })
        .from(agentRegistration)
        .where(
          and(
            eq(agentRegistration.clientId, credential.clientId),
            eq(agentRegistration.boundUserId, userId),
            eq(agentRegistration.boundOrganizationId, organizationId),
            eq(agentRegistration.status, "claimed"),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);

      if (!registration) {
        return {
          performer: { id: userId, type: "user" },
          trigger: { source: "mcp", type: "direct" },
        };
      }

      return {
        performer: {
          type: "agent",
          id: registration.id,
          name: null,
        },
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: registration.id,
        },
      };
    }
    default: {
      const exhaustive: never = credential;
      return exhaustive;
    }
  }
};
