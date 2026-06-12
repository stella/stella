import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  buildDependencyGraph,
  buildLevelBatches,
  getPropertyExecutionPlan,
} from "@/api/lib/workflow/get-execution-plan";
import type {
  BatchPropertyDependency,
  ExecutionPlanProperty,
  PropertyDependency,
} from "@/api/lib/workflow/get-execution-plan";

const aiModelTool = {
  version: 1 as const,
  type: "ai-model" as const,
  prompt: "test",
};

const manualInputTool = {
  version: 1 as const,
  type: "manual-input" as const,
};

const textContent = {
  version: 1 as const,
  type: "text" as const,
  value: "x",
};

const fileContent = {
  version: 1 as const,
  type: "file" as const,
};

const createProperty = (
  id: string,
  overrides: Partial<ExecutionPlanProperty> = {},
): ExecutionPlanProperty => ({
  id: toSafeId<"property">(id),
  status: "stale",
  content: textContent,
  tool: aiModelTool,
  ...overrides,
});

const propertyId = (value: string) => toSafeId<"property">(value);
type TestPropertyId = ReturnType<typeof propertyId>;

const propertyIds = (...values: string[]): TestPropertyId[] =>
  values.map(propertyId);

const propertySet = (...values: string[]): Set<TestPropertyId> =>
  new Set(propertyIds(...values));

const propertyMap = <Value>(
  entries: [string, Value][],
): Map<TestPropertyId, Value> =>
  new Map(entries.map(([id, value]) => [propertyId(id), value]));

const propertyDependency = (
  property: string,
  dependsOn: string,
): PropertyDependency => ({
  propertyId: propertyId(property),
  dependsOnPropertyId: propertyId(dependsOn),
  condition: null,
});

const batchPropertyDependency = (
  dependsOn: string,
): BatchPropertyDependency => ({
  dependsOnPropertyId: propertyId(dependsOn),
  condition: null,
});

describe("buildDependencyGraph", () => {
  test("builds graph with no edges", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("p1"),
      createProperty("p2"),
    ];
    const edges: PropertyDependency[] = [];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.propertyIds).toEqual(propertySet("p1", "p2"));
    expect(graph.inDegree.get(propertyId("p1"))).toBe(0);
    expect(graph.inDegree.get(propertyId("p2"))).toBe(0);
  });

  test("builds graph with diamond dependency structure", () => {
    // A -> B, A -> C, B -> D, C -> D
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
      createProperty("C"),
      createProperty("D"),
    ];
    const edges: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "A"),
      propertyDependency("D", "B"),
      propertyDependency("D", "C"),
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get(propertyId("A"))).toBe(0);
    expect(graph.inDegree.get(propertyId("B"))).toBe(1);
    expect(graph.inDegree.get(propertyId("C"))).toBe(1);
    expect(graph.inDegree.get(propertyId("D"))).toBe(2);

    expect(
      [...(graph.dependents.get(propertyId("A")) ?? [])].toSorted(),
    ).toEqual(propertyIds("B", "C"));
    expect(graph.dependents.get(propertyId("B"))).toEqual(propertyIds("D"));
    expect(graph.dependents.get(propertyId("C"))).toEqual(propertyIds("D"));
  });

  test("builds graph with self-dependency A -> A", () => {
    const properties: ExecutionPlanProperty[] = [createProperty("A")];
    const edges: PropertyDependency[] = [propertyDependency("A", "A")];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get(propertyId("A"))).toBe(1);
    expect(graph.dependents.get(propertyId("A"))).toEqual(propertyIds("A"));
    expect(graph.dependsOn.get(propertyId("A"))).toEqual(propertySet("A"));
  });

  test("builds graph with duplicate edges (B depends on A twice)", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const edges: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("B", "A"),
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get(propertyId("A"))).toBe(0);
    expect(graph.inDegree.get(propertyId("B"))).toBe(2);
    expect(graph.dependents.get(propertyId("A"))).toEqual(
      propertyIds("B", "B"),
    );
  });

  test("builds graph with dangling edge (dependency references property not in properties)", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const edges: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "B"),
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.propertyIds).toEqual(propertySet("A", "B"));
    expect(graph.inDegree.get(propertyId("C"))).toBe(1);
    expect(graph.dependents.get(propertyId("B"))).toEqual(propertyIds("C"));
  });
});

