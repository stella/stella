import { useNavigate } from "@tanstack/react-router";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import type { WorkspaceGroup } from "@/lib/workspaces/types";
import {
  CLIENT_GROUP_BAND_CLASS,
  CLIENT_GROUP_COUNT_CLASS,
  CLIENT_GROUP_TITLE_CLASS,
} from "@/routes/_protected.workspaces/-components/client-group-section.pending";

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
  const format = useFormatter();
  const matterCount = group.workspaces.length;

  return (
    <Button
      className="sticky top-0 z-10 col-span-full flex"
      data-group-id={group.groupId}
      onClick={onToggle}
      variant="plain"
    >
      {/* The sticky band the matters scroll under. */}
      <span className={CLIENT_GROUP_BAND_CLASS}>
        <DirectionalIcon
          className={cn(
            "text-muted-foreground size-3.5 shrink-0 transition-transform",
            !collapsed && "rotate-90",
          )}
          flip={collapsed}
          icon={ChevronRightIcon}
        />
        <h3 className={CLIENT_GROUP_TITLE_CLASS}>
          {group.type === "personal" ? (
            <span>{personalLabel}</span>
          ) : (
            <span
              aria-label={group.clientName}
              className="hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                detached(
                  navigate({
                    to: "/contacts/$contactId",
                    params: { contactId: group.clientId },
                  }),
                  "client-group-header.navigate",
                );
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  detached(
                    navigate({
                      to: "/contacts/$contactId",
                      params: { contactId: group.clientId },
                    }),
                    "client-group-header.navigate",
                  );
                }
              }}
              role="link"
              tabIndex={0}
            >
              <BidiText>{group.clientName}</BidiText>
            </span>
          )}
        </h3>
        <span className={CLIENT_GROUP_COUNT_CLASS}>
          {format.number(matterCount)}
        </span>
        {group.type === "client" && group.responsibleAttorneyName && (
          <>
            <span className="text-foreground-subtle">·</span>
            <BidiText as="span" className="text-muted-foreground text-xs">
              {group.responsibleAttorneyName}
            </BidiText>
          </>
        )}
      </span>
    </Button>
  );
};
