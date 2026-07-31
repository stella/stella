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
}: ResolveAgentAuditExecutionOptions): Promise<
  AuditExecutionContext | undefined
> => {
  if (credential === undefined) {
    return undefined;
  }

  switch (credential.type) {
    case "delegated_user":
      return undefined;
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
    case "oauth_agent": {
      const registration = await rootDb
        .select({ id: agentRegistration.id })
        .from(agentRegistration)
        .where(
          and(
            eq(agentRegistration.clientId, credential.clientId),
            eq(agentRegistration.boundUserId, userId),
            eq(agentRegistration.boundOrganizationId, organizationId),
            eq(agentRegistration.status, "confirmed"),
          ),
        )
        .limit(1)
        .then((rows) => rows.at(0) ?? null);

      return {
        performer: {
          type: "agent",
          id: registration?.id ?? `oauth-client:${credential.clientId}`,
          name: null,
        },
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: registration?.id ?? credential.clientId,
        },
      };
    }
    default: {
      const exhaustive: never = credential;
      return exhaustive;
    }
  }
};
