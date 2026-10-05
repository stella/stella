import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { UserIdentity } from "@/components/user-avatar";
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
  const memberItems = content.members.map((m) => ({
    email: m.user?.email ?? null,
    image: m.user?.image ?? null,
    name: m.user?.name ?? m.userId,
    value: m.userId,
  }));

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
          <Select
            disabled={!canUpdate || updateWorkspace.isPending}
            onValueChange={(value) => {
              if (typeof value !== "string") {
                return;
              }
              handleSelect(value);
            }}
            value={leadUserId ?? ""}
          >
            <SelectTrigger className="min-w-0 flex-1 rounded-md shadow-none">
              <SelectValue>
                {(current) => {
                  const found = memberItems.find((m) => m.value === current);
                  if (!found) {
                    return (
                      <span className="text-muted-foreground">
                        {t("workspaces.leadEmpty")}
                      </span>
                    );
                  }
                  return (
                    <UserIdentity
                      avatarClassName="size-5 shrink-0 text-[0.5625rem]"
                      className="min-w-0"
                      image={found.image}
                      name={found.name}
                      nameClassName="text-sm"
                    />
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {memberItems.length === 0 && (
                <div className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("workspaces.leadPicker.noMatchingMembers")}
                </div>
              )}
              {memberItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <UserIdentity
                    avatarClassName="size-6 shrink-0 text-3xs"
                    className="min-w-0"
                    image={item.image}
                    name={item.name}
                    secondaryText={item.email ?? null}
                  />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
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
