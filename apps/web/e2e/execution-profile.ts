import { panic } from "better-result";

export { E2E_SHARD_COUNT } from "./shard-count";

export const E2E_EXECUTION_PROFILE = {
  standard: "standard",
  networkBaseline: "network-baseline",
  ciProductionParallel: "ci-production-parallel",
} as const;

const EXECUTION_PROFILES = {
  [E2E_EXECUTION_PROFILE.networkBaseline]: {
    routeSmokeGroupCount: 1,
    workerCount: 1,
  },
  [E2E_EXECUTION_PROFILE.standard]: {
    routeSmokeGroupCount: 2,
    workerCount: 1,
  },
  [E2E_EXECUTION_PROFILE.ciProductionParallel]: {
    routeSmokeGroupCount: 4,
    workerCount: 2,
  },
} as const;

export const resolveE2eExecutionProfile = (name: string | undefined) => {
  const resolvedName = name ?? E2E_EXECUTION_PROFILE.standard;
  switch (resolvedName) {
    case E2E_EXECUTION_PROFILE.networkBaseline:
      return EXECUTION_PROFILES[E2E_EXECUTION_PROFILE.networkBaseline];
    case E2E_EXECUTION_PROFILE.standard:
      return EXECUTION_PROFILES[E2E_EXECUTION_PROFILE.standard];
    case E2E_EXECUTION_PROFILE.ciProductionParallel:
      return EXECUTION_PROFILES[E2E_EXECUTION_PROFILE.ciProductionParallel];
    default:
      return panic(`Unknown E2E execution profile: ${resolvedName}`);
  }
};

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

export const partitionRoundRobin = <T>(
  items: readonly T[],
  groupCount: number,
): T[][] => {
  if (!Number.isSafeInteger(groupCount) || groupCount < 1) {
    panic("E2E group count must be a positive safe integer");
  }

  return Array.from({ length: groupCount }, (_unused, groupIndex) =>
    items.filter(
      (_unusedItem, itemIndex) => itemIndex % groupCount === groupIndex,
    ),
  );
};
