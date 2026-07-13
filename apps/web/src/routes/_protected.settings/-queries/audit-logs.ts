import { queryOptions } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";

export type AuditLogsPageKey = {
  workspaceId?: SafeId<"workspace"> | undefined;
  action?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  userId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

export const auditLogKeys = {
  all: ["audit-logs"] as const,
  filtered: (key: AuditLogsPageKey) =>
    [
      ...auditLogKeys.all,
      {
        workspaceId: key.workspaceId,
        action: key.action,
        resourceType: key.resourceType,
        resourceId: key.resourceId,
        userId: key.userId,
        from: key.from,
        to: key.to,
        limit: key.limit,
        cursor: key.cursor,
      },
    ] as const,
};

export type AuditLogOptionsInput = {
  key: AuditLogsPageKey;
};

export const fetchAuditLogs = async (query: AuditLogsPageKey) => {
  // Construct a query object with only defined keys to satisfy exactOptionalPropertyTypes
  const cleanedQuery: {
    workspaceId?: SafeId<"workspace">;
    action?: string;
    resourceType?: string;
    resourceId?: string;
    userId?: string;
    from?: string;
    to?: string;
    limit?: number;
    cursor?: string;
  } = {};

  if (query.workspaceId !== undefined) {
    cleanedQuery.workspaceId = query.workspaceId;
  }
  if (query.action !== undefined) {
    cleanedQuery.action = query.action;
  }
  if (query.resourceType !== undefined) {
    cleanedQuery.resourceType = query.resourceType;
  }
  if (query.resourceId !== undefined) {
    cleanedQuery.resourceId = query.resourceId;
  }
  if (query.userId !== undefined) {
    cleanedQuery.userId = query.userId;
  }
  if (query.from !== undefined) {
    cleanedQuery.from = query.from;
  }
  if (query.to !== undefined) {
    cleanedQuery.to = query.to;
  }
  if (query.limit !== undefined) {
    cleanedQuery.limit = query.limit;
  }
  if (query.cursor !== undefined) {
    cleanedQuery.cursor = query.cursor;
  }

  const response = await api["audit-logs"].get({
    query: cleanedQuery,
  });
  if (response.error) {
    throw toAPIError(response.error);
  }
  return response.data;
};

export const auditLogOptions = ({ key }: AuditLogOptionsInput) =>
  queryOptions({
    queryKey: auditLogKeys.filtered(key),
    queryFn: async () => await fetchAuditLogs(key),
  });
