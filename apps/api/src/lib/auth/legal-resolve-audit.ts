import { panic } from "better-result";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import type { Transaction } from "@/api/db/root";
import { isServiceResolveSession } from "@/api/lib/auth/legal-resolve-principal";
import type { LegalResolveSession } from "@/api/lib/auth/legal-resolve-principal";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/db/audit-recording";
import type { AuditExecutionContext } from "@/api/lib/db/audit-recording";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

export type LegalResolveAudit = {
  principal: LegalResolveSession;
  credentialKey: string;
  route: "law" | "case";
  country: string;
  outcome:
    | LegalResolveResponse["status"]
    | "rate_limited"
    | "missing_scope"
    | "not_entitled"
    | "invalid_request"
    | "error";
};

/** Only identifiers and the typed response outcome enter the audit trail. */
export const recordLegalResolveAuditInTransaction = async ({
  tx,
  principal,
  credentialKey,
  route,
  country,
  outcome,
}: LegalResolveAudit & { tx: Transaction }): Promise<void> => {
  const performer = isServiceResolveSession(principal)
    ? ({ type: "service", id: principal.clientId, name: null } as const)
    : ({
        type: "user",
        id:
          parseAuthProviderId<"user">(principal.userId) ??
          panic("Invalid resolve user identity"),
      } as const);
  const execution = {
    performer,
    trigger: isServiceResolveSession(principal)
      ? { type: "system", source: "legal-resolve" }
      : { type: "direct" },
  } as const satisfies AuditExecutionContext;
  const userId =
    performer.type === "service"
      ? TENANT_SYSTEM_ACTOR.serviceClient
      : performer.id;
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId:
      parseAuthProviderId<"organization">(principal.organizationId) ??
      panic("Invalid resolve organization identity"),
    workspaceId: null,
    userId,
    execution,
  });
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.ACCESS,
    resourceType: AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE,
    resourceId: credentialKey,
    metadata: {
      credentialKey,
      ...(isServiceResolveSession(principal)
        ? { clientId: principal.clientId }
        : {}),
      route,
      country,
      outcome,
    },
  });
};
