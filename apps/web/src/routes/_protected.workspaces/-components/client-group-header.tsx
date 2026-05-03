import { cn } from "@stll/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import type { WorkspaceGroup } from "@/routes/_protected.workspaces/-types";

type ClientGroupHeaderProps = {
  group: WorkspaceGroup;
  personalLabel: string;
  collapsed: boolean;
  onToggle: () => void;
};

export const ClientGroupHeader = ({
  group,
  personalLabel,
  collapsed,
  onToggle,
}: ClientGroupHeaderProps) => {
  const navigate = useNavigate();
  const matterCount = group.workspaces.length;

  return (
    <button
      className={cn(
        "sticky top-0 z-10 col-span-full",
        "flex cursor-pointer items-center gap-2",
        "bg-background/95 border-b backdrop-blur-sm",
        "pt-4 pb-2 text-start first:pt-0",
      )}
      data-group-id={group.groupId}
      onClick={onToggle}
      type="button"
    >
      <ChevronRightIcon
        className={cn(
          "text-muted-foreground size-3.5 shrink-0 transition-transform",
          !collapsed && "rotate-90",
        )}
      />
      <h3 className="text-sm font-semibold">
        {group.type === "personal" ? (
          <span>{personalLabel}</span>
        ) : (
          <span
            className="hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              void navigate({
                to: "/contacts/$contactId",
                params: { contactId: group.clientId },
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                void navigate({
                  to: "/contacts/$contactId",
                  params: { contactId: group.clientId },
                });
              }
            }}
            // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
            role="link"
            tabIndex={0}
          >
            {group.clientName}
          </span>
        )}
      </h3>
      <span
        className={cn(
          "bg-muted rounded-full px-1.5 py-0.5",
          "text-muted-foreground text-[0.625rem] tabular-nums",
        )}
      >
        {matterCount}
      </span>
      {group.type === "client" && group.responsibleAttorneyName && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground text-xs">
            {group.responsibleAttorneyName}
          </span>
        </>
      )}
    </button>
  );
};
