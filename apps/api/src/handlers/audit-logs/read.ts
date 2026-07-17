import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import {
  queryAuditLogPage,
  readAuditLogsQuerySchema,
  validateAuditLogFilter,
} from "./query";

const config = {
  permissions: { auditLog: ["read"] },
  mcp: { type: "tool", name: "list_audit_log" },
  query: readAuditLogsQuerySchema,
} satisfies HandlerConfig;

const readAuditLogs = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, recordAuditEvent, query }) {
    const invalid = validateAuditLogFilter(query);
    if (invalid !== null) {
      return Result.err(new HandlerError({ status: 400, message: invalid }));
    }

    return yield* queryAuditLogPage({
      safeDb,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      query,
    });
  },
);

export default readAuditLogs;
