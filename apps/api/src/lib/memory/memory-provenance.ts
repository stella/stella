import type { SafeId } from "@/api/lib/branded-types";

type ResolveMemorySourceWorkspaceIdsOptions = {
  accessibleWorkspaceIds: ReadonlySet<string>;
  contextMatterIds: readonly SafeId<"workspace">[];
  dataWorkspaceIds: readonly SafeId<"workspace">[];
  registeredWorkspaceIds: readonly SafeId<"workspace">[];
  workspaceId: SafeId<"workspace"> | null;
};

/** Deduplicate every source visible at execution time, then fail closed to the
 * request's current accessible set before durable provenance is persisted.
 */
export const resolveMemorySourceWorkspaceIds = ({
  accessibleWorkspaceIds,
  contextMatterIds,
  dataWorkspaceIds,
  registeredWorkspaceIds,
  workspaceId,
}: ResolveMemorySourceWorkspaceIdsOptions): SafeId<"workspace">[] =>
  Array.from(
    new Set<SafeId<"workspace">>([
      ...(workspaceId === null ? [] : [workspaceId]),
      ...contextMatterIds,
      ...dataWorkspaceIds,
      ...registeredWorkspaceIds,
    ]),
  ).filter((id) => accessibleWorkspaceIds.has(id));
