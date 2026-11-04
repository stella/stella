import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { properties, propertyDependencies } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  assertPropertyDependencyReadWithinLimit,
  propertyDependencyReadLimit,
} from "@/api/lib/properties/dependency-limits";

type PropertyId = SafeId<"property">;

/** One column reading another, as `property_dependencies` stores it. */
export type PropertyDependencyEdge = {
  propertyId: PropertyId;
  dependsOnPropertyId: PropertyId;
};

/**
 * Every column that reads one of `roots`, directly or through other columns,
 * excluding the roots themselves. The one walk a column edit, a new document
 * version and a cell retry use to decide what their change makes stale.
 */
export const transitiveDependents = (
  roots: Iterable<PropertyId>,
  edges: readonly PropertyDependencyEdge[],
): Set<PropertyId> => {
  const readers = new Map<PropertyId, PropertyId[]>();
  for (const { propertyId, dependsOnPropertyId } of edges) {
    const list = readers.get(dependsOnPropertyId);
    if (list) {
      list.push(propertyId);
    } else {
      readers.set(dependsOnPropertyId, [propertyId]);
    }
  }

  const rootSet = new Set(roots);
  const visited = new Set<PropertyId>();
  const queue = [...rootSet];
  // A for-of over an array visits the entries pushed while it runs.
  for (const current of queue) {
    for (const reader of readers.get(current) ?? []) {
      if (!visited.has(reader) && !rootSet.has(reader)) {
        visited.add(reader);
        queue.push(reader);
      }
    }
  }
  return visited;
};

/**
 * The computed columns (anything but manual input) of a matter that read one
 * of `rootPropertyIds`, directly or through other columns.
 */
export const readComputedDependents = async ({
  tx,
  workspaceId,
  rootPropertyIds,
}: {
  tx: Pick<Transaction, "select">;
  workspaceId: SafeId<"workspace">;
  rootPropertyIds: readonly PropertyId[];
}): Promise<Set<PropertyId>> => {
  const edges = await tx
    .select({
      propertyId: propertyDependencies.propertyId,
      dependsOnPropertyId: propertyDependencies.dependsOnPropertyId,
    })
    .from(propertyDependencies)
    .where(eq(propertyDependencies.workspaceId, workspaceId))
    .limit(propertyDependencyReadLimit("perWorkspace"));
  assertPropertyDependencyReadWithinLimit(edges.length, "perWorkspace");
  const dependents = transitiveDependents(rootPropertyIds, edges);
  if (dependents.size === 0) {
    return dependents;
  }
  const manualColumns = await tx
    .select({ id: properties.id })
    .from(properties)
    .where(
      and(
        eq(properties.workspaceId, workspaceId),
        inArray(properties.id, [...dependents]),
        sql`${properties.tool}->>'type' = 'manual-input'`,
      ),
    );
  for (const { id } of manualColumns) {
    dependents.delete(id);
  }
  return dependents;
};
