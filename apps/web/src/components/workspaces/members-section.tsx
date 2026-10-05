import { useState } from "react";
import type { ComponentProps } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFormState,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { PlusIcon, TrashIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { UserIdentity } from "@/components/user-avatar";
import {
  AddableMemberSelect,
  useAddableMembers,
} from "@/components/workspaces/addable-member-select";
import { MATTER_INFO_ICON_SLOT_CLASS } from "@/components/workspaces/matter-info-layout";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { QueryView } from "@/lib/query-view.logic";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView } from "@/lib/use-query-view";
import { useAddWorkspaceMember } from "@/lib/workspaces/mutations/workspace-members";
import { workspacesKeys } from "@/lib/workspaces/queries";
import {
  workspaceMembersKeys,
  workspaceMembersOptions,
} from "@/lib/workspaces/queries/workspace-members";

type MembersSectionProps = {
  workspaceId: string;
};

type MemberData = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof workspaceMembersOptions>["queryFn"]>
    >
  >
>[number];

type MembersListProps = {
  view: QueryView<MemberData[], Error>;
  workspaceId: string;
  canUpdate: boolean;
};

export const MembersList = ({
  view,
  workspaceId,
  canUpdate,
}: MembersListProps) => {
  const t = useTranslations();
  switch (view.type) {
    case "pending":
    case "error":
      return <QueryViewFeedback view={view} />;
    case "empty":
      return (
        <p className="text-muted-foreground text-sm">
          {t("workspaces.members.noMembersFound")}
        </p>
      );
    case "items":
      return (
        <>
          <QueryViewFeedback view={view} />
          <ul>
            {view.items.map((member) => (
              <MemberRow
                canUpdate={canUpdate}
                key={member.id}
                member={member}
                membersCount={view.items.length}
                workspaceId={workspaceId}
              />
            ))}
          </ul>
        </>
      );
    default:
      view satisfies never;
      return panic("Unhandled member list state");
  }
};

export const MembersSection = ({ workspaceId }: MembersSectionProps) => {
  const t = useTranslations();
  const view = useQueryView(useQuery(workspaceMembersOptions(workspaceId)));
  const canUpdate = usePermissions({ workspace: ["update"] });

  return (
    <section>
      <div
        className={cn(
          "flex items-center justify-between gap-2 px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <h3 className="text-muted-foreground text-sm font-medium">
          {t("common.members")}
        </h3>
        {canUpdate && (
          <AddMemberDialog
            showTriggerLabel={false}
            triggerSize="icon-xs"
            triggerVariant="ghost"
            workspaceId={workspaceId}
          />
        )}
      </div>
      <MembersList
        view={view}
        canUpdate={canUpdate}
        workspaceId={workspaceId}
      />
    </section>
  );
};

type MemberRowProps = {
  member: MemberData;
  workspaceId: string;
  membersCount: number;
  canUpdate: boolean;
};

const MemberRow = ({
  member,
  workspaceId,
  membersCount,
  canUpdate,
}: MemberRowProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const analytics = useAnalytics();
  const removeMember = useMutation({
    mutationFn: async (vars: { workspaceId: string; userId: string }) => {
      const response = await api
        .workspaces({ workspaceId: toSafeId<"workspace">(vars.workspaceId) })
        .members({ userId: toSafeId<"user">(vars.userId) })
        .delete({});

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onError: (error) => {
      analytics.captureError(error);
    },
  });

  const handleRemove = () => {
    removeMember.mutate(
      { workspaceId, userId: member.userId },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.memberRemoved"),
            type: "success",
          });
          detached(
            queryClient.invalidateQueries({
              queryKey: workspaceMembersKeys.all(workspaceId),
            }),
            "members-section.invalidate",
          );
          detached(
            queryClient.invalidateQueries({ queryKey: workspacesKeys.all }),
            "members-section.invalidate",
          );
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  return (
    <li className={cn("flex items-center gap-2 px-3", TOOLBAR_ROW_HEIGHT)}>
      <UserIdentity
        avatarClassName={cn(MATTER_INFO_ICON_SLOT_CLASS, "text-[0.5625rem]")}
        className="min-w-0 flex-1"
        image={member.user?.image}
        name={member.user?.name ?? member.userId}
        nameClassName="text-sm"
        secondaryClassName="text-xs"
        secondaryText={member.user?.email ?? null}
      />
      {canUpdate && membersCount > 1 && (
        <Dialog>
          <DialogTrigger
            render={
              <Button
                aria-label={t("common.removeMember")}
                className="ms-auto"
                size="icon-xs"
                variant="ghost"
              />
            }
          >
            <TrashIcon className="size-3.5" />
          </DialogTrigger>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{t("common.removeMember")}</DialogTitle>
              <DialogDescription>
                {t("workspaces.members.removeMemberConfirm")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                {t("common.cancel")}
              </DialogClose>
              <Button
                disabled={removeMember.isPending}
                onClick={handleRemove}
                variant="destructive"
              >
                {t("common.removeMember")}
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      )}
    </li>
  );
};

type AddMemberDialogProps = {
  workspaceId: string;
  triggerClassName?: string | undefined;
  triggerSize?: ComponentProps<typeof Button>["size"] | undefined;
  triggerVariant?: ComponentProps<typeof Button>["variant"] | undefined;
  showTriggerLabel?: boolean | undefined;
};

export const AddMemberDialog = ({
  workspaceId,
  triggerClassName,
  triggerSize = "sm",
  triggerVariant = "outline",
  showTriggerLabel = true,
}: AddMemberDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const addMember = useAddWorkspaceMember();
  const memberQuery = useAddableMembers(workspaceId);
  const [isOpen, setIsOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const selectedMember =
    memberQuery.view.type === "items"
      ? memberQuery.view.items.find((item) => item.value === selectedUserId)
      : undefined;

  const handleSubmit = () => {
    if (!selectedMember) {
      return;
    }

    addMember.mutate(
      { workspaceId, userId: selectedMember.value },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.memberAdded"),
            type: "success",
          });
          detached(
            queryClient.invalidateQueries({
              queryKey: workspaceMembersKeys.all(workspaceId),
            }),
            "members-section.invalidate",
          );
          setIsOpen(false);
          setSelectedUserId(null);
        },
        onError: (error) => {
          notifyUserError(error, t("errors.actionFailed"));
        },
      },
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        setIsOpen(open);
        if (!open) {
          setSelectedUserId(null);
        }
      }}
      open={isOpen}
    >
      <DialogTrigger
        render={
          <Button
            aria-label={t("workspaces.members.addMember")}
            className={triggerClassName}
            size={triggerSize}
            title={t("workspaces.members.addMember")}
            variant={triggerVariant}
          />
        }
      >
        <PlusIcon className="size-3.5" />
        {showTriggerLabel ? t("workspaces.members.addMember") : null}
      </DialogTrigger>
      <DialogPopup>
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
          <AddableMemberSelect
            query={memberQuery}
            onValueChange={setSelectedUserId}
            value={selectedUserId}
          />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={selectedMember === undefined || addMember.isPending}
            onClick={handleSubmit}
          >
            {t("workspaces.members.addMember")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
