import type React from "react";

import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, LandmarkIcon, LayersIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import type { MentionCategory } from "@/components/chat/chat-mention-href";
import { parseStellaMentionHref } from "@/components/chat/chat-mention-href";
import { getMatterColor } from "@/lib/matter-colors";

const DECISION_HASH_PREFIX = "#stella-decision=";

const CATEGORY_ICON: Record<
  Exclude<MentionCategory, "entity">,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  workspace: LayersIcon,
};

const CHIP_CLASS_NAME = cn(
  "inline-flex max-w-56 items-center gap-0.5 align-middle",
  "bg-accent rounded px-1 py-0.5",
  "text-accent-foreground text-xs font-medium",
);

const MentionChipLabel = ({ children }: { children: React.ReactNode }) => (
  <span className="min-w-0 truncate">{children}</span>
);

const MentionChip = ({
  label,
  href,
  interactive,
}: {
  label: React.ReactNode;
  href: string;
  interactive: boolean;
}) => {
  const navigate = useNavigate();

  if (href.startsWith(DECISION_HASH_PREFIX)) {
    const decisionId = href.slice(DECISION_HASH_PREFIX.length);
    const content = (
      <>
        <LandmarkIcon className="size-3 shrink-0" />
        <MentionChipLabel>{label}</MentionChipLabel>
      </>
    );

    if (!interactive) {
      return <span className={CHIP_CLASS_NAME}>{content}</span>;
    }

    return (
      <button
        className={cn(CHIP_CLASS_NAME, "hover:bg-accent/80 cursor-pointer")}
        onClick={() =>
          void navigate({
            to: "/knowledge/case/$decisionId",
            params: { decisionId },
          })
        }
        type="button"
      >
        {content}
      </button>
    );
  }

  const parsed = parseStellaMentionHref(href);
  if (!parsed) {
    return null;
  }

  const { category, id } = parsed;
  const icon =
    category === "entity" ? (
      <FileTextIcon className="size-3 shrink-0" />
    ) : (
      (() => {
        const Icon = CATEGORY_ICON[category];
        return (
          <Icon
            className="size-3 shrink-0"
            {...(category === "workspace"
              ? { style: { color: getMatterColor(id) } }
              : {})}
          />
        );
      })()
    );

  if (!interactive || category !== "workspace") {
    return (
      <span className={CHIP_CLASS_NAME}>
        {icon}
        <MentionChipLabel>{label}</MentionChipLabel>
      </span>
    );
  }

  return (
    <button
      className={cn(CHIP_CLASS_NAME, "hover:bg-accent/80 cursor-pointer")}
      onClick={() =>
        void navigate({
          to: "/workspaces/$workspaceId",
          params: { workspaceId: id },
        })
      }
      type="button"
    >
      {icon}
      <MentionChipLabel>{label}</MentionChipLabel>
    </button>
  );
};

type StreamdownMentionLinkProps =
  React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    interactive: boolean;
  };

export const StreamdownMentionLink = ({
  href,
  children,
  interactive,
  ...props
}: StreamdownMentionLinkProps) => {
  if (!href) {
    return <span {...props}>{children}</span>;
  }

  const mentionChip =
    href.startsWith(DECISION_HASH_PREFIX) || parseStellaMentionHref(href) ? (
      <MentionChip href={href} interactive={interactive} label={children} />
    ) : null;

  if (mentionChip) {
    return mentionChip;
  }

  if (!interactive) {
    return (
      <a href={href} {...props}>
        {children}
      </a>
    );
  }

  return (
    <a href={href} rel="noopener noreferrer" target="_blank" {...props}>
      {children}
    </a>
  );
};
