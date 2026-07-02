import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { type SafeId } from "@/lib/safe-id";

export interface AuditLogQueryParams {
  workspaceId?: SafeId<"workspace">;
  action?: string;
  resourceType?: string;
  userId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export const auditLogKeys = {
  all: ["audit-logs"] as const,
  filtered: (filters: AuditLogQueryParams) => [...auditLogKeys.all, filters] as const,
};

export const fetchAuditLogs = async (query: AuditLogQueryParams) => {
  // exactOptionalPropertyTypes checks require omitting undefined keys
  const cleanedQuery = Object.fromEntries(
    Object.entries(query).filter(([_, v]) => v !== undefined)
  );

  const response = await api["audit-logs"].get({
    query: cleanedQuery as any,
  });
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
};

export const auditLogOptions = (query: AuditLogQueryParams) =>
  queryOptions({
    queryKey: auditLogKeys.filtered(query),
    queryFn: () => fetchAuditLogs(query),
  });
