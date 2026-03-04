import { cn } from "@stella/ui/lib/utils";

import {
  EntityMentionIcon,
  openEntityInPeek,
} from "@/components/chat/entity-link";

const MENTION_RE = /\[([^\]]+)\]\(#stella-entity=([^)]+)\)/g;

/** Parse user text containing `[Name](#stella-entity=ID)` links
 *  and render mentions as inline chips, plain text as spans. */
export const UserMessageText = ({ text }: { text: string }) => {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(MENTION_RE)) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const [, label, entityId] = match;
    parts.push(
      <button
        className={cn(
          "inline-flex items-center gap-0.5",
          "rounded bg-accent px-1 py-0.5",
          "text-xs font-medium text-accent-foreground",
          "cursor-pointer hover:bg-accent/80",
        )}
        key={match.index}
        onClick={() => openEntityInPeek(entityId, label)}
        type="button"
      >
        <EntityMentionIcon entityId={entityId} />
        {label}
      </button>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span>{parts}</span>;
};
