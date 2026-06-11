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
import { resolveMatterColor } from "@/lib/matter-colors";
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

// ── Shared menu header ───────────────────────────────────────

type MatterMenuHeaderProps = {
  id: string;
  name: string;
  /** Client display name, or null for a personal matter. */
  clientName: string | null;
  color: string | null;
};

/**
 * The name + client + colour-bar header shown above the menu items.
 * Rendered in every surface's popup so the menu looks identical
 * everywhere.
 */
export const MatterMenuHeader = ({
  id,
  name,
  clientName,
  color,
}: MatterMenuHeaderProps) => {
  const t = useTranslations();

  return (
    <div
      className="max-w-48 border-s-2 px-2 py-1.5"
      style={{ borderColor: resolveMatterColor(id, color) }}
    >
      <div className="truncate text-xs font-medium">{name}</div>
      <div className="text-muted-foreground truncate text-xs">
        {clientName ?? t("workspaces.parties.personalLabel")}
      </div>
    </div>
  );
};

// ── Shared matter target + actions ───────────────────────────

/** The minimal matter shape every menu surface can produce. */
export type MatterTarget = {
  id: string;
  name: string;
  color: string | null;
  client: { displayName: string } | null;
  isArchived?: boolean;
};

type UseMatterActionsOptions = {
  /** Surface-owned rename trigger (card uses inline edit, sidebar
   *  uses its whole-row inline rename). */
  onRename: () => void;
  /** Called after a successful delete (e.g. navigate away from the
   *  matter that was just deleted). */
  onDeleted?: () => void;
};

type MatterActions = {
  callbacks: MatterMenuCallbacks;
  dialogs: React.ReactNode;
};

/**
 * Owns all matter-menu behaviour (copy link, delete + confirm,
 * unarchive, pin, open-in-new-tab, add member + dialog) so every
 * surface shares one implementation. Rename stays surface-local and
 * is wired through `onRename`.
 */
