import { useState } from "react";
import type { ComponentProps } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/components/dialog";
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
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import { MATTER_INFO_ICON_SLOT_CLASS } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-info-layout";
import { useAddWorkspaceMember } from "@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-members";
import {
  workspaceMembersKeys,
  workspaceMembersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

type MembersSectionProps = {
  workspaceId: string;
};

export const MembersSection = ({ workspaceId }: MembersSectionProps) => {
  const t = useTranslations();
  const { data: members = [] } = useQuery(workspaceMembersOptions(workspaceId));
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
          {t("workspaces.sections.members")}
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
      {members.length > 0 ? (
        <ul>
          {members.map((member) => (
            <MemberRow
              canUpdate={canUpdate}
              key={member.id}
              member={member}
              membersCount={members.length}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("workspaces.members.noMembersFound")}
        </p>
      )}
    </section>
  );
};

type MemberData = NonNullable<
  Awaited<
    ReturnType<
      NonNullable<ReturnType<typeof workspaceMembersOptions>["queryFn"]>
    >
  >
>[number];

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
        .delete({
          queryKey: workspacesKeys.all,
        });

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
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
        },
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
                aria-label={t("workspaces.members.removeMember")}
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
              <DialogTitle>{t("workspaces.members.removeMember")}</DialogTitle>
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
                {t("workspaces.members.removeMember")}
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
  const orgQuery = useQuery(organizationOptions);
  const org = orgQuery.data;
  const { data: existingMembers = [] } = useQuery(
    workspaceMembersOptions(workspaceId),
  );
  const [isOpen, setIsOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const existingUserIds = new Set(existingMembers.map((m) => m.userId));
  const availableMembers =
    org?.members.filter((m) => !existingUserIds.has(m.userId)) ?? [];

  const memberItems = availableMembers.map((m) => ({
    email: m.user.email,
    image: m.user.image,
    name: m.user.name,
    value: m.userId,
  }));

  const handleSubmit = () => {
    if (!selectedUserId) {
      return;
    }

    addMember.mutate(
      { workspaceId, userId: selectedUserId },
      {
        onSuccess: () => {
          stellaToast.add({
            title: t("success.memberAdded"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
          setIsOpen(false);
          setSelectedUserId(null);
        },
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
        <DialogHeader>
          <DialogTitle>{t("workspaces.members.addMember")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.members.addMemberDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Select onValueChange={setSelectedUserId} value={selectedUserId}>
            <SelectTrigger>
              <SelectValue>
                {(current) => {
                  const found = memberItems.find((m) => m.value === current);
                  if (!found) {
                    return t("workspaces.members.selectMember");
                  }

                  return (
                    <UserIdentity
                      avatarClassName="size-7 shrink-0 text-[0.625rem]"
                      className="min-w-0"
                      image={found.image}
                      name={found.name}
                      secondaryText={found.email}
                    />
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {memberItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <UserIdentity
                    avatarClassName="size-7 shrink-0 text-[0.625rem]"
                    className="min-w-0"
                    image={item.image}
                    name={item.name}
                    secondaryText={item.email}
                  />
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={!selectedUserId || addMember.isPending}
            onClick={handleSubmit}
          >
            {t("workspaces.members.addMember")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
