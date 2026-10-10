import { panic, Result, TaggedError } from "better-result";

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  readFreeTier,
  resolveOrganizationAccess,
  type OrganizationAccess,
} from "@/api/lib/usage/organization-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";

export const allowsLawRead = (access: OrganizationAccess): boolean => {
  switch (access.type) {
    case "paid":
    case "evaluation":
    case "free":
      return true;
    case "self_managed_keys":
    case "ended":
    case "unavailable":
      return false;
    default:
      access satisfies never;
      return panic("Unhandled organization access");
  }
};

export class OrganizationAccessReadError extends TaggedError(
  "OrganizationAccessReadError",
)<{ message: string; cause: unknown }> {}

type PublicLawAccessDependencies = {
  organizationAccessEnabled?: () => boolean;
  readAccess?: () => Promise<OrganizationAccess>;
};

export const mayReadPublicLaw = async (
  db: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
  {
    organizationAccessEnabled = () =>
      isDeploymentFeatureEnabled("FEATURE_ORG_ACCESS_STATE"),
    readAccess = async () => {
      const snapshot = await readOrganizationAccessSnapshot(db, organizationId);
      const freeTier = await readFreeTier(db);
      return resolveOrganizationAccess({
        snapshot,
        now: new Date(),
        freeTier,
      });
    },
  }: PublicLawAccessDependencies = {},
) => {
  if (!organizationAccessEnabled()) {
    return Result.ok(true);
  }
  const access = await Result.tryPromise({
    try: readAccess,
    catch: (cause) =>
      new OrganizationAccessReadError({
        message: "Organization access could not be read",
        cause,
      }),
  });
  if (Result.isError(access)) {
    return Result.err(access.error);
  }
  return Result.ok(allowsLawRead(access.value));
};
