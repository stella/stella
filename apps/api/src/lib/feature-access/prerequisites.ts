import { panic } from "better-result";

import type { FeatureRegistry } from "@/api/lib/feature-access/registry";

export const featurePrerequisiteClosure = (
  registry: FeatureRegistry,
  featureId: string,
): ReadonlySet<string> => {
  const completed = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) {
      panic("Feature prerequisites must be acyclic");
    }
    if (completed.has(id)) {
      return;
    }
    const definition = Object.hasOwn(registry, id) ? registry[id] : undefined;
    if (definition === undefined) {
      panic("Feature access requires a registered feature");
    }
    active.add(id);
    if (definition.prerequisites !== undefined) {
      for (const prerequisite of definition.prerequisites) {
        visit(prerequisite);
      }
    }
    active.delete(id);
    completed.add(id);
  };
  visit(featureId);
  return completed;
};

export const assertFeaturePrerequisites = (registry: FeatureRegistry): void => {
  for (const id of Object.keys(registry)) {
    featurePrerequisiteClosure(registry, id);
  }
};

export const defineFeatureRegistry = <const T extends FeatureRegistry>(
  registry: T & {
    [K in keyof T]: { prerequisites?: readonly (keyof T & string)[] };
  },
): T => {
  assertFeaturePrerequisites(registry);
  return registry;
};
