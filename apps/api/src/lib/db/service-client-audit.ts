import { panic } from "better-result";

import type { Transaction } from "@/api/db/root";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import { parseAuthProviderId } from "@/api/lib/safe-id-boundaries";
import { TENANT_SYSTEM_ACTOR } from "@/api/lib/system-audit/actors";

type ServiceClientOperatorAudit = {
  tx: Transaction;
  organizationId: string;
  clientId: string;
  operation: "create" | "rotate" | "disable";
  operatorUid: number;
};

export const recordServiceClientOperatorAuditEvent = async ({
  tx,
  organizationId,
  clientId,
  operation,
  operatorUid,
}: ServiceClientOperatorAudit): Promise<void> => {
  const recordAuditEvent = createBackgroundAuditRecorder({
    organizationId:
      parseAuthProviderId<"organization">(organizationId) ??
      panic("Invalid service organization identity"),
    workspaceId: null,
    userId: TENANT_SYSTEM_ACTOR.serviceClientOperator,
    execution: {
      performer: {
        type: "service",
        id: TENANT_SYSTEM_ACTOR.serviceClientOperator,
        name: null,
      },
      trigger: { type: "system", source: "service-client-operator" },
    },
  });
  await recordAuditEvent(tx, {
    action: operation === "create" ? AUDIT_ACTION.CREATE : AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT,
    resourceId: clientId,
    metadata: { operation, operatorUid },
  });
};
