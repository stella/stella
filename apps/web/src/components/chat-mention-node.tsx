import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { LandmarkIcon } from "lucide-react";

import { isEntityKind } from "@stll/api-contract";
import type { EntityKind } from "@stll/api-contract";
import { cn } from "@stll/ui/utils";

import type { ChatReferenceCategory } from "@/components/chat-mention-extension";
import { isMentionCategory } from "@/components/chat/chat-mention-href";
import { MatterIcon } from "@/components/matter-icon";
import { EntityIcon } from "@/components/workspaces/entity-kind-icon";
import { getMatterColor } from "@/lib/matter-colors";

export const ChatMentionNode = (props: NodeViewProps) => {
  const attrs = readChatMentionAttrs(props.node.attrs);
  const sourceWorkspaceId = attrs.sourceWorkspaceId;
  const sourceWorkspaceColor = sourceWorkspaceId
    ? getMatterColor(sourceWorkspaceId)
    : null;

  return (
    <NodeViewWrapper className="inline">
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-0.5 align-middle",
          "bg-accent rounded px-1 py-0.5",
          "text-accent-foreground text-xs font-medium",
          sourceWorkspaceColor !== null && "border",
        )}
        style={
          sourceWorkspaceColor
            ? {
                backgroundColor: `color-mix(in srgb, ${sourceWorkspaceColor} 18%, transparent)`,
                borderColor: `color-mix(in srgb, ${sourceWorkspaceColor} 55%, transparent)`,
              }
            : undefined
        }
      >
        <CategoryIcon
          attrId={attrs.id}
          attrKind={attrs.kind}
          attrMimeType={attrs.mimeType}
          category={attrs.category}
        />
        <span className={cn("truncate", CHAT_MENTION_LABEL_MAX_WIDTH_CLASS)}>
          {attrs.label}
        </span>
      </span>
    </NodeViewWrapper>
  );
};

const cls = "size-3 shrink-0";
const CHAT_MENTION_LABEL_MAX_WIDTH_CLASS = "max-w-48";

type ChatMentionAttrs = {
  id: string;
  label: string;
  category: ChatReferenceCategory;
  kind: EntityKind | null;
  mimeType: string | null;
  sourceWorkspaceId: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isChatReferenceCategory = (
  value: unknown,
): value is ChatReferenceCategory =>
  typeof value === "string" &&
  (value === "decision" || isMentionCategory(value));

const readChatMentionAttrs = (value: unknown): ChatMentionAttrs => {
  if (!isRecord(value)) {
    return {
      id: "",
      label: "",
      category: "entity",
      kind: null,
      mimeType: null,
      sourceWorkspaceId: null,
    };
  }

  const id = value["id"];
  const label = value["label"];
  const category = value["category"];
  const kind = value["kind"];
  const mimeType = value["mimeType"];
  const sourceWorkspaceId = value["sourceWorkspaceId"];

  return {
    id: typeof id === "string" ? id : "",
    label: typeof label === "string" ? label : "",
    category: isChatReferenceCategory(category) ? category : "entity",
    kind: isEntityKind(kind) ? kind : null,
    mimeType: typeof mimeType === "string" ? mimeType : null,
    sourceWorkspaceId:
      typeof sourceWorkspaceId === "string" ? sourceWorkspaceId : null,
  };
};

const CategoryIcon = ({
  category,
  attrId,
  attrKind,
  attrMimeType,
}: {
  category: ChatReferenceCategory;
  /** Entity/workspace ID stored in the TipTap node. */
  attrId: string;
  /** Kind stored in the TipTap node; null when the stored attribute is
   *  not a kind (a workspace mention, or content written before the
   *  attribute existed). */
  attrKind: EntityKind | null;
  /** MIME type stored in the TipTap node (fallback). */
  attrMimeType: string | null;
}) => {
  if (category === "workspace") {
    return <MatterIcon className={cls} matter={{ id: attrId, color: null }} />;
  }

  if (category === "decision") {
    return <LandmarkIcon className={cls} />;
  }

  return (
    <EntityIcon
      className={cls}
      source={
        attrKind === null
          ? { type: "unknown" }
          : { type: "resolved", kind: attrKind, mimeType: attrMimeType }
      }
    />
  );
};
