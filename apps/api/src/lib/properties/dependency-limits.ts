import { panic } from "better-result";

import { LIMITS } from "@/api/lib/limits";

export const PROPERTY_DEPENDENCY_LIMITS = {
  perProperty: LIMITS.propertiesCount - 1,
  perWorkspace: LIMITS.propertiesCount * (LIMITS.propertiesCount - 1),
  ownersPerWorkspace: LIMITS.propertiesCount,
} as const;

export type PropertyDependencyLimitScope =
  keyof typeof PROPERTY_DEPENDENCY_LIMITS;

export const propertyDependencyReadLimit = (
  scope: PropertyDependencyLimitScope,
): number => PROPERTY_DEPENDENCY_LIMITS[scope] + 1;

export const assertPropertyDependencyReadWithinLimit = (
  rowCount: number,
  scope: PropertyDependencyLimitScope,
): void => {
  const maximum = PROPERTY_DEPENDENCY_LIMITS[scope];
  if (rowCount <= maximum) {
    return;
  }

  panic(
    `Property dependency ${scope} invariant exceeded: read ${rowCount}, maximum ${maximum}`,
  );
};
