import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  buildDependencyGraph,
  buildLevelBatches,
  getPropertyExecutionPlan,
} from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import type {
  BatchPropertyDependency,
  ExecutionPlanProperty,
  PropertyDependency,
} from "@/api/handlers/registry/actors/workflow/get-execution-plan";

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
  id,
  status: "fresh",
  content: textContent,
  tool: aiModelTool,
  ...overrides,
});

describe("buildDependencyGraph", () => {
  test("builds graph with no edges", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("p1"),
      createProperty("p2"),
    ];
    const edges: PropertyDependency[] = [];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.propertyIds).toEqual(new Set(["p1", "p2"]));
    expect(graph.inDegree.get("p1")).toBe(0);
    expect(graph.inDegree.get("p2")).toBe(0);
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
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "A", condition: null },
      { propertyId: "D", dependsOnPropertyId: "B", condition: null },
      { propertyId: "D", dependsOnPropertyId: "C", condition: null },
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get("A")).toBe(0);
    expect(graph.inDegree.get("B")).toBe(1);
    expect(graph.inDegree.get("C")).toBe(1);
    expect(graph.inDegree.get("D")).toBe(2);

    expect([...(graph.dependents.get("A") ?? [])].toSorted()).toEqual([
      "B",
      "C",
    ]);
    expect(graph.dependents.get("B")).toEqual(["D"]);
    expect(graph.dependents.get("C")).toEqual(["D"]);
  });

  test("builds graph with self-dependency A -> A", () => {
    const properties: ExecutionPlanProperty[] = [createProperty("A")];
    const edges: PropertyDependency[] = [
      { propertyId: "A", dependsOnPropertyId: "A", condition: null },
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get("A")).toBe(1);
    expect(graph.dependents.get("A")).toEqual(["A"]);
    expect(graph.dependsOn.get("A")).toEqual(new Set(["A"]));
  });

  test("builds graph with duplicate edges (B depends on A twice)", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const edges: PropertyDependency[] = [
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.inDegree.get("A")).toBe(0);
    expect(graph.inDegree.get("B")).toBe(2);
    expect(graph.dependents.get("A")).toEqual(["B", "B"]);
  });

  test("builds graph with dangling edge (dependency references property not in properties)", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const edges: PropertyDependency[] = [
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "B", condition: null },
    ];

    const graph = buildDependencyGraph({ properties, dependencies: edges });

    expect(graph.propertyIds).toEqual(new Set(["A", "B"]));
    expect(graph.inDegree.get("C")).toBe(1);
    expect(graph.dependents.get("B")).toEqual(["C"]);
  });
});

