import { panic } from "better-result";

import type { RouteEntry } from "@/api/http/route";
import type { AggregateName } from "@/api/lib/db/aggregate-lock";

export type AggregateMutationDeclaration =
  | {
      type: "aggregate";
      aggregates: readonly [AggregateName, ...AggregateName[]];
    }
  | { type: "independent"; reason: string };

export const assertValidAggregateMutationDeclaration = (
  declaration: AggregateMutationDeclaration | undefined,
): void => {
  if (declaration?.type === "independent" && declaration.reason.trim() === "") {
    panic("An independent mutation requires a reason");
  }
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
        entry.definition.config.aggregateMutation === undefined,
    )
    .map((entry) => `${entry.method} ${entry.path}`);
