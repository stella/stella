import { panic } from "better-result";

import type { ConditionNode } from "@stll/conditions";

import type { ScopedDb } from "@/api/db/safe-db";
import type { PropertyStatus } from "@/api/db/schema";
import type {
  AIModelTool,
  PlaybookVerdictTool,
  PropertyTool,
} from "@/api/db/schema-validators";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { parseStoredCondition } from "@/api/lib/conditions/parse-stored";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedPropertyId } from "@/api/lib/safe-id-boundaries";
import type { PropertyContent } from "@/api/types";

/**
 * Whether a property is queued for the workflow to (re)compute it.
 *
 * Exhaustive over `PropertyStatus` so adding a future status (e.g.
 * "computing", "errored") becomes a TS compile error here — the
 * planner can't silently skip new states and leave callers stuck
 * on optimistic pending forever.
 */
const needsComputation = (status: PropertyStatus): boolean => {
  switch (status) {
    case "stale":
      return true;
    case "fresh":
      return false;
    default: {
      const exhaustive: never = status;
      return panic(`Unhandled property status: ${String(exhaustive)}`);
    }
  }
};

type DependencySignature = string; // Sorted, joined property IDs

const toPropertyId = (value: string) => brandPersistedPropertyId(value);

export type BatchPropertyDependency = {
  dependsOnPropertyId: string;
  condition: ConditionNode | null;
};

type BatchPropertyBase = {
  id: SafeId<"property">;
  status: PropertyStatus;
  content: Exclude<PropertyContent, { type: "file" }>;
  dependencies: BatchPropertyDependency[];
};

// An extraction column the LLM fills from the document.
export type AIBatchProperty = BatchPropertyBase & {
  tool: AIModelTool;
};

// A derived verdict column graded after its ASK extraction (see
// `playbookVerdictToolSchema`). Carried in the same batch machinery as
// `AIBatchProperty` but dispatched to the verdict engine, never the LLM
// extraction path.
export type VerdictBatchProperty = BatchPropertyBase & {
  tool: PlaybookVerdictTool;
};

export type BatchProperty = AIBatchProperty | VerdictBatchProperty;

export type PropertyBatch = {
  id: string;
  inputs: SafeId<"property">[];
  properties: BatchProperty[];
};

export type ExecutionLevel = PropertyBatch[];

export type ExecutionPlanProperty = {
  id: SafeId<"property">;
  status: PropertyStatus;
  content: PropertyContent;
  tool: PropertyTool;
};

export type PropertyDependency = {
  propertyId: string;
  dependsOnPropertyId: string;
  condition: ConditionNode | null;
};

type DependencyGraph = {
  propertyDependenciesMap: Map<string, BatchPropertyDependency[]>;
  dependsOn: Map<string, Set<string>>;
  inDegree: Map<string, number>;
  dependents: Map<string, string[]>;
  propertyIds: Set<string>;
};

type ExecutionPlanData = {
  properties: ExecutionPlanProperty[];
  dependencies: PropertyDependency[];
};

export const getExecutionPlanData = async (
  workspaceId: SafeId<"workspace">,
  scopedDb: ScopedDb,
): Promise<ExecutionPlanData> => {
  const propertiesResult = await scopedDb((tx) =>
    tx.query.properties.findMany({
      columns: {
        id: true,
        status: true,
        content: true,
        tool: true,
      },
      with: {
        dependencies: {
          columns: {
            dependsOnPropertyId: true,
            condition: true,
          },
        },
      },
      where: {
        workspaceId: { eq: workspaceId },
      },
      limit: LIMITS.propertiesCount,
    }),
  );

  const allProperties: ExecutionPlanProperty[] = propertiesResult.map(
    (property) => ({
      id: property.id,
      status: property.status,
      content: property.content,
      tool: property.tool,
    }),
  );

  const edges: PropertyDependency[] = propertiesResult.flatMap((property) =>
    property.dependencies.flatMap((dep) => {
      const parsed = parseStoredCondition(
        dep.condition,
        dep.dependsOnPropertyId,
      );
      if (parsed.status === "invalid") {
        return [];
      }
      return [
        {
          propertyId: property.id,
          dependsOnPropertyId: dep.dependsOnPropertyId,
          condition: parsed.condition,
        },
      ];
    }),
  );

  return { properties: allProperties, dependencies: edges };
};

