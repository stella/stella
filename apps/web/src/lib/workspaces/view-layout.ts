import type { ViewLayout } from "@/lib/types";

/**
 * Apply a partial change to a view layout.
 *
 * The generic preserves the union discriminant: a bare
 * `{ ...layout, ...changes }` widens to an object that belongs to no arm of the
 * layout union, so every call site that spelled it out inline needed the same
 * helper, and two of them had written it.
 */
export const mergeLayout = <L extends ViewLayout>(
  layout: L,
  changes: Partial<L>,
): L => ({ ...layout, ...changes });
