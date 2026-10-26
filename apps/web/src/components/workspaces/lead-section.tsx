import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import {
  MEMBER_CHOICE,
  MemberCombobox,
  workspaceMemberOptions,
} from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { leadSectionContent } from "@/components/workspaces/lead-section.logic";
import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useQueryView } from "@/lib/use-query-view";
import { useUpdateWorkspace } from "@/lib/workspaces/mutations";
import { workspaceOptions } from "@/lib/workspaces/queries";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";

type LeadSectionProps = {
  workspaceId: string;
};

export const LeadSection = ({ workspaceId }: LeadSectionProps) => {
  const t = useTranslations();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const workspaceView = useQueryView(useQuery(workspaceOptions(workspaceId)));
  const membersView = useQueryView(
    useQuery(workspaceMembersOptions(workspaceId)),
  );
  const content = leadSectionContent({
    workspace: workspaceView,
    members: membersView,
  });
  const updateWorkspace = useUpdateWorkspace();

  switch (content.type) {
    case "pending":
    case "error":
      return (
        <section className="border-b px-3 py-2">
          <span className="text-muted-foreground text-sm font-medium">
            {t("workspaces.lead")}
          </span>
          <QueryViewFeedback view={content} />
        </section>
      );
    case "empty":
      return (
        <section className="border-b px-3 py-2">
          <span className="text-muted-foreground text-sm font-medium">
            {t("workspaces.lead")}
          </span>
          <p className="text-muted-foreground text-sm">
            {t("workspaces.leadEmpty")}
          </p>
        </section>
      );
    case "items":
      break;
    default:
      content satisfies never;
      return panic("Unhandled matter lead read state");
  }
  const leadUserId = content.workspace.leadUserId;
  const memberOptions = workspaceMemberOptions(content.members);

  const handleSelect = (value: string | null) => {
    if (value === leadUserId) {
      return;
    }
    updateWorkspace.mutate(
      {
        workspaceId,
        update: { type: "leadUserId", value },
      },
      {
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  return (
    <section
      className={cn(
        "grid shrink-0 grid-cols-[8rem_minmax(0,1fr)] items-center gap-3 border-b px-3",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      <span className="text-muted-foreground truncate text-sm font-medium">
        {t("workspaces.lead")}
      </span>
      <div className="min-w-0">
        <QueryViewFeedback view={workspaceView} />
        <QueryViewFeedback view={membersView} />
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <MemberCombobox
              choice={{ type: MEMBER_CHOICE.member }}
              disabled={!canUpdate || updateWorkspace.isPending}
              label={t("workspaces.lead")}
              members={memberOptions}
              onValueChange={handleSelect}
              placeholder={t("workspaces.leadEmpty")}
              value={leadUserId}
            />
          </div>
          {canUpdate && leadUserId && (
            <Button
              aria-label={t("common.remove")}
              disabled={updateWorkspace.isPending}
              onClick={() => handleSelect(null)}
              size="icon-xs"
              variant="ghost"
            >
              <XIcon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </section>
  );
};
