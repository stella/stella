import { useState } from "react";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { PlusIcon, TrashIcon, UserIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
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
} from "@stella/ui/components/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { usePermissions } from "@/hooks/use-permissions";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import {
  useAddWorkspaceMember,
  useRemoveWorkspaceMember,
} from "@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-members";
import {
  workspaceMembersKeys,
  workspaceMembersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";

type MembersSectionProps = {
  workspaceId: string;
};

export const MembersSection = ({ workspaceId }: MembersSectionProps) => {
  const t = useTranslations();
  const { data: members = [] } = useQuery(workspaceMembersOptions(workspaceId));
  const canUpdate = usePermissions({ workspace: ["update"] });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {t("workspaces.sections.members")}
        </h3>
        {canUpdate && <AddMemberDialog workspaceId={workspaceId} />}
      </div>
      {members.length > 0 ? (
        <ul className="space-y-1">
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
        <p className="text-sm text-muted-foreground">
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
  const removeMember = useRemoveWorkspaceMember();

  const handleRemove = () => {
    removeMember.mutate(
      { workspaceId, userId: member.userId },
      {
        onSuccess: () => {
          toastManager.add({
            title: t("success.memberRemoved"),
            type: "success",
          });
          queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
        },
        onError: () => {
          toastManager.add({
            title: t("errors.actionFailed"),
            type: "error",
          });
        },
      },
    );
  };

  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2">
      <UserIcon className="size-4 text-muted-foreground" />
      <div className="flex flex-col">
        <span className="text-sm font-medium">
          {member.user?.name ?? member.userId}
        </span>
        {member.user?.email && (
          <span className="text-xs text-muted-foreground">
            {member.user.email}
          </span>
        )}
      </div>
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
};

const AddMemberDialog = ({ workspaceId }: AddMemberDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const addMember = useAddWorkspaceMember();
  const { data: org } = useSuspenseQuery(organizationOptions);
  const { data: existingMembers = [] } = useQuery(
    workspaceMembersOptions(workspaceId),
  );
  const [isOpen, setIsOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const existingUserIds = new Set(existingMembers.map((m) => m.userId));
  const availableMembers = org.members.filter(
    (m) => !existingUserIds.has(m.userId),
  );

  const memberItems = availableMembers.map((m) => ({
    label: `${m.user.name} (${m.user.email})`,
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
          toastManager.add({
            title: t("success.memberAdded"),
            type: "success",
          });
          queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
          setIsOpen(false);
          setSelectedUserId(null);
        },
        onError: () => {
          toastManager.add({
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
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <PlusIcon className="size-3.5" />
        {t("workspaces.members.addMember")}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("workspaces.members.addMember")}</DialogTitle>
          <DialogDescription>
            {t("workspaces.members.addMemberDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Select
            items={memberItems}
            onValueChange={setSelectedUserId}
            value={selectedUserId}
          >
            <SelectTrigger>
              <SelectValue>
                {(current) => {
                  const found = memberItems.find((m) => m.value === current);
                  return found?.label ?? t("workspaces.members.selectMember");
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {memberItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
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
