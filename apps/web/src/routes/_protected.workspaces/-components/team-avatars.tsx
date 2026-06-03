import { useTranslations } from "use-intl";

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@stll/ui/components/avatar";
import { cn } from "@stll/ui/lib/utils";

import type { Workspace } from "@/routes/_protected.workspaces/-types";

export const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return (parts[0] ?? "").slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts.at(-1)?.[0] ?? "";
  return `${first}${last}`.toUpperCase();
};

type TeamAvatarsProps = {
  members: Workspace["members"];
  leadUserId: string | null;
  /** Size in tailwind units, e.g. "size-6". */
  size?: string;
  /** Inner text size class, e.g. "text-[0.625rem]". */
  textSize?: string;
  maxVisible?: number;
  emptyFallback?: React.ReactNode;
};

export const TeamAvatars = ({
  members,
  leadUserId,
  size = "size-6",
  textSize = "text-[0.625rem]",
  maxVisible = 3,
  emptyFallback,
}: TeamAvatarsProps) => {
  const t = useTranslations();
  if (members.length === 0) {
    return (
      <>{emptyFallback ?? <span className="text-muted-foreground">—</span>}</>
    );
  }
  const visible = members.slice(0, maxVisible);
  const overflow = members.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((m) => {
        const isLead = leadUserId === m.userId;
        return (
          <Avatar
            className={cn(
              "ring-background ring-2",
              size,
              textSize,
              isLead && "ring-primary",
            )}
            key={m.userId}
            title={
              isLead ? `${m.userName} · ${t("workspaces.lead")}` : m.userName
            }
          >
            {m.userImage ? (
              <AvatarImage alt={m.userName} src={m.userImage} />
            ) : null}
            <AvatarFallback>{getInitials(m.userName)}</AvatarFallback>
          </Avatar>
        );
      })}
      {overflow > 0 && (
        <span
          className={cn(
            "bg-muted text-muted-foreground ring-background relative z-10",
            "flex items-center justify-center rounded-full font-medium tabular-nums ring-2",
            size,
            textSize,
          )}
          title={members
            .slice(maxVisible)
            .map((m) => m.userName)
            .join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
};
