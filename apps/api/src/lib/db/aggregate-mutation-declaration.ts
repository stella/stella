import { panic } from "better-result";

import type { AggregateName } from "@/api/lib/db/aggregate-lock";

export type AggregateMutationDeclaration =
  | {
      type: "aggregate";
      aggregates: readonly [AggregateName, ...AggregateName[]];
    }
  | { type: "independent"; reason: string };

const declarations = new WeakMap<object, AggregateMutationDeclaration>();

/** Records ownership without changing the handler identity used by Elysia. */
export const declareAggregateMutation = <
  T extends (...args: never[]) => unknown,
>(
  handler: T,
  declaration: AggregateMutationDeclaration,
): T => {
  if (declaration.type === "independent" && declaration.reason.trim() === "") {
    panic("An independent mutation requires a reason");
  }
  if (declarations.has(handler)) {
    panic("Aggregate mutation ownership is already declared");
  }
  declarations.set(handler, declaration);
  return handler;
};

export const getAggregateMutationDeclaration = (handler: object) =>
  declarations.get(handler);

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE", "ALL"]);

export type AggregateMutationRoute = {
  method: string;
  path: string;
  handler: unknown;
};

/** Run against the composed route table; transports need their own declaration. */
export const collectUndeclaredAggregateMutations = (
  routes: readonly AggregateMutationRoute[],
): string[] => {
  const missing: string[] = [];
  for (const route of routes) {
    if (!MUTATION_METHODS.has(route.method.toUpperCase())) {
      continue;
    }
    if (
      typeof route.handler === "function" &&
      declarations.has(route.handler)
    ) {
      continue;
    }
    missing.push(`${route.method.toUpperCase()} ${route.path}`);
  }
  return missing;
};
