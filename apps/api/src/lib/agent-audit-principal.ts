import { panic } from "better-result";

import type { AuditExecutionContext } from "@/api/lib/audit-log";
import type { AdmittedMcpSession } from "@/api/lib/auth/oauth-grant-admission";
import type { SafeId } from "@/api/lib/branded-types";

type ResolveAgentAuditExecutionOptions = {
  credential: AdmittedMcpSession["credential"];
  userId: SafeId<"user">;
};

/**
 * Resolve the verified MCP credential into activity provenance. The human
 * remains the accountable owner while the credential is the performer.
 * The admission owner has already bound any agent registration to this identity.
 */
export const resolveAgentAuditExecution = ({
  credential,
  userId,
}: ResolveAgentAuditExecutionOptions): AuditExecutionContext | undefined => {
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
      if (!credential.registrationId) {
        return {
          performer: { id: userId, type: "user" },
          trigger: { source: "mcp", type: "direct" },
        };
      }

      return {
        performer: {
          type: "agent",
          id: credential.registrationId,
          name: null,
        },
        trigger: {
          type: "credential",
          ownerUserId: userId,
          source: "mcp",
          sourceId: credential.registrationId,
        },
      };
    }
    default: {
      credential satisfies never;
      return panic(`Unhandled credential: ${String(credential)}`);
    }
  }
};
