import { Result } from "better-result";
import { t } from "elysia";

import { SSO_ENFORCEMENT_MODES } from "@/api/db/auth-schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { getAuth, getSessionSsoProviderId } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { setSsoEnforcement } from "@/api/lib/sso-connections";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "auth_plumbing" },
  body: t.Object({ mode: t.UnionEnum(SSO_ENFORCEMENT_MODES) }),
} satisfies HandlerConfig;

const updateEnforcement = createSafeRootHandler(
  config,
  async function* ({ session, request, body, recordAuditEvent }) {
    const current = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getAuth().api.getSession({ headers: request.headers }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not verify the current authentication method",
            cause,
          }),
      }),
    );

    const connection = yield* Result.await(
      setSsoEnforcement({
        organizationId: session.activeOrganizationId,
        mode: body.mode,
        currentSessionSsoProviderId: getSessionSsoProviderId(current?.session),
        recordAuditEvent,
      }),
    );
    return Result.ok(connection);
  },
);

export default updateEnforcement;
