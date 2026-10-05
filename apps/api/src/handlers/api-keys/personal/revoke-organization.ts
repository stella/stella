import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { revokePersonalApiKey } from "@/api/lib/machine-api-keys/personal-lifecycle";

import { personalApiKeyIdBodySchema } from "./schema";

const config = {
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: { type: "internal", reason: "provider_secret" },
  body: personalApiKeyIdBodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const key = yield* Result.await(
      revokePersonalApiKey({
        keyId: body.keyId,
        access: "organization",
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
      }),
    );
    return Result.ok(key);
  },
);
