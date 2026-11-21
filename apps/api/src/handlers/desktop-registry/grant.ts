import { Result } from "better-result";
import * as v from "valibot";

import { CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL } from "@/api/http/cache";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { issueDesktopAccountGrant } from "@/api/lib/auth";
import { DESKTOP_ACCOUNT_PERMISSION } from "@/api/lib/business-registries/desktop/config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

// permissions-exempt: a connection grant binds only the caller's account;
// document actions and registry operations keep their own resource permissions.
export default createSafeRootHandler(
  {
    contract: "patch",
    permissions: DESKTOP_ACCOUNT_PERMISSION,
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "internal", reason: "auth_plumbing" },
    body: v.strictObject({
      correlationId: v.pipe(v.string(), v.uuid()),
      deviceJkt: v.pipe(
        v.string(),
        v.minLength(43),
        v.maxLength(43),
        v.regex(/^[A-Za-z0-9_-]{43}$/u),
      ),
      verifierHash: v.pipe(
        v.string(),
        v.minLength(64),
        v.maxLength(64),
        v.regex(/^[a-f0-9]{64}$/u),
      ),
    }),
  },
  async function* ({ user, session, body, set }) {
    set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
    // Redemption issues only under the browser session that asked for it.
    if (session.id === null) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Sign in again to connect stella desktop",
        }),
      );
    }
    return Result.ok(
      yield* Result.await(
        issueDesktopAccountGrant({
          ...body,
          userId: user.id,
          organizationId: session.activeOrganizationId,
          sessionId: session.id,
        }),
      ),
    );
  },
);