describe("buildLevelBatches", () => {
  test("groups properties with identical dependency signature into same batch", () => {
    const pA = createProperty("A");
    const pB = createProperty("B");
    const pC = createProperty("C");

    const propertyDependenciesMap = new Map<
      string,
      BatchPropertyDependency[]
    >();
    propertyDependenciesMap.set("B", [
      { dependsOnPropertyId: "A", condition: null },
    ]);
    propertyDependenciesMap.set("C", [
      { dependsOnPropertyId: "A", condition: null },
    ]);

    const dependsOn = new Map<string, Set<string>>();
    dependsOn.set("B", new Set(["A"]));
    dependsOn.set("C", new Set(["A"]));

    const graph = {
      propertyDependenciesMap,
      dependsOn,
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: new Set(["A", "B", "C"]),
    };

    const propertiesById = new Map([
      ["A", pA],
      ["B", pB],
      ["C", pC],
    ]);

    const batches = buildLevelBatches(["B", "C"], propertiesById, graph);

    expect(batches.length).toBe(1);
    expect(batches[0]?.inputs).toEqual(["A"]);
    expect(batches[0]?.properties.map((p) => p.id).toSorted()).toEqual([
      "B",
      "C",
    ]);
  });

  test("excludes file-type properties from batches", () => {
    const pFile = createProperty("p1", { content: fileContent });
    const propertiesById = new Map([["p1", pFile]]);
    const graph = {
      propertyDependenciesMap: new Map(),
      dependsOn: new Map<string, Set<string>>([["p1", new Set<string>()]]),
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: new Set(["p1"]),
    };

    const batches = buildLevelBatches(["p1"], propertiesById, graph);

    expect(batches.length).toBe(0);
  });

  test("excludes manual-input tool properties from batches", () => {
    const pManual = createProperty("p1", { tool: manualInputTool });
    const propertiesById = new Map([["p1", pManual]]);
    const graph = {
      propertyDependenciesMap: new Map(),
      dependsOn: new Map<string, Set<string>>([["p1", new Set<string>()]]),
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: new Set(["p1"]),
    };

    const batches = buildLevelBatches(["p1"], propertiesById, graph);

    expect(batches.length).toBe(0);
  });

  test("creates separate batches for different dependency signatures", () => {
    const pA = createProperty("A");
    const pB = createProperty("B");
    const pC = createProperty("C");

    const propertyDependenciesMap = new Map<
      string,
      BatchPropertyDependency[]
    >();
    propertyDependenciesMap.set("B", [
      { dependsOnPropertyId: "A", condition: null },
    ]);
    propertyDependenciesMap.set("C", []);

    const dependsOn = new Map<string, Set<string>>();
    dependsOn.set("B", new Set(["A"]));
    dependsOn.set("C", new Set<string>());

    const graph = {
      propertyDependenciesMap,
      dependsOn,
      inDegree: new Map(),
      dependents: new Map(),
      propertyIds: new Set(["A", "B", "C"]),
    };

    const propertiesById = new Map([
      ["A", pA],
      ["B", pB],
      ["C", pC],
    ]);

    const batches = buildLevelBatches(["B", "C"], propertiesById, graph);

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
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "A", condition: null },
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
    const dependencies: PropertyDependency[] = [
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(1);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0]?.[0]?.inputs).toEqual(["A"]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id)).toEqual(["B"]);
  });

  test("returns two levels for chain A -> B -> C", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
      createProperty("C"),
    ];
    const dependencies: PropertyDependency[] = [
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "B", condition: null },
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(2);
    expect(plan[0]?.[0]?.inputs).toEqual(["A"]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id)).toEqual(["B"]);
    expect(plan[1]?.[0]?.inputs).toEqual(["B"]);
    expect(plan[1]?.[0]?.properties.map((p) => p.id)).toEqual(["C"]);
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
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "A", condition: null },
      { propertyId: "D", dependsOnPropertyId: "B", condition: null },
      { propertyId: "D", dependsOnPropertyId: "C", condition: null },
    ];

    const plan = getPropertyExecutionPlan({ properties, dependencies });

    expect(plan).toHaveLength(2);
    expect(plan[0]).toHaveLength(1);
    expect(plan[0]?.[0]?.inputs.toSorted()).toEqual(["A"]);
    expect(plan[0]?.[0]?.properties.map((p) => p.id).toSorted()).toEqual([
      "B",
      "C",
    ]);
    expect(plan[1]).toHaveLength(1);
    expect(plan[1]?.[0]?.inputs.toSorted()).toEqual(["B", "C"]);
    expect(plan[1]?.[0]?.properties.map((p) => p.id)).toEqual(["D"]);
  });

  test("returns empty plan for cycle and self-dependency (same behavior)", () => {
    const cyclePlan = getPropertyExecutionPlan({
      properties: [createProperty("A"), createProperty("B")],
      dependencies: [
        { propertyId: "B", dependsOnPropertyId: "A", condition: null },
        { propertyId: "A", dependsOnPropertyId: "B", condition: null },
      ],
    });

    const selfDepPlan = getPropertyExecutionPlan({
      properties: [createProperty("A")],
      dependencies: [
        { propertyId: "A", dependsOnPropertyId: "A", condition: null },
      ],
    });

    expect(cyclePlan).toEqual([]);
    expect(selfDepPlan).toEqual([]);
    expect(selfDepPlan).toEqual(cyclePlan);
  });

  test("panics when dangling edge references property not in properties", () => {
    const properties: ExecutionPlanProperty[] = [
      createProperty("A"),
      createProperty("B"),
    ];
    const dependencies: PropertyDependency[] = [
      { propertyId: "B", dependsOnPropertyId: "A", condition: null },
      { propertyId: "C", dependsOnPropertyId: "B", condition: null },
    ];

    expect(() =>
      getPropertyExecutionPlan({ properties, dependencies }),
    ).toThrow(Panic);
  });
});
