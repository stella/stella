import { APIError } from "better-auth/api";

import { MATTER_STEWARD_HANDOVER_REQUIRED_CODE } from "@stll/api-contract/matter-visibility";

import { MATTER_STEWARD_CONSTRAINT } from "@/api/lib/db/constraint-refusals";
import { isRecord } from "@/api/lib/type-guards";

export const OWNER_REQUIRED_CONSTRAINT = "member_organization_owner_required";
export const OWNER_REQUIRED_ERROR_CODE =
  "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER";

export const ownerRequiredError = () =>
  new APIError("BAD_REQUEST", {
    code: OWNER_REQUIRED_ERROR_CODE,
    message: "The organization must retain at least one owner.",
  });

/** Drizzle wraps the driver's named constraint in a cause. */
export const mapMembershipInvariantError = (error: unknown): unknown => {
  const visited = new Set<unknown>();
  let cause = error;
  while (isRecord(cause) && !visited.has(cause)) {
    visited.add(cause);
    const constraint = cause["constraint_name"] ?? cause["constraint"];
    if (constraint === OWNER_REQUIRED_CONSTRAINT) {
      return ownerRequiredError();
    }
    if (constraint === MATTER_STEWARD_CONSTRAINT) {
      return new APIError("CONFLICT", {
        code: MATTER_STEWARD_HANDOVER_REQUIRED_CODE,
        message:
          "This member is the last internal member assigned to a matter visible to assigned members only. Assign another internal member to those matters first.",
      });
    }
    if (
      constraint === "member_single_product_role" ||
      constraint === "invitation_single_product_role"
    ) {
      return new APIError("BAD_REQUEST", {
        code: "invalid_member_role",
        message: "Select one product membership role.",
      });
    }
    cause = cause["cause"];
  }
  return error;
};
