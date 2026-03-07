import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import {
  ContactIcon,
  FileTextIcon,
  FolderIcon,
  LayersIcon,
  ScrollTextIcon,
} from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import type { MentionCategory } from "@/components/chat-mention-extension";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { getFirstFile } from "@/routes/_protected.workspaces/$workspaceId/-utils";

const cls = "size-3 shrink-0";

const CategoryIcon = ({
  category,
  entityId,
  attrKind,
  attrMimeType,
}: {
  category: MentionCategory;
  entityId: string;
  /** Kind stored in the TipTap node (fallback). */
  attrKind: string;
  /** MIME type stored in the TipTap node (fallback). */
  attrMimeType: string | null;
}) => {
  // For entities, resolve the icon from the workspace store.
  // Falls back to node attributes for cross-workspace entities
  // that aren't in the current store.
  const entity = useWorkspaceStore((s) =>
    category === "entity" ? s.data.find((e) => e.entityId === entityId) : null,
  );

  if (category === "workspace") {
    return <LayersIcon className={cls} />;
  }
  if (category === "contact") {
    return <ContactIcon className={cls} />;
  }
  if (category === "template") {
    return <FileTextIcon className={cls} />;
  }
  if (category === "clause") {
    return <ScrollTextIcon className={cls} />;
  }

  // Entity category: prefer store data, fall back to attrs
  const file = entity ? getFirstFile(entity) : null;
  const kind = entity?.kind ?? attrKind;
  const mimeType = file?.mimeType ?? attrMimeType;

  if (kind === "folder") {
    return <FolderIcon className={cls} />;
  }
  if (mimeType) {
    return <DocumentIcon className={cls} mimeType={mimeType} />;
  }
  return <FileTextIcon className={cls} />;
};

export const ChatMentionNode = (props: NodeViewProps) => {
  const attrs = props.node.attrs as {
    id: string;
    label: string;
    category: MentionCategory;
    kind: string;
    mimeType: string | null;
  };

  return (
    <NodeViewWrapper className="inline">
      <span
        className={cn(
          "inline-flex items-center gap-0.5",
          "rounded bg-accent px-1 py-0.5",
          "text-xs font-medium text-accent-foreground",
        )}
      >
        <CategoryIcon
          attrKind={attrs.kind ?? "document"}
          attrMimeType={attrs.mimeType}
          category={attrs.category ?? "entity"}
          entityId={attrs.id}
        />
        {attrs.label}
      </span>
    </NodeViewWrapper>
  );
};
