import Tooltip from "@/components/tooltip";
import { UserIdentity } from "@/components/user-avatar";
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
      avatarClassName="size-5 shrink-0 text-[10px]"
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
