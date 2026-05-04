import type { EntityKind } from "@/api/db/schema-validators";
import type { SafeId } from "@/api/lib/branded-types";

type WorkflowTargetEntityRow = {
  id: SafeId<"entity">;
  kind: EntityKind;
};

type ResolveWorkflowTargetEntityIdsArgs = {
  entityRows: readonly WorkflowTargetEntityRow[];
  inputEntityIds?: readonly SafeId<"entity">[] | undefined;
  inputOrder?: readonly SafeId<"entity">[] | undefined;
};

const isExplicitWorkflowTarget = ({ kind }: WorkflowTargetEntityRow) =>
  kind !== "folder";

export const resolveWorkflowTargetEntityIds = ({
  entityRows,
  inputEntityIds,
  inputOrder,
}: ResolveWorkflowTargetEntityIdsArgs) => {
  const entityIdsByKind = {
    documents: new Set(
      entityRows
        .filter((entity) => entity.kind === "document")
        .map((entity) => entity.id),
    ),
    explicitTargets: new Set(
      entityRows.filter(isExplicitWorkflowTarget).map((entity) => entity.id),
    ),
  };

  const targetIds =
    inputEntityIds && inputEntityIds.length > 0
      ? inputEntityIds.filter((id) => entityIdsByKind.explicitTargets.has(id))
      : [...entityIdsByKind.documents];

  const targetSet = new Set(targetIds);
  const prioritized = (inputOrder ?? []).filter((id) => targetSet.has(id));
  const prioritizedSet = new Set(prioritized);
  const remaining = targetIds.filter((id) => !prioritizedSet.has(id));
  return [...prioritized, ...remaining];
};
