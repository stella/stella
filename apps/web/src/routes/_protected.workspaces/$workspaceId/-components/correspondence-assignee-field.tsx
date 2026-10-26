import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import {
  MEMBER_CHOICE,
  MemberCombobox,
  workspaceMemberOptionsFromView,
} from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { usePermissions } from "@/hooks/use-permissions";
import { getDisplayName } from "@/lib/get-display-name";
import { useQueryView } from "@/lib/use-query-view";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";
import { useUpdateCorrespondence } from "@/routes/_protected.workspaces/$workspaceId/-mutations/correspondence";

type CorrespondenceAssigneeFieldProps = {
  workspaceId: string;
  correspondenceId: string;
  assigneeId: string | null;
};

/** Who handles a filed message: a matter member, or nobody. */
export const CorrespondenceAssigneeField = ({
  workspaceId,
  correspondenceId,
  assigneeId,
}: CorrespondenceAssigneeFieldProps) => {
  const t = useTranslations();
  const membersView = useQueryView(
    useQuery(workspaceMembersOptions(workspaceId)),
  );
  const members = workspaceMemberOptionsFromView(membersView);
  const update = useUpdateCorrespondence();
  const canUpdate = usePermissions({ workspace: ["update"] });

  if (!canUpdate) {
    const assignee = members.find((member) => member.userId === assigneeId);
    return (
      <>
        <QueryViewFeedback view={membersView} />
        {assignee
          ? (getDisplayName(assignee.name, assignee.email) ??
            t("common.unknownUser"))
          : t("common.unassigned")}
      </>
    );
  }
  return (
    <div className="w-full sm:max-w-64">
      <QueryViewFeedback view={membersView} />
      <MemberCombobox
        choice={{
          type: MEMBER_CHOICE.memberOrNone,
          noneLabel: t("common.unassigned"),
        }}
        disabled={update.isPending}
        label={t("common.assignee")}
        members={members}
        onValueChange={(nextAssigneeId) => {
          if (nextAssigneeId === assigneeId) {
            return;
          }
          update.mutate({
            workspaceId,
            correspondenceId,
            type: "assign",
            assigneeId: nextAssigneeId,
          });
        }}
        placeholder={t("common.unassigned")}
        value={assigneeId}
      />
    </div>
  );
};
