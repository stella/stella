import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

type ClientGroupHeaderProps = {
  groupId: string;
  clientId: string;
  clientName: string;
  responsibleAttorneyName: string | null;
  matterCount: number;
  collapsed: boolean;
  onToggle: () => void;
};

export const ClientGroupHeader = ({
  groupId,
  clientId,
  clientName,
  responsibleAttorneyName,
  matterCount,
  collapsed,
  onToggle,
}: ClientGroupHeaderProps) => {
  const navigate = useNavigate();

  return (
    <button
      className={cn(
        "sticky top-0 z-10 col-span-full",
        "flex cursor-pointer items-center gap-2",
        "bg-background/95 border-b backdrop-blur-sm",
        "pt-4 pb-2 text-left first:pt-0",
      )}
      data-group-id={groupId}
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
        <span
          className="hover:underline"
          onClick={(e) => {
            e.stopPropagation();
            void navigate({
              to: "/contacts/$contactId",
              params: { contactId: clientId },
            });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.stopPropagation();
              void navigate({
                to: "/contacts/$contactId",
                params: { contactId: clientId },
              });
            }
          }}
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="link"
          tabIndex={0}
        >
          {clientName}
        </span>
      </h3>
      <span
        className={cn(
          "bg-muted rounded-full px-1.5 py-0.5",
          "text-muted-foreground text-[0.625rem] tabular-nums",
        )}
      >
        {matterCount}
      </span>
      {responsibleAttorneyName && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="text-muted-foreground text-xs">
            {responsibleAttorneyName}
          </span>
        </>
      )}
    </button>
  );
};