describe("buildLevelBatches", () => {
  test("groups properties with identical dependency signature into same batch", () => {
    const pA = createProperty("A");
    const pB = createProperty("B");
    const pC = createProperty("C");

    const propertyDependenciesMap = new Map<
      TestPropertyId,
      BatchPropertyDependency[]
    >();
    propertyDependenciesMap.set(propertyId("B"), [
      batchPropertyDependency("A"),
    ]);
    propertyDependenciesMap.set(propertyId("C"), [
      batchPropertyDependency("A"),
    ]);

    const dependsOn = new Map<TestPropertyId, Set<TestPropertyId>>();
    dependsOn.set(propertyId("B"), propertySet("A"));
    dependsOn.set(propertyId("C"), propertySet("A"));

    const graph = {
      propertyDependenciesMap,
      dependsOn,
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("A", "B", "C"),
    };

    const propertiesById = propertyMap([
      ["A", pA],
      ["B", pB],
      ["C", pC],
    ]);

    const batches = buildLevelBatches(
      propertyIds("B", "C"),
      propertiesById,
      graph,
    );

    expect(batches.length).toBe(1);
    expect(batches[0]?.inputs).toEqual([propertyId("A")]);
    expect(batches[0]?.properties.map((p) => p.id).toSorted()).toEqual([
      propertyId("B"),
      propertyId("C"),
    ]);
  });

  test("excludes file-type properties from batches", () => {
    const pFile = createProperty("p1", { content: fileContent });
    const propertiesById = propertyMap([["p1", pFile]]);
    const graph = {
      propertyDependenciesMap: new Map(),
      dependsOn: new Map<TestPropertyId, Set<TestPropertyId>>([
        [propertyId("p1"), propertySet()],
      ]),
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("p1"),
    };

    const batches = buildLevelBatches(propertyIds("p1"), propertiesById, graph);

    expect(batches.length).toBe(0);
  });

  test("excludes manual-input tool properties from batches", () => {
    const pManual = createProperty("p1", { tool: manualInputTool });
    const propertiesById = propertyMap([["p1", pManual]]);
    const graph = {
      propertyDependenciesMap: new Map(),
      dependsOn: new Map<TestPropertyId, Set<TestPropertyId>>([
        [propertyId("p1"), propertySet()],
      ]),
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("p1"),
    };

    const batches = buildLevelBatches(propertyIds("p1"), propertiesById, graph);

    expect(batches.length).toBe(0);
  });

  test("excludes fresh properties from batches", () => {
    const pFresh = createProperty("p1", { status: "fresh" });
    const propertiesById = propertyMap([["p1", pFresh]]);
    const graph = {
      propertyDependenciesMap: new Map(),
      dependsOn: new Map<TestPropertyId, Set<TestPropertyId>>([
        [propertyId("p1"), propertySet()],
      ]),
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("p1"),
    };

    const batches = buildLevelBatches(propertyIds("p1"), propertiesById, graph);

    expect(batches.length).toBe(0);
  });

  test("includes only stale properties when mixed with fresh", () => {
    const pA = createProperty("A", { status: "fresh" });
    const pB = createProperty("B", { status: "stale" });

    const propertyDependenciesMap = new Map<
      TestPropertyId,
      BatchPropertyDependency[]
    >();
    propertyDependenciesMap.set(propertyId("A"), [
      batchPropertyDependency("X"),
    ]);
    propertyDependenciesMap.set(propertyId("B"), [
      batchPropertyDependency("X"),
    ]);

    const dependsOn = new Map<TestPropertyId, Set<TestPropertyId>>();
    dependsOn.set(propertyId("A"), propertySet("X"));
    dependsOn.set(propertyId("B"), propertySet("X"));

    const graph = {
      propertyDependenciesMap,
      dependsOn,
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("A", "B"),
    };

    const propertiesById = propertyMap([
      ["A", pA],
      ["B", pB],
    ]);

    const batches = buildLevelBatches(
      propertyIds("A", "B"),
      propertiesById,
      graph,
    );

    expect(batches.length).toBe(1);
    expect(batches[0]?.properties.map((p) => p.id)).toEqual([propertyId("B")]);
  });

  test("creates separate batches for different dependency signatures", () => {
    const pA = createProperty("A");
    const pB = createProperty("B");
    const pC = createProperty("C");

    const propertyDependenciesMap = new Map<
      TestPropertyId,
      BatchPropertyDependency[]
    >();
    propertyDependenciesMap.set(propertyId("B"), [
      batchPropertyDependency("A"),
    ]);
    propertyDependenciesMap.set(propertyId("C"), []);

    const dependsOn = new Map<TestPropertyId, Set<TestPropertyId>>();
    dependsOn.set(propertyId("B"), propertySet("A"));
    dependsOn.set(propertyId("C"), propertySet());

    const graph = {
      propertyDependenciesMap,
      dependsOn,
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: propertySet("A", "B", "C"),
    };

    const propertiesById = propertyMap([
      ["A", pA],
      ["B", pB],
      ["C", pC],
    ]);

    const batches = buildLevelBatches(
      propertyIds("B", "C"),
      propertiesById,
      graph,
    );

    expect(batches.length).toBe(2);
    const inputsList = batches.map((b) => b.inputs.join(",")).toSorted();
    expect(inputsList).toEqual(["", "A"]);
  });
});

