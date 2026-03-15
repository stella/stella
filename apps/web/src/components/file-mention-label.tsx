import { cn } from "@stella/ui/lib/utils";

import type { FileMention } from "@/lib/types";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

type FileMentionLabelProps = {
  mention: FileMention;
  className?: string;
  iconClassName?: string;
};

export const FileMentionLabel = ({
  mention,
  className,
  iconClassName = "size-4 shrink-0",
}: FileMentionLabelProps) => (
  <span className={cn("inline-flex items-center gap-1", className)}>
    {!mention.hideIcon && (
      <DocumentIcon className={iconClassName} mimeType={mention.mimeType} />
    )}
    {mention.name}
  </span>
);
