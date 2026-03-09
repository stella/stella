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
import { getMatterColor } from "@/lib/matter-colors";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const cls = "size-3 shrink-0";

const CategoryIcon = ({
  category,
  attrId,
  attrKind,
  attrMimeType,
}: {
  category: MentionCategory;
  /** Entity/workspace ID stored in the TipTap node. */
  attrId: string;
  /** Kind stored in the TipTap node (fallback). */
  attrKind: string;
  /** MIME type stored in the TipTap node (fallback). */
  attrMimeType: string | null;
}) => {
  if (category === "workspace") {
    return (
      <LayersIcon className={cls} style={{ color: getMatterColor(attrId) }} />
    );
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

  if (attrKind === "folder") {
    return <FolderIcon className={cls} />;
  }
  if (attrMimeType) {
    return <DocumentIcon className={cls} mimeType={attrMimeType} />;
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
          attrId={attrs.id ?? ""}
          attrKind={attrs.kind ?? "document"}
          attrMimeType={attrs.mimeType}
          category={attrs.category ?? "entity"}
        />
        {attrs.label}
      </span>
    </NodeViewWrapper>
  );
};
