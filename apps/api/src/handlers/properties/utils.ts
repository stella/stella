import { deepEquals } from "bun";

import type { ConditionNode } from "@stll/conditions";

import type {
  AIModelTool,
  ManualInputTool,
  PropertyContent,
} from "@/api/db/schema-validators";
import { sortDeep } from "@/api/lib/sort-deep";

type PropertyForComparison = {
  content: PropertyContent;
  tool:
    | ManualInputTool
    | (AIModelTool & {
        dependencies: {
          dependsOnPropertyId: string;
          condition: ConditionNode | null;
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
        // oxlint-disable-next-line require-cached-collator/require-cached-collator -- dependsOnPropertyId is an internal id, sorted for determinism, not display text
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
