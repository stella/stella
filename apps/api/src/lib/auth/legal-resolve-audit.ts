import { panic } from "better-result";

import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";

import { rootDb } from "@/api/db/root";
import { isServiceResolveSession } from "@/api/handlers/legal-resolve/authentication";
import type { LegalResolveSession } from "@/api/handlers/legal-resolve/authentication";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditExecutionContext } from "@/api/lib/audit-log";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

type LegalResolveAudit = {
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
export const recordLegalResolveAudit = async ({
  principal,
  credentialKey,
  route,
  country,
  outcome,
}: LegalResolveAudit): Promise<void> => {
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
  await withAggregateTransaction(rootDb, async (tx) => {
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
  });
};
