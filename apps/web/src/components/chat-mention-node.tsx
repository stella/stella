import { cn } from "@stll/ui/lib/utils";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import {
  FileTextIcon,
  FolderIcon,
  LandmarkIcon,
  LayersIcon,
} from "lucide-react";

import type { ChatReferenceCategory } from "@/components/chat-mention-extension";
import { getMatterColor } from "@/lib/matter-colors";
import { DocumentIcon } from "@/routes/_protected.workspaces/$workspaceId/-components/document-icon";

const cls = "size-3 shrink-0";
const CHAT_MENTION_LABEL_MAX_WIDTH_CLASS = "max-w-48";

const CategoryIcon = ({
  category,
  attrId,
  attrKind,
  attrMimeType,
}: {
  category: ChatReferenceCategory;
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

  if (category === "decision") {
    return <LandmarkIcon className={cls} />;
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
  // SAFETY: attrs from our own mention extension schema
  // eslint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion
  const attrs = props.node.attrs as {
    id: string;
    label: string;
    category: ChatReferenceCategory;
    kind: string;
    mimeType: string | null;
  };

  return (
    <NodeViewWrapper className="inline">
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-0.5",
          "bg-accent rounded px-1 py-0.5",
          "text-accent-foreground text-xs font-medium",
        )}
      >
        <CategoryIcon
          attrId={attrs.id ?? ""}
          attrKind={attrs.kind ?? "document"}
          attrMimeType={attrs.mimeType}
          category={attrs.category ?? "entity"}
        />
        <span className={cn("truncate", CHAT_MENTION_LABEL_MAX_WIDTH_CLASS)}>
          {attrs.label}
        </span>
      </span>
    </NodeViewWrapper>
  );
};
