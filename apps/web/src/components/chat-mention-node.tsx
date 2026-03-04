import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileTextIcon, FolderIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

export const ChatMentionNode = (props: NodeViewProps) => {
  const attrs = props.node.attrs as {
    id: string;
    label: string;
  };

  const entity = useWorkspaceStore((s) =>
    s.data.find((e) => e.entityId === attrs.id),
  );

  const file = entity ? getFirstFile(entity) : null;
  const kind = entity?.kind ?? "document";

  const icon =
    kind === "folder" ? (
      <FolderIcon className="size-3 shrink-0" />
    ) : file?.mimeType ? (
      <DocumentIcon className="size-3 shrink-0" mimeType={file.mimeType} />
    ) : (
      <FileTextIcon className="size-3 shrink-0" />
    );

  return (
    <NodeViewWrapper className="inline">
      <span
        className={cn(
          "inline-flex items-center gap-0.5",
          "rounded bg-accent px-1 py-0.5",
          "text-xs font-medium text-accent-foreground",
        )}
      >
        {icon}
        {attrs.label}
      </span>
    </NodeViewWrapper>
  );
};
