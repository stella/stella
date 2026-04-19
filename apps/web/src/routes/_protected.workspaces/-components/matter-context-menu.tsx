/**
 * Shared matter context menu used by both the matter card grid
 * and the sidebar pinned items. Right-click to open.
 *
 * `MatterMenuItems` — the actual menu items, used by both
 * `MatterContextMenu` (card right-click) and the sidebar's
 * own Menu component to guarantee 1:1 parity.
 */

import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ClipboardCopyIcon,
  ExternalLinkIcon,
  PenLineIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
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
} from "@stella/ui/components/dialog";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stella/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { toastManager } from "@stella/ui/components/toast";

import { UserIdentity } from "@/components/user-avatar";
import { usePinnedStore } from "@/lib/pinned-store";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import { useAddWorkspaceMember } from "@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-members";
import {
  workspaceMembersKeys,
  workspaceMembersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  useArchiveWorkspace,
  useDeleteWorkspace,
  useUnarchiveWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

// ── Shared menu items ────────────────────────────────────────

export type MatterMenuCallbacks = {
  onOpenInNewTab: () => void;
  onRename: () => void;
  onAddMember: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  isPinned: boolean;
  isArchived: boolean;
};

/**
 * Renders the canonical set of matter menu items.
 * Used inside both the card context menu and the sidebar menu
 * to guarantee identical actions, icons, and order.
 */
export const MatterMenuItems = ({
  onOpenInNewTab,
  onRename,
  onAddMember,
  onCopyLink,
  onTogglePin,
  onArchive,
  onDelete,
  isPinned,
  isArchived,
}: MatterMenuCallbacks) => {
  const t = useTranslations();

  return (
    <>
      <MenuItem onClick={onOpenInNewTab}>
        <ExternalLinkIcon />
        {t("common.openInNewTab")}
      </MenuItem>
      <MenuItem onClick={onRename}>
        <PenLineIcon />
        {t("common.rename")}
      </MenuItem>
      <MenuItem onClick={onAddMember}>
        <UserPlusIcon />
        {t("workspaces.members.addMember")}
      </MenuItem>
      <MenuItem onClick={onCopyLink}>
        <ClipboardCopyIcon />
        {t("common.copyLink")}
      </MenuItem>
      <MenuItem onClick={onTogglePin}>
        {isPinned ? <PinOffIcon /> : <PinIcon />}
        {isPinned ? t("common.unpin") : t("common.pin")}
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={onArchive}>
        {isArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
        {isArchived
          ? t("workspaces.unarchiveMatter")
          : t("workspaces.archiveMatter")}
      </MenuItem>
      <MenuItem onClick={onDelete} variant="destructive">
        <Trash2Icon />
        {t("common.delete")}
      </MenuItem>
    </>
  );
};

// ── Rename state ─────────────────────────────────────────────

export type RenameState = {
  active: boolean;
  draft: string;
  setDraft: (v: string) => void;
  commit: () => void;
  cancel: () => void;
};

// ── MatterContextMenu (card wrapper) ─────────────────────────

type MatterContextMenuProps = {
  workspaceId: string;
  workspaceName: string;
  isArchived?: boolean;
  children: React.ReactNode | ((rename: RenameState) => React.ReactNode);
};

export const MatterContextMenu = ({
  workspaceId,
  workspaceName,
  isArchived = false,
  children,
}: MatterContextMenuProps) => {
  const t = useTranslations();
  const { togglePin, isPinned } = usePinnedStore();
  const pinned = isPinned(workspaceId);

  const queryClient = useQueryClient();
  const updateWorkspace = useUpdateWorkspace();
  const archiveWorkspace = useArchiveWorkspace();
  const unarchiveWorkspace = useUnarchiveWorkspace();
  const deleteWorkspace = useDeleteWorkspace();

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(workspaceName);
  const [addMemberOpen, setAddMemberOpen] = useState(false);

  const commitRename = () => {
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== workspaceName) {
      updateWorkspace.mutate({ workspaceId, name: trimmed });
    }
    setRenaming(false);
  };

  const cancelRename = () => {
    setRenameDraft(workspaceName);
    setRenaming(false);
  };

  const renameState: RenameState = {
    active: renaming,
    draft: renameDraft,
    setDraft: setRenameDraft,
    commit: commitRename,
    cancel: cancelRename,
  };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/workspaces/${workspaceId}`;
    try {
      await navigator.clipboard.writeText(url);
      toastManager.add({ title: t("common.copied"), type: "success" });
    } catch {
      toastManager.add({ title: t("errors.actionFailed"), type: "error" });
    }
  };

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const x = e.clientX;
        const y = e.clientY;
        setMenuAnchor({
          getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
        });
        setMenuOpen(true);
      }}
    >
      {typeof children === "function" ? children(renameState) : children}

      <Menu
        onOpenChange={(nextOpen) => {
          setMenuOpen(nextOpen);
          if (!nextOpen) {
            setMenuAnchor(null);
          }
        }}
        open={menuOpen}
      >
        <MenuTrigger
          nativeButton={false}
          render={<span className="sr-only" />}
        />
        <MenuPopup anchor={menuAnchor ?? undefined} className="z-50">
          <MatterMenuItems
            isArchived={isArchived}
            isPinned={pinned}
            onAddMember={() => setAddMemberOpen(true)}
            onOpenInNewTab={() =>
              window.open(`/workspaces/${workspaceId}`, "_blank")
            }
            onArchive={() => {
              const onError = () => {
                toastManager.add({
                  title: t("errors.actionFailed"),
                  type: "error",
                });
              };

              if (isArchived) {
                unarchiveWorkspace.mutate({ workspaceId }, { onError });
              } else {
                archiveWorkspace.mutate({ workspaceId }, { onError });
              }
            }}
            onCopyLink={handleCopyLink}
            onDelete={() => {
              if (deleteWorkspace.isPending) {
                return;
              }

              const toastId = toastManager.add({
                title: t("workspaces.deletingWorkspace"),
                type: "loading",
                timeout: Number.POSITIVE_INFINITY,
              });

              deleteWorkspace.mutate(
                { workspaceId },
                {
                  onSuccess: () => {
                    toastManager.update(toastId, {
                      title: t("success.workspaceDeletedSuccessfully"),
                      type: "success",
                    });
                    // eslint-disable-next-line typescript/no-floating-promises
                    queryClient.invalidateQueries({
                      queryKey: workspacesKeys.all,
                    });
                  },
                  onError: () => {
                    toastManager.update(toastId, {
                      title: t("errors.failedToDeleteWorkspace"),
                      type: "error",
                    });
                  },
                },
              );
            }}
            onRename={() => {
              setRenameDraft(workspaceName);
              setRenaming(true);
            }}
            onTogglePin={() => togglePin(workspaceId)}
          />
        </MenuPopup>
      </Menu>

      {addMemberOpen && (
        <AddMemberDialog
          onOpenChange={setAddMemberOpen}
          open={addMemberOpen}
          workspaceId={workspaceId}
        />
      )}
    </div>
  );
};

// ── Add Member Dialog ────────────────────────────────────────

type AddMemberDialogProps = {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const AddMemberDialog = ({
  workspaceId,
  open,
  onOpenChange,
}: AddMemberDialogProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const addMember = useAddWorkspaceMember();
  const { data: org, isPending: orgPending } = useQuery(organizationOptions);
  const { data: existingMembers = [] } = useQuery(
    workspaceMembersOptions(workspaceId),
  );
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const existingUserIds = new Set(existingMembers.map((m) => m.userId));
  const availableMembers = (org?.members ?? []).filter(
    (m) => !existingUserIds.has(m.userId),
  );

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
          toastManager.add({
            title: t("success.memberAdded"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
          onOpenChange(false);
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
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          setSelectedUserId(null);
        }
      }}
      open={open}
    >
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
            disabled={!selectedUserId || addMember.isPending || orgPending}
            onClick={handleSubmit}
          >
            {t("workspaces.members.addMember")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