describe("getPropertyExecutionPlan", () => {
  test("returns empty array when no properties", () => {
    const plan = getPropertyExecutionPlan({
      properties: [],
      dependencies: [],
    });

    expect(plan).toEqual([]);
  });

  test("returns empty array when properties have no dependencies", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("p1"),
      createProperty("p2"),
    ];

    const plan = getPropertyExecutionPlan({
      properties,
      dependencies: [],
    });

    expect(plan).toEqual([]);
  });

  test("first level does not contain properties without dependencies", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
      createProperty("C"),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "A"),
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan.length).toBeGreaterThan(0);
    for (const batch of plan[0] ?? []) {
      expect(batch.inputs.length).toBeGreaterThan(0);
    }
  });

  test("returns single level for simple chain A -> B", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const dependencies: PropertyDependency[] = [propertyDependency("B", "A")];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0]?.[0]?.inputs).toEqual([propertyId("A")]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id)).toEqual([
      propertyId("B"),
    ]);
  });

  test("returns two levels for chain A -> B -> C", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
      createProperty("C"),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "B"),
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(2);
    expect(plan[0]?.[0]?.inputs).toEqual([propertyId("A")]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id)).toEqual([
      propertyId("B"),
    ]);
    expect(plan[1]?.[0]?.inputs).toEqual([propertyId("B")]);
    expect(plan[1]?.[0]?.properties.map((p) => p.id)).toEqual([
      propertyId("C"),
    ]);
  });

  test("groups properties with same dependency signature in diamond structure", () => {
    // A -> B, A -> C, B -> D, C -> D
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
      createProperty("C"),
      createProperty("D"),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "A"),
      propertyDependency("D", "B"),
      propertyDependency("D", "C"),
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(2);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0]?.[0]?.inputs.toSorted()).toEqual([propertyId("A")]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id).toSorted()).toEqual([
      propertyId("B"),
      propertyId("C"),
    ]);
    expect(plan[1]).toHaveLength(1);
    expect(plan[1]?.[0]?.inputs.toSorted()).toEqual([
      propertyId("B"),
      propertyId("C"),
    ]);
    expect(plan[1]?.[0]?.properties.map((p) => p.id)).toEqual([
      propertyId("D"),
    ]);
  });

  test("returns empty plan for cycle and self-dependency (same behavior)", () => {
    const cyclePlan = getPropertyExecutionPlan({
      properties: [createProperty("A"), createProperty("B")],
      dependencies: [
        propertyDependency("B", "A"),
        propertyDependency("A", "B"),
      ],
    });

    const selfDepPlan = getPropertyExecutionPlan({
      properties: [createProperty("A")],
      dependencies: [propertyDependency("A", "A")],
    });

    expect(cyclePlan).toEqual([]);
    expect(selfDepPlan).toEqual([]);
    expect(selfDepPlan).toEqual(cyclePlan);
  });

  test("only includes stale property in plan when sibling is fresh", () => {
    // A (manual) -> B (stale), A -> C (fresh)
    const properties: ExecutionPlanProperty[] = [
      createProperty("A", { tool: manualInputTool }),
      createProperty("B", { status: "stale" }),
      createProperty("C", { status: "fresh" }),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "A"),
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0]?.[0]?.properties.map((p) => p.id)).toEqual([
      propertyId("B"),
    ]);
  });

  test("returns empty plan when all AI properties are fresh", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A", { tool: manualInputTool }),
      createProperty("B", { status: "fresh" }),
      createProperty("C", { status: "fresh" }),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "B"),
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    // Levels exist from topological sort, but all batches are empty
    for (const level of plan) {
      expect(level).toHaveLength(0);
    }
  });

  test("panics when dangling edge references property not in properties", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const dependencies: PropertyDependency[] = [
      propertyDependency("B", "A"),
      propertyDependency("C", "B"),
    ];

    expect(() =>
      getPropertyExecutionPlan({ properties, dependencies }),
    ).toThrow(Panic);
  });
});
