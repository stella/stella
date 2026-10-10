import { RESOURCE_TYPE } from "@stll/api-contract";

import {
  organizationResourceSetUpdates,
  workspaceResourceSetUpdates,
} from "@/api/lib/resource-set-realtime";

// Resource sets that handler configs announce after a successful write
// (`realtime` on the config). Shared here because several handler families
// announce the same sets; the wrapper in `lib/api-handlers.ts` broadcasts them.

export const billingCodeRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.BILLING_CODE,
);

export const catalogueRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.AGENT_SKILL,
);

export const documentVersionRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.ENTITY_VERSION,
  RESOURCE_TYPE.USER_FILE,
]);

export const entityFileRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.USER_FILE,
]);

export const entityRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

export const entityUploadRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.USER_FILE,
]);

export const entityVersionRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.ENTITY_VERSION,
  RESOURCE_TYPE.USER_FILE,
]);

export const expenseRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.EXPENSE,
);

export const fieldRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.FIELD,
);

export const flowRunRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.FLOW_RUN,
);

export const invoiceRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.INVOICE,
);

export const kanbanPlacementRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.FIELD,
]);

export const legalListRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.LEGAL_LIST,
);

export const mcpConnectorRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.MCP_CONNECTOR,
);

export const organizationWorkspaceRealtimeUpdates =
  organizationResourceSetUpdates(RESOURCE_TYPE.WORKSPACE);

export const playbookRunRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.PROPERTY,
]);

export const propertyRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.PROPERTY,
);

export const rateRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.RATE_TABLE,
  RESOURCE_TYPE.RATE_ENTRY,
]);

export const sharepointRealtimeUpdates = organizationResourceSetUpdates(
  RESOURCE_TYPE.ORGANIZATION,
);

export const skillRealtimeUpdates = organizationResourceSetUpdates([
  RESOURCE_TYPE.AGENT_SKILL,
  RESOURCE_TYPE.AGENT_SKILL_COMMENT,
  RESOURCE_TYPE.AGENT_SKILL_PROPOSAL,
  RESOURCE_TYPE.AGENT_SKILL_RESOURCE,
  RESOURCE_TYPE.AGENT_SKILL_REVISION,
]);

export const taskCreateRealtimeUpdates = workspaceResourceSetUpdates([
  RESOURCE_TYPE.ENTITY,
  RESOURCE_TYPE.LEGAL_LIST,
]);

export const taskRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

export const timeEntryRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.TIME_ENTRY,
);

export const workObligationRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

export const workspaceContactRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.CONTACT,
);

export const workspaceEntityRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.ENTITY,
);

export const workspaceRealtimeUpdates = workspaceResourceSetUpdates(
  RESOURCE_TYPE.WORKSPACE,
);
