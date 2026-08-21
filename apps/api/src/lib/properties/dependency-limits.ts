import { panic } from "better-result";

import { LIMITS } from "@/api/lib/limits";

/**
 * Read bounds for the property dependency table. `perProperty` is the
 * structural ceiling, not the product cap: `(property_id, depends_on_property_id)`
 * is unique and a property cannot depend on itself, so a property holds at
 * most one row per other column. Rows written before
 * `propertyDependenciesPerProperty` existed may exceed that cap, so reads
 * bound by the ceiling and the cap applies to writes through
 * `dependencyCountExceedsCap`.
 */
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

type DependencyCountCheck = {
  /** Dependencies the request carries. */
  incoming: number;
  /** Dependencies already stored for the property; 0 on create. */
  stored: number;
};

/**
 * The write cap admits a list up to `propertyDependenciesPerProperty`. A
 * stored list already past it (written under an earlier, larger cap) may be
 * kept or shrunk but never grown.
 */
export const dependencyCountExceedsCap = ({
  incoming,
  stored,
}: DependencyCountCheck): boolean =>
  incoming > Math.max(LIMITS.propertyDependenciesPerProperty, stored);
