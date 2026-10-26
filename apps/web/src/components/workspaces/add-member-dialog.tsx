import { useState } from "react";
import type { ReactNode } from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogFormState,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { MEMBER_CHOICE, MemberCombobox } from "@/components/member-combobox";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { addMemberCandidates } from "@/components/workspaces/add-member-dialog.logic";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { organizationOptions } from "@/lib/organization/queries";
import { useQueryView } from "@/lib/use-query-view";
import { useAddWorkspaceMember } from "@/lib/workspaces/mutations/workspace-members";
import { workspaceMembersOptions } from "@/lib/workspaces/queries/workspace-members";

type AddMemberDialogProps = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A `DialogTrigger`, when the dialog opens from a button of its own. */
  children?: ReactNode;
};

/**
 * Adds an organization member to a matter. The organization's member list is
 * read only while the dialog is open: the popup unmounts its body when closed.
 */
export const AddMemberDialog = ({
  workspaceId,
  open,
  onOpenChange,
  children,
}: AddMemberDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    {children}
    <DialogPopup>
      <AddMemberDialogBody
        onAdded={() => onOpenChange(false)}
        workspaceId={workspaceId}
      />
    </DialogPopup>
  </Dialog>
);

type AddMemberDialogBodyProps = {
  workspaceId: string;
  onAdded: () => void;
};

const AddMemberDialogBody = ({
  workspaceId,
  onAdded,
}: AddMemberDialogBodyProps) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const organizationView = useQueryView(
    useQuery(organizationOptions(activeOrganizationId)),
  );
  const membersView = useQueryView(
    useQuery(workspaceMembersOptions(workspaceId)),
  );
  const candidates = addMemberCandidates(organizationView, membersView);
  const addMember = useAddWorkspaceMember();
  const submitOnce = useSingleFlight();
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const addSelectedMember = (settled: () => void) => {
    if (selectedUserId === null) {
      settled();
      return;
    }
    addMember.mutate(
      { workspaceId, userId: selectedUserId },
      {
        onSettled: settled,
        onSuccess: () => {
          stellaToast.add({
            title: t("success.memberAdded"),
            type: "success",
          });
          onAdded();
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };
  const handleSubmit = () => {
    detached(
      submitOnce.runSettled(addSelectedMember),
      "add-member-dialog.submit",
    );
  };

  const picker = (() => {
    switch (candidates.type) {
      case "pending":
      case "error":
        return null;
      case "empty":
        return (
          <p className="text-muted-foreground text-sm">
            {t("workspaces.leadPicker.noMatchingMembers")}
          </p>
        );
      case "items":
        return (
          <MemberCombobox
            autoFocus
            label={t("workspaces.members.addMember")}
            members={candidates.members}
            onSubmit={handleSubmit}
            onValueChange={setSelectedUserId}
            placeholder={t("common.searchMembers")}
            choice={{ type: MEMBER_CHOICE.member }}
            unavailable={{
              userIds: candidates.existingUserIds,
              reason: t("workspaces.members.alreadyOnMatter"),
            }}
            value={selectedUserId}
          />
        );
      default:
        candidates satisfies never;
        return panic("Unhandled add member candidates state");
    }
  })();

  return (
    <>
      <DialogFormState
        dirty={selectedUserId !== null}
        onDiscard={() => {
          setSelectedUserId(null);
        }}
      />
      <DialogHeader>
        <DialogTitle>{t("workspaces.members.addMember")}</DialogTitle>
        <DialogDescription>
          {t("workspaces.members.addMemberDescription")}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        <QueryViewFeedback view={organizationView} />
        <QueryViewFeedback view={membersView} />
        {picker}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button
          disabled={selectedUserId === null || addMember.isPending}
          onClick={handleSubmit}
        >
          {t("workspaces.members.addMember")}
        </Button>
      </DialogFooter>
    </>
  );
};
