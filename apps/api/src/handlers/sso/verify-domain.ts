import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { verifySsoDomain } from "@/api/lib/sso-connections";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
} satisfies HandlerConfig;

const verifyDomain = createSafeRootHandler(
  config,
  async function* ({ session, recordAuditEvent }) {
    const connection = yield* Result.await(
      verifySsoDomain({
        organizationId: session.activeOrganizationId,
        recordAuditEvent,
      }),
    );
    return Result.ok(connection);
  },
);

export default verifyDomain;
