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
  ArchiveRestoreIcon,
  ClipboardCopyIcon,
  ExternalLinkIcon,
  PenLineIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { DestructiveConfirmDialog } from "@stll/ui/components/destructive-confirm-dialog";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/components/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";

import { UserIdentity } from "@/components/user-avatar";
import { usePinnedStore } from "@/lib/pinned-store";
import { organizationOptions } from "@/routes/_protected.organization/-queries";
import { useAddWorkspaceMember } from "@/routes/_protected.workspaces/$workspaceId/-mutations/workspace-members";
import {
  workspaceMembersKeys,
  workspaceMembersOptions,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace-members";
import {
  useDeleteWorkspace,
  useUnarchiveWorkspace,
  useUpdateWorkspace,
} from "@/routes/_protected.workspaces/-mutations";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";
import { useCreateMatterStore } from "@/routes/_protected.workspaces/-store/create-matter-store";

// ── Shared menu items ────────────────────────────────────────

type MatterMenuBaseCallbacks = {
  onCreateMatter?: (() => void) | undefined;
  onOpenInNewTab: () => void;
  onRename: () => void;
  onAddMember: () => void;
  onCopyLink: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  isPinned: boolean;
  // Personal matters are creator-only until promoted; the backend
  // rejects member adds with 400, so hide the affordance here.
  isPersonal: boolean;
};

export type MatterMenuCallbacks =
  | (MatterMenuBaseCallbacks & {
      isArchived: true;
      onUnarchive: () => void;
    })
  | (MatterMenuBaseCallbacks & {
      isArchived: false;
      onUnarchive?: never;
    });

/**
 * Renders the canonical set of matter menu items.
 * Used inside both the card context menu and the sidebar menu
 * to guarantee identical actions, icons, and order.
 */
export const MatterMenuItems = (props: MatterMenuCallbacks) => {
  const t = useTranslations();

  return (
    <>
      {props.onCreateMatter && (
        <>
          <MenuItem onClick={props.onCreateMatter}>
            <PlusIcon />
            {t("workspaces.createNewWorkspace")}
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      <MenuItem onClick={props.onOpenInNewTab}>
        <ExternalLinkIcon />
        {t("common.openInNewTab")}
      </MenuItem>
      <MenuItem onClick={props.onRename}>
        <PenLineIcon />
        {t("common.rename")}
      </MenuItem>
      {!props.isPersonal && (
        <MenuItem onClick={props.onAddMember}>
          <UserPlusIcon />
          {t("workspaces.members.addMember")}
        </MenuItem>
      )}
      <MenuItem onClick={props.onCopyLink}>
        <ClipboardCopyIcon />
        {t("common.copyLink")}
      </MenuItem>
      <MenuItem onClick={props.onTogglePin}>
        {props.isPinned ? <PinOffIcon /> : <PinIcon />}
        {props.isPinned ? t("common.unpin") : t("common.pin")}
      </MenuItem>
      <MenuSeparator />
      {props.isArchived && (
        <MenuItem onClick={props.onUnarchive}>
          <ArchiveRestoreIcon />
          {t("workspaces.unarchiveMatter")}
        </MenuItem>
      )}
      <MenuItem onClick={props.onDelete} variant="destructive">
        <Trash2Icon />
        {t("common.delete")}
      </MenuItem>
    </>
  );
};

// ── Rename state ─────────────────────────────────────────────

export type RenameState =
  | { status: "idle" }
  | {
      status: "editing";
      draft: string;
      setDraft: (v: string) => void;
      commit: () => void;
      cancel: () => void;
    };

// ── MatterContextMenu (card wrapper) ─────────────────────────

type MatterContextMenuProps = {
  workspaceId: string;
  workspaceName: string;
  canCreateMatter?: boolean | undefined;
  isArchived?: boolean;
  isPersonal: boolean;
  children: React.ReactNode | ((rename: RenameState) => React.ReactNode);
};

export const MatterContextMenu = ({
  workspaceId,
  workspaceName,
  canCreateMatter = false,
  isArchived = false,
  isPersonal,
  children,
}: MatterContextMenuProps) => {
  const t = useTranslations();
  const { togglePin, isPinned } = usePinnedStore();
  const pinned = isPinned(workspaceId);
  const openCreateMatter = useCreateMatterStore((s) => s.openDialog);

  const queryClient = useQueryClient();
  const updateWorkspace = useUpdateWorkspace();
  const unarchiveWorkspace = useUnarchiveWorkspace();
  const deleteWorkspace = useDeleteWorkspace();

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const [rename, setRename] = useState<
    { status: "idle" } | { status: "editing"; draft: string }
  >({ status: "idle" });
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const commitRename = () => {
    if (rename.status !== "editing") {
      return;
    }

    const trimmed = rename.draft.trim();
    if (trimmed && trimmed !== workspaceName) {
      updateWorkspace.mutate({ workspaceId, name: trimmed });
    }
    setRename({ status: "idle" });
  };

  const cancelRename = () => {
    setRename({ status: "idle" });
  };

  const renameState: RenameState =
    rename.status === "editing"
      ? {
          status: "editing",
          draft: rename.draft,
          setDraft: (draft) => setRename({ status: "editing", draft }),
          commit: commitRename,
          cancel: cancelRename,
        }
      : { status: "idle" };

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/workspaces/${workspaceId}`;
    try {
      await navigator.clipboard.writeText(url);
      stellaToast.add({ title: t("common.copied"), type: "success" });
    } catch {
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    }
  };

  const handleDelete = async () => {
    if (deleteWorkspace.isPending) {
      return;
    }

    const toastId = stellaToast.add({
      title: t("workspaces.deletingWorkspace"),
      type: "loading",
      timeout: Number.POSITIVE_INFINITY,
    });

    await deleteWorkspace.mutateAsync(
      { workspaceId },
      {
        onSuccess: () => {
          stellaToast.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          // eslint-disable-next-line typescript/no-floating-promises
          queryClient.invalidateQueries({
            queryKey: workspacesKeys.all,
          });
        },
        onError: () => {
          stellaToast.update(toastId, {
            title: t("errors.failedToDeleteWorkspace"),
            type: "error",
          });
        },
      },
    );
  };

  const handleUnarchive = () => {
    const onError = () => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    };

    unarchiveWorkspace.mutate({ workspaceId }, { onError });
  };

  const matterMenuCallbacks = {
    isPersonal,
    isPinned: pinned,
    onCreateMatter: canCreateMatter ? () => openCreateMatter() : undefined,
    onAddMember: () => setAddMemberOpen(true),
    onCopyLink: () => {
      void handleCopyLink();
    },
    onDelete: () => setDeleteOpen(true),
    onOpenInNewTab: () => {
      void window.open(`/workspaces/${workspaceId}`, "_blank");
    },
    onRename: () => {
      setRename({ status: "editing", draft: workspaceName });
    },
    onTogglePin: () => togglePin(workspaceId),
  } satisfies MatterMenuBaseCallbacks;

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
          {isArchived ? (
            <MatterMenuItems
              {...matterMenuCallbacks}
              isArchived
              onUnarchive={handleUnarchive}
            />
          ) : (
            <MatterMenuItems {...matterMenuCallbacks} isArchived={false} />
          )}
        </MenuPopup>
      </Menu>

      {addMemberOpen && (
        <AddMemberDialog
          onOpenChange={setAddMemberOpen}
          open={addMemberOpen}
          workspaceId={workspaceId}
        />
      )}
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmation={workspaceName}
        description={t("workspaces.deleteWorkspaceConfirmDescription")}
        inputLabel={t("common.typeNameToConfirm")}
        loading={deleteWorkspace.isPending}
        onConfirm={handleDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("workspaces.deleteWorkspace")}
      />
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
          stellaToast.add({
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
