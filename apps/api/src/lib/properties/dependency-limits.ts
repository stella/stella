import { panic } from "better-result";

import { LIMITS } from "@/api/lib/limits";

/**
 * Read bounds for the property dependency table, each the product of the
 * write-time caps that feed it. `perProperty` is enforced on every create and
 * update body, so a workspace holds at most `propertiesCount` owners with
 * `perProperty` rows each: the workspace read grows linearly with the column
 * cap, not quadratically.
 */
export const PROPERTY_DEPENDENCY_LIMITS = {
  perProperty: LIMITS.propertyDependenciesPerProperty,
  perWorkspace: LIMITS.propertiesCount * LIMITS.propertyDependenciesPerProperty,
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
