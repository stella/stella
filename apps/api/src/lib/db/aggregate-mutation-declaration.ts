import { panic } from "better-result";

import type { RouteEntry } from "@/api/http/route";
import type { AggregateName } from "@/api/lib/db/aggregate-lock";

export type AggregateMutationDeclaration =
  | {
      type: "aggregate";
      aggregates: readonly [AggregateName, ...AggregateName[]];
    }
  | { type: "independent"; reason: string };

const declarations = new WeakMap<object, AggregateMutationDeclaration>();

/** Records which aggregates a route's mutation owns, keyed by its definition. */
export const declareAggregateMutation = <T extends object>(
  definition: T,
  declaration: AggregateMutationDeclaration,
): T => {
  if (declaration.type === "independent" && declaration.reason.trim() === "") {
    panic("An independent mutation requires a reason");
  }
  if (declarations.has(definition)) {
    panic("Aggregate mutation ownership is already declared");
  }
  declarations.set(definition, declaration);
  return definition;
};

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Run against the composed route table; every mutation must declare its ownership. */
export const collectUndeclaredAggregateMutations = (
  entries: readonly Pick<RouteEntry, "method" | "path" | "definition">[],
): string[] =>
  entries
    .filter(
      (entry) =>
        MUTATION_METHODS.has(entry.method) &&
        !declarations.has(entry.definition),
    )
    .map((entry) => `${entry.method} ${entry.path}`);
