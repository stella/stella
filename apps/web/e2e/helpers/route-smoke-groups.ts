import { panic } from "better-result";

import { resolveE2eExecutionProfile } from "../execution-profile";

export const resolveRouteSmokeGroupCount = (
  profileName: string | undefined,
  groupCountOverride: string | undefined,
): number => {
  if (groupCountOverride === undefined || groupCountOverride === "") {
    return resolveE2eExecutionProfile(profileName).routeSmokeGroupCount;
  }
  if (!/^[1-9]\d*$/u.test(groupCountOverride)) {
    return panic(`Invalid E2E_ROUTE_SMOKE_GROUPS: ${groupCountOverride}`);
  }
  const parsed = Number(groupCountOverride);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return panic(`Invalid E2E_ROUTE_SMOKE_GROUPS: ${groupCountOverride}`);
  }
  return parsed;
};
