import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import { getDisplayName } from "@/lib/get-display-name";
import type { Workspace } from "@/lib/workspaces/types";

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
  // Explicit ReactNode: `emptyFallback` widens the inferred return to a type
  // containing React 19's Promise<AwaitedReactNode> member, which
  // promise-function-async would otherwise flag on this sync component.
}: TeamAvatarsProps): React.ReactNode => {
  const t = useTranslations();
  if (members.length === 0) {
    return emptyFallback ?? <span className="text-muted-foreground">—</span>;
  }
  const visible = members.slice(0, maxVisible);
  const overflow = members.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((m) => {
        const isLead = leadUserId === m.userId;
        const displayName =
          getDisplayName(m.userName, m.userEmail) ?? t("common.unknownUser");
        return (
          <Tooltip
            content={
              isLead ? `${displayName} · ${t("workspaces.lead")}` : displayName
            }
            key={m.userId}
            render={
              <UserAvatar
                className={cn(
                  "ring-background ring-2",
                  size,
                  textSize,
                  isLead && "ring-primary",
                )}
                image={m.userImage}
                name={displayName}
              />
            }
          />
        );
      })}
      {overflow > 0 && (
        <Tooltip
          content={members
            .slice(maxVisible)
            .map(
              (m) =>
                getDisplayName(m.userName, m.userEmail) ??
                t("common.unknownUser"),
            )
            .join(", ")}
          render={
            <span
              className={cn(
                "bg-muted text-muted-foreground ring-background relative z-10",
                "flex items-center justify-center rounded-full font-medium tabular-nums ring-2",
                size,
                textSize,
              )}
            >
              +{overflow}
            </span>
          }
        />
      )}
    </div>
  );
};
