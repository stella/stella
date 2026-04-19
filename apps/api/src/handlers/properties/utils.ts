import type { Err } from "better-result";
import { Result } from "better-result";
import { deepEquals } from "bun";

import type { SafeDb, SafeDbError } from "@/api/db";
import type {
  AIModelTool,
  ManualInputTool,
  PropertyContent,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { sortDeep } from "@/api/lib/sort-deep";
import type { PropertyCondition } from "@/api/types";

type PropertyForComparison = {
  content: PropertyContent;
  tool:
    | ManualInputTool
    | (AIModelTool & {
        dependencies: {
          dependsOnPropertyId: string;
          condition: PropertyCondition | null;
        }[];
      });
};

type ComparePropertiesForStaleProps = {
  oldProperty: PropertyForComparison | undefined;
  newProperty: PropertyForComparison;
};

/**
 * Normalize dependencies to a deterministic order so that
 * DB queries without ORDER BY don't cause spurious diffs.
 */
const normalizeDeps = (prop: PropertyForComparison): PropertyForComparison => {
  if (prop.tool.type !== "ai-model") {
    return prop;
  }

  return {
    ...prop,
    tool: {
      ...prop.tool,
      dependencies: prop.tool.dependencies.toSorted((a, b) =>
        a.dependsOnPropertyId.localeCompare(b.dependsOnPropertyId),
      ),
    },
  };
};

export const comparePropertiesForStale = ({
  oldProperty,
  newProperty,
}: ComparePropertiesForStaleProps) => {
  if (!oldProperty) {
    return true;
  }

  if (oldProperty.content.type !== newProperty.content.type) {
    return true;
  }

  const sortedOld = sortDeep(normalizeDeps(oldProperty));
  const sortedNew = sortDeep(normalizeDeps(newProperty));

  return !deepEquals(sortedOld, sortedNew);
};

type ValidatePropertyInputsProps = {
  safeDb: SafeDb;
  propertyId: string;
  workspaceId: SafeId<"workspace">;
  proposedInputs: string[];
};

export const validatePropertyInputs = async function* ({
  safeDb,
  propertyId,
  workspaceId,
  proposedInputs,
}: ValidatePropertyInputsProps): AsyncGenerator<
  Err<never, SafeDbError>,
  Result<void, string[]>,
  unknown
> {
  const workspaceProperties = yield* Result.await(
    safeDb((tx) =>
      tx.query.properties.findMany({
        where: {
          workspaceId: { eq: workspaceId },
        },
        columns: { id: true },
        with: {
          dependencies: {
            columns: {
              dependsOnPropertyId: true,
            },
          },
        },
      }),
    ),
  );

  const dependencyGraph = new Map<string, string[]>();
  for (const property of workspaceProperties) {
    // Skip existing dependencies of the current property (we'll replace them)
    if (property.id === propertyId) {
      continue;
    }

    dependencyGraph.set(
      property.id,
      property.dependencies.map((d) => d.dependsOnPropertyId),
    );
  }

  // Add the proposed inputs for the current property
  dependencyGraph.set(propertyId, proposedInputs);

  // DFS to detect if there's a path from any proposed input back to propertyId
  const detectCycle = (
    startId: string,
    visited: Set<string>,
    path: string[],
  ): string[] | null => {
    if (startId === propertyId) {
      return [...path, propertyId];
    }

    if (visited.has(startId)) {
      return null;
    }

    visited.add(startId);
    path.push(startId);

    const inputs = dependencyGraph.get(startId) ?? [];
    for (const inputId of inputs) {
      const cycle = detectCycle(inputId, visited, path);
      if (cycle) {
        return cycle;
      }
    }

    path.pop();
    return null;
  };

  for (const inputId of proposedInputs) {
    if (inputId === propertyId) {
      return Result.err([propertyId, propertyId]);
    }

    const cycle = detectCycle(inputId, new Set(), [propertyId]);

    if (cycle) {
      return Result.err(cycle);
    }
  }

  return Result.ok();
};
