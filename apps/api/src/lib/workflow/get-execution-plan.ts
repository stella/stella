import { panic } from "better-result";

import type { ScopedDb } from "@/api/db";
import type { PropertyStatus } from "@/api/db/schema";
import type {
  AIModelTool,
  PropertyCondition,
  PropertyTool,
} from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import type { PropertyContent } from "@/api/types";

type DependencySignature = string; // Sorted, joined property IDs

const toPropertyId = (value: string) => toSafeId<"property">(value);

export type BatchPropertyDependency = {
  dependsOnPropertyId: string;
  condition: PropertyCondition | null;
};

export type BatchProperty = {
  id: SafeId<"property">;
  status: PropertyStatus;
  content: Exclude<PropertyContent, { type: "file" }>;
  tool: AIModelTool;
  dependencies: BatchPropertyDependency[];
};

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
  condition: PropertyCondition | null;
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
    property.dependencies.map((dep) => ({
      propertyId: property.id,
      dependsOnPropertyId: dep.dependsOnPropertyId,
      condition: dep.condition,
    })),
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
      property.content.type !== "file" &&
      property.tool.type === "ai-model" &&
      property.status === "stale"
    ) {
      signatureToProperties.get(signature)?.push({
        id: property.id,
        status: property.status,
        content: property.content,
        tool: property.tool,
        dependencies: graph.propertyDependenciesMap.get(propId) ?? [],
      });
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
      for (const dependent of graph.dependents.get(current) ?? []) {
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
