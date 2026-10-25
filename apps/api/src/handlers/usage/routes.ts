import assignSeat from "@/api/handlers/usage/assign-seat";
import createHostedManagement from "@/api/handlers/usage/create-hosted-management";
import createHostedSetup from "@/api/handlers/usage/create-hosted-setup";
import getEntitlement from "@/api/handlers/usage/entitlement/get";
import getAccess from "@/api/handlers/usage/get-access";
import getLane from "@/api/handlers/usage/get-lane";
import listPolicies from "@/api/handlers/usage/list-policies";
import listSeatAssignments from "@/api/handlers/usage/list-seat-assignments";
import unassignSeat from "@/api/handlers/usage/unassign-seat";
import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

// Operator-driven admin endpoints (manual entitlement upsert,
// discretionary usage allocations) are deliberately NOT mounted here. They
// need a dedicated platform-staff permission gate (owner-of-own-org is too
// broad: any owner could allocate units to themselves) and must run their
// writes through `rootDb` so the restrictive RLS deny on
// `usage_entitlements`/`usage_allocations` does not block them.
//
// Without the usage feature these routes answer like absent ones, before
// authentication or input validation. The provider webhook is mounted on its
// own and keeps its delivery contract.
export const usageRoute = routes(
  {
    "/entitlement": { GET: getEntitlement },
    "/access": { GET: getAccess },
    "/lane": { GET: getLane },
    "/policies": { GET: listPolicies },
    "/assignments": {
      GET: listSeatAssignments,
      POST: assignSeat,
      DELETE: unassignSeat,
    },
    "/hosted/setup": { POST: createHostedSetup },
    "/hosted/management": { POST: createHostedManagement },
  },
  {
    prefix: "/usage",
    middleware: [deploymentFeatureGate("FEATURE_USAGE")],
  },
);
