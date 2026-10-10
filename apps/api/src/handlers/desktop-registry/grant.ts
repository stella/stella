import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { issueDesktopAccountGrant } from "@/api/lib/auth";
import { DESKTOP_ACCOUNT_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

// permissions-exempt: a connection grant binds only the caller's account;
// document actions and registry operations keep their own resource permissions.
export default createSafeRootHandler(
  {
    permissions: DESKTOP_ACCOUNT_PERMISSION,
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    body: t.Object(
      {
        correlationId: t.String({ format: "uuid" }),
        deviceJkt: t.String({
          minLength: 43,
          maxLength: 43,
          pattern: "^[A-Za-z0-9_-]{43}$",
        }),
        verifierHash: t.String({
          minLength: 64,
          maxLength: 64,
          pattern: "^[a-f0-9]{64}$",
        }),
      },
      { additionalProperties: false },
    ),
  },
  async function* ({ user, session, body, set }) {
    set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
    return Result.ok(
      yield* Result.await(
        issueDesktopAccountGrant({
          ...body,
          userId: user.id,
          organizationId: session.activeOrganizationId,
        }),
      ),
    );
  },
);
