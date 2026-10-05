import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { rotatePersonalApiKey } from "@/api/lib/personal-api-key-lifecycle";

import {
  personalApiKeyExpirySchema,
  personalApiKeyIdBodySchema,
} from "./schema";

const config = {
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: { type: "internal", reason: "provider_secret" },
  body: t.Intersect([
    personalApiKeyIdBodySchema,
    t.Object({ expiresInDays: personalApiKeyExpirySchema }),
  ]),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ session, user, body, recordAuditEvent }) {
    const key = yield* Result.await(
      rotatePersonalApiKey({
        ...body,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        recordAuditEvent,
      }),
    );
    return Result.ok(key);
  },
);
