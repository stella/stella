import { useNavigate } from "@tanstack/react-router";
import {
  ContactIcon,
  FileTextIcon,
  LayersIcon,
  ScrollTextIcon,
} from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import type { MentionCategory } from "@/components/chat-mention-extension";
import { MENTION_HASH_PREFIX } from "@/components/chat-mention-extension";
import {
  EntityMentionIcon,
  openEntityInInspector,
} from "@/components/chat/entity-link";

const isMentionCategory = (value: string): value is MentionCategory =>
  value in MENTION_HASH_PREFIX;

/** Matches all stella mention link formats:
 *  `[Label](#stella-entity=ID)`,
 *  `[Label](#stella-workspace=ID)`, etc. */
const MENTION_RE =
  /\[([^\]]+)\]\(#stella-(entity|workspace|contact|template|clause)=([^)]+)\)/g;

const CATEGORY_ICON: Record<
  Exclude<MentionCategory, "entity">,
  React.ComponentType<{ className?: string }>
> = {
  workspace: LayersIcon,
  contact: ContactIcon,
  template: FileTextIcon,
  clause: ScrollTextIcon,
};

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
      openEntityInInspector(entityId, label);
      return;
    }
    if (category === "workspace") {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: id } });
      return;
    }
    // Phase 2: contact, template, clause navigation
  };

  const icon =
    category === "entity" ? (
      <EntityMentionIcon entityId={entityId} />
    ) : (
      (() => {
        const Icon = CATEGORY_ICON[category];
        return <Icon className="inline size-3 shrink-0" />;
      })()
    );

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
