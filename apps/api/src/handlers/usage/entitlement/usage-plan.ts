import { panic, Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { OrganizationAccess } from "@/api/lib/usage/organization-access";

/** Only the plan kind crosses the boundary; internal budgets never do. */
export const projectUsagePlan = (access: OrganizationAccess) => {
  switch (access.type) {
    case "paid":
    case "evaluation":
    case "free":
    case "self_managed_keys":
      return Result.ok({ plan: { type: access.type } });
    case "ended":
    case "unavailable":
      return Result.err(
        new HandlerError({
          status: 503,
          code: "organization_access_unavailable",
          message: "The organization's plan could not be resolved",
        }),
      );
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};
