import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { deleteSsoConnection } from "@/api/lib/sso-connections";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies HandlerConfig;

const deleteConnection = createSafeRootHandler(
  config,
  async function* ({ session, recordAuditEvent }) {
    yield* Result.await(
      deleteSsoConnection({
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
      }),
    );
    return Result.ok({ success: true });
  },
);

export default deleteConnection;
