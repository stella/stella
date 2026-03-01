import { Result } from "better-result";

import type { WorkspaceProperty } from "@/lib/types";

const getPropertyInputs = (property: WorkspaceProperty | undefined) => {
  const inputs: string[] = [];

  if (property?.tool.type === "ai-model") {
    inputs.push(
      ...property.tool.dependencies.map((d) => d.dependsOnPropertyId),
    );
  }

  return inputs;
};

type ValidatePropertyInputsProps = {
  currentPropertyId: string;
  currentInputs: string[];
  properties: WorkspaceProperty[];
};

export const validatePropertyInputs = ({
  currentPropertyId,
  currentInputs,
  properties,
}: ValidatePropertyInputsProps): Result<void, string[]> => {
  const propertyMap = new Map(properties.map((p) => [p.id, p]));

  // DFS to detect if there's a path from any proposed input back to currentPropertyId
  const detectCycle = (
    startId: string,
    visited: Set<string>,
    path: string[],
  ): string[] | null => {
    if (startId === currentPropertyId) {
      return [...path, currentPropertyId];
    }

    if (visited.has(startId)) {
      return null;
    }

    visited.add(startId);
    path.push(startId);

    const inputs = getPropertyInputs(propertyMap.get(startId));

    for (const inputId of inputs) {
      const cycle = detectCycle(inputId, visited, path);
      if (cycle) {
        return cycle;
      }
    }

    path.pop();
    return null;
  };

  for (const inputId of currentInputs) {
    if (inputId === currentPropertyId) {
      return Result.err([currentPropertyId, currentPropertyId]);
    }

    const cycle = detectCycle(inputId, new Set(), [currentPropertyId]);
    if (cycle) {
      return Result.err(cycle);
    }
  }

  return Result.ok();
};