export const useMatterActions = (
  target: MatterTarget,
  { onRename, onDeleted }: UseMatterActionsOptions,
): MatterActions => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const togglePin = usePinnedStore((s) => s.togglePin);
  const isPinned = usePinnedStore((s) => s.pinnedIds.has(target.id));
  const unarchiveWorkspace = useUnarchiveWorkspace();
  const deleteWorkspace = useDeleteWorkspace();

  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const handleCopyLink = async () => {
    const url = `${window.location.origin}/workspaces/${target.id}`;
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
      { workspaceId: target.id },
      {
        onSuccess: () => {
          stellaToast.update(toastId, {
            title: t("success.workspaceDeletedSuccessfully"),
            type: "success",
          });
          void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
          onDeleted?.();
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
    unarchiveWorkspace.mutate(
      { workspaceId: target.id },
      {
        onError: () => {
          stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
        },
      },
    );
  };

  const base = {
    isPersonal: !target.client,
    isPinned,
    onAddMember: () => setAddMemberOpen(true),
    onCopyLink: () => {
      void handleCopyLink();
    },
    onDelete: () => setDeleteOpen(true),
    onOpenInNewTab: () => {
      void window.open(`/workspaces/${target.id}`, "_blank");
    },
    onRename,
    onTogglePin: () => togglePin(target.id),
  } satisfies MatterMenuBaseCallbacks;

  const callbacks: MatterMenuCallbacks = target.isArchived
    ? { ...base, isArchived: true, onUnarchive: handleUnarchive }
    : { ...base, isArchived: false };

  const dialogs = (
    <>
      {addMemberOpen && (
        <AddMemberDialog
          onOpenChange={setAddMemberOpen}
          open={addMemberOpen}
          workspaceId={target.id}
        />
      )}
      <DestructiveConfirmDialog
        cancelLabel={t("common.cancel")}
        confirmLabel={t("common.delete")}
        confirmation={target.name}
        description={t("workspaces.deleteWorkspaceConfirmDescription")}
        inputLabel={t("common.typeNameToConfirm")}
        loading={deleteWorkspace.isPending}
        onConfirm={handleDelete}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        title={t("workspaces.deleteWorkspace")}
      />
    </>
  );

  return { callbacks, dialogs };
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

// ── useMatterContextMenu (right-click menu primitive) ────────

export type MatterContextMenuChildArgs = {
  rename: RenameState;
  /** True while the right-click menu is open, so the consumer can keep
   *  the source visually highlighted for the duration of the menu. */
  menuOpen: boolean;
};

type MatterContextMenuController = MatterContextMenuChildArgs & {
  /** Attach to the element that should open the menu on right-click. */
  onContextMenu: (e: React.MouseEvent) => void;
  /** The menu itself; render once near the trigger. */
  menu: React.ReactNode;
  /** Rename + delete + add-member dialogs; render once near the trigger. */
  dialogs: React.ReactNode;
};

/**
 * The shared right-click menu for a matter, as a hook. Used directly by
 * surfaces whose trigger element cannot be wrapped in a `<div>` (e.g. a
 * table `<TableRow>`); most surfaces use the `<MatterContextMenu>` wrapper
 * below instead. Both render the exact same header + items + dialogs.
 */
export const useMatterContextMenu = (
  target: MatterTarget,
): MatterContextMenuController => {
  const updateWorkspace = useUpdateWorkspace();

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{
    getBoundingClientRect: () => DOMRect;
  } | null>(null);

  const [rename, setRename] = useState<
    { status: "idle" } | { status: "editing"; draft: string }
  >({ status: "idle" });

  const commitRename = () => {
    if (rename.status !== "editing") {
      return;
    }

    const trimmed = rename.draft.trim();
    if (trimmed && trimmed !== target.name) {
      updateWorkspace.mutate({ workspaceId: target.id, name: trimmed });
    }
    setRename({ status: "idle" });
  };

  const renameState: RenameState =
    rename.status === "editing"
      ? {
          status: "editing",
          draft: rename.draft,
          setDraft: (draft) => setRename({ status: "editing", draft }),
          commit: commitRename,
          cancel: () => setRename({ status: "idle" }),
        }
      : { status: "idle" };

  const { callbacks, dialogs } = useMatterActions(target, {
    // Intentionally no onCreateMatter — right-clicking an existing matter
    // is a matter-scoped action, not a page-level one.
    onRename: () => setRename({ status: "editing", draft: target.name }),
  });

  const menu = (
    <Menu
      onOpenChange={(nextOpen) => {
        setMenuOpen(nextOpen);
        if (!nextOpen) {
          setMenuAnchor(null);
        }
      }}
      open={menuOpen}
    >
      <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />
      <MenuPopup anchor={menuAnchor ?? undefined} className="z-50">
        <MatterMenuHeader
          clientName={target.client?.displayName ?? null}
          color={target.color}
          id={target.id}
          name={target.name}
        />
        <MenuSeparator />
        <MatterMenuItems {...callbacks} />
      </MenuPopup>
    </Menu>
  );

  return {
    menu,
    dialogs,
    menuOpen,
    rename: renameState,
    onContextMenu: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x = e.clientX;
      const y = e.clientY;
      setMenuAnchor({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) });
      setMenuOpen(true);
    },
  };
};

// ── MatterContextMenu (wrapper) ──────────────────────────────

type MatterContextMenuProps = {
  target: MatterTarget;
  className?: string;
  children:
    | React.ReactNode
    | ((args: MatterContextMenuChildArgs) => React.ReactNode);
};

export const MatterContextMenu = ({
  target,
  className,
  children,
}: MatterContextMenuProps) => {
  const { onContextMenu, menu, dialogs, rename, menuOpen } =
    useMatterContextMenu(target);

  return (
    <div className={className} onContextMenu={onContextMenu}>
      {typeof children === "function"
        ? children({ rename, menuOpen })
        : children}
      {menu}
      {dialogs}
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
          void queryClient.invalidateQueries({
            queryKey: workspaceMembersKeys.all(workspaceId),
          });
          void queryClient.invalidateQueries({ queryKey: workspacesKeys.all });
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
