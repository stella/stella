import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createPersonalApiKey } from "@/api/lib/machine-api-keys/personal-lifecycle";

import { personalApiKeyBodySchema } from "./schema";

// permissions-exempt: Members mint only their own keys, bounded by their live role.
const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: { type: "internal", reason: "provider_secret" },
  body: personalApiKeyBodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const key = yield* Result.await(
      createPersonalApiKey({
        name: body.name,
        scopes: body.scopes,
        audience: body.audience,
        expiresInDays: body.expiresInDays,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
      }),
    );
    return Result.ok(key);
  },
);
