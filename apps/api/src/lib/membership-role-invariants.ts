import { APIError } from "better-auth/api";

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
