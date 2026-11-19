import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { roleForDisplay } from "@/api/lib/permission-authorization";

const config = {
  contract: "patch",
  // Every member may read their own role; it decides only what an app
  // offers, and every request is still decided here.
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "auth_plumbing" },
  access: "read",
} satisfies HandlerConfig;

/**
 * `GET /v1/me/role`: the caller's role in their active organization, the
 * session fact a browser reads from its auth session. A native app reads it
 * here to leave out the actions the role cannot take
 * (`@stll/permissions/role-grants`).
 */
const readMemberRole = createSafeRootHandler(
  config,
  async function* ({ memberRole }) {
    // The membership the request already resolved: no read of its own.
    const role = yield* Result.await(
      Promise.resolve(Result.ok(roleForDisplay(memberRole))),
    );
    return Result.ok({ role });
  },
);

export default readMemberRole;
