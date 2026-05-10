import { FileIcon, FolderIcon, LinkIcon, MailIcon } from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

import type { EntityKind } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import {
  STATUS_COLORS,
  STATUS_ICONS,
  isTaskStatus,
} from "@/routes/_protected.workspaces/$workspaceId/-components/tasks/task-detail-constants";

type EntityKindIconProps = {
  kind: EntityKind;
  className?: string | undefined;
  mimeType?: string | null | undefined;
  status?: string | null | undefined;
};

export const EntityKindIcon = ({
  kind,
  className,
  mimeType,
  status,
}: EntityKindIconProps) => {
  if (kind === "task") {
    const statusKey = status ?? null;
    const resolved = isTaskStatus(statusKey) ? statusKey : "open";
    const Icon = STATUS_ICONS[resolved];
    const color = STATUS_COLORS[resolved];
    return <Icon className={cn(color, className)} />;
  }

  if (kind === "folder") {
    return <FolderIcon className={className} />;
  }

  if (kind === "message") {
    return <MailIcon className={className} />;
  }

  if (kind === "link") {
    return <LinkIcon className={className} />;
  }

  // document / file
  if (mimeType) {
    return <DocumentIcon className={className} mimeType={mimeType} />;
  }

  return <FileIcon className={className} />;
};
