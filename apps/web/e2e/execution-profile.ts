import { panic } from "better-result";

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
