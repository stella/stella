import { sort } from "@tamtamchik/json-deep-sort";
import { Result } from "better-result";
import { deepEquals } from "bun";

import { db } from "@/api/db";
import type {
  AIModelTool,
  ManualInputTool,
  PropertyContent,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
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

  const sortedOldProperty = sort(oldProperty, true, true);
  const sortedNewProperty = sort(newProperty, true, true);

  const isEqual = deepEquals(sortedOldProperty, sortedNewProperty);

  return !isEqual;
};

type ValidatePropertyInputsProps = {
  propertyId: string;
  workspaceId: SafeId<"workspace">;
  proposedInputs: string[];
};

export const validatePropertyInputs = async ({
  propertyId,
  workspaceId,
  proposedInputs,
}: ValidatePropertyInputsProps): Promise<Result<void, string[]>> => {
  const workspaceProperties = await db.query.properties.findMany({
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
  });

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
