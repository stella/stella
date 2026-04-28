import { useNavigate } from "@tanstack/react-router";
import { LayersIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import type { MentionCategory } from "@/components/chat/chat-mention-href";
import {
  CHAT_MENTION_CATEGORY_PATTERN,
  isMentionCategory,
} from "@/components/chat/chat-mention-href";
import { EntityMentionIcon } from "@/components/chat/entity-link";
import { openEntityInInspector } from "@/components/chat/entity-open";

/** Matches all stella mention link formats:
 *  `[Label](#stella-entity=ID)`,
 *  `[Label](#stella-workspace=ID)`, etc. */
const MENTION_RE = new RegExp(
  String.raw`\[([^\]]+)\]\(#stella-(${CHAT_MENTION_CATEGORY_PATTERN})=([^)]+)\)`,
  "g",
);

/** Strip optional `WS_ID:` prefix from cross-workspace entity IDs. */
const stripWsPrefix = (id: string) => {
  const idx = id.indexOf(":");
  return idx !== -1 ? id.slice(idx + 1) : id;
};

const MentionChip = ({
  label,
  category,
  id,
}: {
  label: string;
  category: MentionCategory;
  id: string;
}) => {
  const navigate = useNavigate();
  const entityId = category === "entity" ? stripWsPrefix(id) : id;

  const handleClick = () => {
    if (category === "entity") {
      void openEntityInInspector(entityId, label);
      return;
    }
    if (category === "workspace") {
      void navigate({
        to: "/workspaces/$workspaceId",
        params: { workspaceId: id },
      });
      return;
    }
  };

  let icon: React.ReactNode = null;
  if (category === "entity") {
    icon = <EntityMentionIcon entityId={entityId} />;
  } else if (category === "workspace") {
    icon = <LayersIcon className="inline size-3 shrink-0" />;
  }

  return (
    <button
      className={cn(
        "inline-flex items-center gap-0.5",
        "bg-accent rounded px-1 py-0.5",
        "text-accent-foreground text-xs font-medium",
        "hover:bg-accent/80 cursor-pointer",
      )}
      onClick={handleClick}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
};

/** Parse user text containing `[Name](#stella-{type}=ID)` links
 *  and render mentions as inline chips, plain text as spans. */
export const UserMessageText = ({ text }: { text: string }) => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MENTION_RE)) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const [, label, category, id] = match;
    if (!label || !category || !id || !isMentionCategory(category)) {
      continue;
    }
    parts.push(
      <MentionChip
        category={category}
        id={id}
        key={match.index}
        label={label}
      />,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span>{parts}</span>;
};
