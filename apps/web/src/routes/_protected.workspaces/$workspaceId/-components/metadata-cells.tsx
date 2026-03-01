import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stella/ui/components/avatar";

import Tooltip from "@/components/tooltip";
import type { WorkspaceEntity } from "@/lib/types";
import {
  formatFullTimestamp,
  formatRelativeTime,
} from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const AuthorCell = ({ entity }: { entity: WorkspaceEntity }) => {
  if (entity.kind === "folder") {
    return null;
  }

  const name = entity.createdBy;
  if (!name) {
    return null;
  }

  const initials = name
    .split(" ")
    .map((n) => n.at(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Avatar className="size-5 text-[10px]">
        {entity.createdByImage && (
          <AvatarImage alt={name} src={entity.createdByImage} />
        )}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
    </div>
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
      render={<span className="text-xs text-muted-foreground" />}
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
    <span className="truncate text-xs text-muted-foreground">
      {entity.version}
    </span>
  );
};
