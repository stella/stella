import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { PERSONAL_API_KEY_POLICIES } from "@/api/lib/machine-api-key-config";
import { updatePersonalApiKeyPolicy } from "@/api/lib/machine-api-keys/personal-lifecycle";

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: t.Object({ policy: t.UnionEnum([...PERSONAL_API_KEY_POLICIES]) }),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const setting = yield* Result.await(
      updatePersonalApiKeyPolicy({
        policy: body.policy,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
      }),
    );
    return Result.ok(setting);
  },
);
