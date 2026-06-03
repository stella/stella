import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { UserIdentity } from "@/components/user-avatar";
import { usePermissions } from "@/hooks/use-permissions";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { workspaceMembersOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import { useUpdateWorkspace } from "@/routes/_protected.workspaces/-mutations";
import { workspaceOptions } from "@/routes/_protected.workspaces/-queries";

type LeadSectionProps = {
  workspaceId: string;
};

export const LeadSection = ({ workspaceId }: LeadSectionProps) => {
  const t = useTranslations();
  const canUpdate = usePermissions({ workspace: ["update"] });
  const { data: workspace } = useQuery(workspaceOptions(workspaceId));
  const { data: members = [] } = useQuery(workspaceMembersOptions(workspaceId));
  const updateWorkspace = useUpdateWorkspace();

  if (!workspace) {
    return null;
  }
  const leadUserId = workspace.leadUserId;
  const memberItems = members.map((m) => ({
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
      { workspaceId, leadUserId: value },
      {
        onError: () => {
          stellaToast.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
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
                  avatarClassName="size-6 shrink-0 text-[0.625rem]"
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
    </section>
  );
};
