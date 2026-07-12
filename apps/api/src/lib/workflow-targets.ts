import type { EntityKind } from "@/api/db/schema-validators";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";

export type WorkflowTargetEntityRow = {
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

const dedupeEntityIds = (ids: readonly SafeId<"entity">[]) => {
  const seen = new Set<SafeId<"entity">>();
  const uniqueIds: SafeId<"entity">[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    uniqueIds.push(id);
  }
  return uniqueIds;
};

export const resolveWorkflowTargetEntityIds = ({
  entityRows,
  inputEntityIds,
  inputOrder,
}: ResolveWorkflowTargetEntityIdsArgs) => {
  const documents = new Set<SafeId<"entity">>();
  const explicitTargets = new Set<SafeId<"entity">>();
  for (const entity of entityRows) {
    if (entity.kind === "document") {
      documents.add(entity.id);
    }
    if (isExplicitWorkflowTarget(entity)) {
      explicitTargets.add(entity.id);
    }
  }
  const entityIdsByKind = { documents, explicitTargets };

  const targetIds =
    inputEntityIds && inputEntityIds.length > 0
      ? dedupeEntityIds(
          inputEntityIds.filter((id) =>
            entityIdsByKind.explicitTargets.has(id),
          ),
        )
      : [...entityIdsByKind.documents];

  const targetSet = new Set(targetIds);
  const prioritized = dedupeEntityIds(arrayOrEmpty(inputOrder)).filter((id) =>
    targetSet.has(id),
  );
  const prioritizedSet = new Set(prioritized);
  const remaining = targetIds.filter((id) => !prioritizedSet.has(id));
  return [...prioritized, ...remaining];
};
