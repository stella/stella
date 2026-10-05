import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createPersonalApiKey } from "@/api/lib/personal-api-key-lifecycle";

import { personalApiKeyBodySchema } from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: { type: "internal", reason: "provider_secret" },
  body: personalApiKeyBodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const key = yield* Result.await(
      createPersonalApiKey({
        ...body,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
      }),
    );
    return Result.ok(key);
  },
);
