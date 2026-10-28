import { useTranslations } from "use-intl";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  definedFields,
  toFileTab,
} from "@/components/inspector/open-entities.logic";
import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
import { getEntityName } from "@/components/workspaces/entity-utils";
import { formatFullTimestamp, formatRelativeTime } from "@/lib/relative-time";
import type { WorkspaceEntity } from "@/lib/types";

export const AuthorCell = ({ entity }: { entity: WorkspaceEntity }) => {
  if (entity.kind === "folder") {
    return null;
  }

  const name = entity.createdBy;
  if (!name) {
    return null;
  }

  return (
    <UserIdentity
      avatarClassName="size-5 shrink-0 text-3xs"
      className="justify-end gap-1.5"
      image={entity.createdByImage}
      name={name}
      nameClassName="text-muted-foreground text-end text-xs font-normal"
    />
  );
};

export const LastUpdatedCell = ({ entity }: { entity: WorkspaceEntity }) => {
  if (entity.kind === "folder") {
    return null;
  }

  const ts = entity.updatedAt ?? entity.createdAt;
  const full = formatFullTimestamp(ts);

  return (
    <Tooltip
      content={full}
      render={<span className="text-muted-foreground text-xs" />}
    >
      {formatRelativeTime(ts)}
    </Tooltip>
  );
};

export const VersionCell = ({ entity }: { entity: WorkspaceEntity }) => {
  if (entity.kind === "folder") {
    return null;
  }

  return (
    <span className="text-muted-foreground truncate text-xs">
      {entity.version}
    </span>
  );
};

type VersionHistoryCellProps = {
  entity: WorkspaceEntity;
  workspaceId: string;
};

/**
 * The table's version cell: opens the row's file in the inspector on its
 * version history. The tree view keeps the inert `VersionCell` because its
 * cells sit inside the row's own button, where a nested control is invalid.
 */
export const VersionHistoryCell = ({
  entity,
  workspaceId,
}: VersionHistoryCellProps) => {
  const t = useTranslations();
  const fileTab = toFileTab({
    entityId: entity.entityId,
    fields: definedFields(entity),
    label: getEntityName(entity),
    workspaceId,
  });

  if (fileTab === null) {
    return <VersionCell entity={entity} />;
  }

  const label = t("fileDetail.showVersionList");
  return (
    <Tooltip
      content={label}
      render={
        <button
          aria-label={label}
          // The pseudo-element stretches the hit area over the whole cell.
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer truncate rounded-sm text-xs underline-offset-2 outline-none after:absolute after:inset-0 hover:underline focus-visible:ring-2"
          onClick={() =>
            useInspectorTabsStore
              .getState()
              .openFile({ ...fileTab, facet: "versions" })
          }
          type="button"
        />
      }
    >
      {entity.version}
    </Tooltip>
  );
};