export const buildDependencyGraph = ({
  properties,
  dependencies,
}: ExecutionPlanData): DependencyGraph => {
  const propertyDependenciesMap = new Map<string, BatchPropertyDependency[]>();

  for (const edge of dependencies) {
    if (!propertyDependenciesMap.has(edge.propertyId)) {
      propertyDependenciesMap.set(edge.propertyId, []);
    }
    propertyDependenciesMap.get(edge.propertyId)?.push({
      dependsOnPropertyId: edge.dependsOnPropertyId,
      condition: edge.condition,
    });
  }

  const propertyIds = new Set(properties.map((p) => p.id));

  const dependsOn = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const id of propertyIds) {
    dependsOn.set(id, new Set());
    inDegree.set(id, 0);
    dependents.set(id, []);
  }

  for (const edge of dependencies) {
    dependsOn.get(edge.propertyId)?.add(edge.dependsOnPropertyId);
    inDegree.set(edge.propertyId, (inDegree.get(edge.propertyId) ?? 0) + 1);
    dependents.get(edge.dependsOnPropertyId)?.push(edge.propertyId);
  }

  return {
    propertyDependenciesMap,
    dependsOn,
    inDegree,
    dependents,
    propertyIds,
  };
};

export const buildLevelBatches = (
  levelPropertyIds: string[],
  propertiesById: Map<string, ExecutionPlanProperty>,
  graph: DependencyGraph,
): PropertyBatch[] => {
  const signatureToProperties = new Map<DependencySignature, BatchProperty[]>();

  for (const propId of levelPropertyIds) {
    const deps = graph.dependsOn.get(propId) ?? new Set();
    const signature = [...deps].toSorted().join(",");

    if (!signatureToProperties.has(signature)) {
      signatureToProperties.set(signature, []);
    }

    const property = propertiesById.get(propId);
    if (!property) {
      panic("Property in dependency graph not found");
    }

    if (
      property.content.type === "file" ||
      !needsComputation(property.status)
    ) {
      continue;
    }

    const dependencies = arrayOrEmpty(
      graph.propertyDependenciesMap.get(propId),
    );
    const base = {
      id: property.id,
      status: property.status,
      content: property.content,
      dependencies,
    };

    // ai-model columns run the LLM extraction; playbook-verdict columns are
    // graded by the verdict engine after their ASK dependency resolves. Both
    // ride the same batch/level machinery so the DAG schedules a verdict in a
    // later level than the ASK property it depends on. manual-input columns
    // are user-entered and never computed.
    // Two separate narrowing branches (not a shared else-if) so TS resolves
    // property.tool to a single discriminated-union member for each push; it
    // cannot distribute AIModelTool | PlaybookVerdictTool across the spread.
    const computed = signatureToProperties.get(signature);
    if (property.tool.type === "ai-model") {
      computed?.push({ ...base, tool: property.tool });
    }
    if (property.tool.type === "playbook-verdict") {
      computed?.push({ ...base, tool: property.tool });
    }
  }

  const batches: PropertyBatch[] = [];
  for (const [signature, batchProperties] of signatureToProperties) {
    if (batchProperties.length > 0) {
      batches.push({
        id: Bun.randomUUIDv7(),
        inputs: signature ? signature.split(",").map(toPropertyId) : [],
        properties: batchProperties,
      });
    }
  }

  return batches;
};

export const getPropertyExecutionPlan = ({
  properties,
  dependencies,
}: ExecutionPlanData): ExecutionLevel[] => {
  const graph = buildDependencyGraph({ properties, dependencies });
  const propertiesById = new Map(properties.map((p) => [p.id, p]));

  const levels: ExecutionLevel[] = [];
  let currentLevelIds = [...graph.propertyIds].filter(
    (id) => graph.inDegree.get(id) === 0,
  );

  while (currentLevelIds.length > 0) {
    levels.push(buildLevelBatches(currentLevelIds, propertiesById, graph));

    const nextLevelIds: string[] = [];
    for (const current of currentLevelIds) {
      const dependents = graph.dependents.get(current) ?? new Set<string>();
      for (const dependent of dependents) {
        const newDegree = (graph.inDegree.get(dependent) ?? 1) - 1;
        graph.inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          nextLevelIds.push(dependent);
        }
      }
    }
    currentLevelIds = nextLevelIds;
  }

  // Remove the first level, which has only properties without inputs
  return levels.slice(1);
};
