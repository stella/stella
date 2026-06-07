import Elysia from "elysia";

import createHostedManagement from "@/api/handlers/usage/create-hosted-management";
import createHostedSetup from "@/api/handlers/usage/create-hosted-setup";
import getEntitlement from "@/api/handlers/usage/get-entitlement";
import { authMacro, permissionMacro } from "@/api/lib/auth";
import { invalidateQuery } from "@/api/lib/invalidate-query-macro";

// Operator-driven admin endpoints (manual entitlement upsert,
// discretionary usage allocations) are deliberately NOT mounted on this
// branch. They need a dedicated platform-staff permission gate
// (owner-of-own-org is too broad — would let any owner
// allocate units to themselves) and must run their writes through
// `rootDb` so the restrictive RLS deny on
// `usage_entitlements`/`usage_allocations` does not block them. Both
// land in a follow-up PR per the original plan.
export const usageRoute = new Elysia({ prefix: "/usage" })
  .use(authMacro)
  .use(permissionMacro)
  .use(invalidateQuery)
  .guard({ validateAuth: true })
  .get("/entitlement", getEntitlement.handler, {
    permissions: getEntitlement.config.permissions,
  })
  .post("/hosted/setup", createHostedSetup.handler, {
    body: createHostedSetup.config.body,
    permissions: createHostedSetup.config.permissions,
  })
  .post("/hosted/management", createHostedManagement.handler, {
    permissions: createHostedManagement.config.permissions,
  });
