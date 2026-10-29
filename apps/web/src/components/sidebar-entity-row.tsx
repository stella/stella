import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ENTITY_NAME_MAX_LENGTH } from "@stll/api-contract";
import { PenLineIcon, Trash2Icon } from "@stll/ui/icons";
import { InlineRenameInput } from "@stll/ui/inline-rename";
import { MenuItem } from "@stll/ui/menu";
import { containedEventHandler } from "@stll/ui/use-contained-handler";

import { contextMenuBelongsTo } from "@/components/context-menu-target";
import { useAnchoredMenu } from "@/components/inspector/use-anchored-menu";
import { MatterActivityRow } from "@/components/matter-activity-row";
import { SidebarMenuSubItem } from "@/components/sidebar";
import { useInlineRename } from "@/hooks/use-inline-rename";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { useRenameEntityForUser } from "@/lib/workspaces/mutations/entities";

type SidebarEntityRowProps = {
  activeOrganizationId: string;
  children: ReactNode;
  entityId: string;
  entityKind: string;
  onDelete: (opener: HTMLElement | null) => void;
  name: string;
  onOpen: () => void;
  workspaceId: string;
  userId: string;
};

/** Activity summaries have identity, but no full row or file-cell payload. */
export const SidebarEntityRow = ({
  activeOrganizationId,
  children,
  entityId,
  entityKind,
  onDelete,
  name,
  onOpen,
  workspaceId,
  userId,
}: SidebarEntityRowProps) => {
  const t = useTranslations();
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const renameEntity = useRenameEntityForUser({
    activeOrganizationId,
    inspectorStore: undefined,
    userId,
  });
  const canRename = usePermissions({ entity: ["update"] });
  const canDelete = usePermissions({ entity: ["delete"] });
  const rename = useInlineRename({
    initial: name,
    onCommit: (nextName, { setError }) => {
      renameEntity.mutate(
        { entityId, name: nextName, workspaceId },
        { onError: () => setError(t("errors.actionFailed")) },
      );
    },
  });
  const menu = useAnchoredMenu({
    returnFocus,
    children: (
      <>
        {canRename && (
          <MenuItem onClick={() => rename.startEditing()}>
            <PenLineIcon />
            {t("common.rename")}
          </MenuItem>
        )}
        {canDelete && (
          <MenuItem
            onClick={() => onDelete(returnFocus.current)}
            variant="destructive"
          >
            <Trash2Icon />
            {t("common.delete")}
          </MenuItem>
        )}
      </>
    ),
  });

  return (
    <SidebarMenuSubItem data-context-menu-target={entityId}>
      {rename.state.mode === "edit" ? (
        <div className="flex h-7 items-center px-2">
          <InlineRenameInput
            aria-invalid={rename.state.error !== undefined}
            maxLength={ENTITY_NAME_MAX_LENGTH}
            onCancel={rename.cancel}
            onCommit={() =>
              detached(rename.commit(), "sidebar-entity-row.rename")
            }
            onValueChange={rename.setDraft}
            value={rename.state.draft}
          />
          {rename.state.error && <span role="alert">{rename.state.error}</span>}
        </div>
      ) : (
        <MatterActivityRow>
          <button
            data-entity-id={entityId}
            data-entity-kind={entityKind}
            onClick={containedEventHandler(onOpen)}
            onContextMenu={containedEventHandler((event) => {
              if (
                !contextMenuBelongsTo(event, { id: entityId, kind: entityKind })
              ) {
                return;
              }
              if (canRename || canDelete) {
                menu.openAt(event);
              }
            })}
            onKeyDown={canRename || canDelete ? menu.onKeyDown : undefined}
            ref={returnFocus}
            type="button"
          >
            {children}
          </button>
        </MatterActivityRow>
      )}
      {menu.element}
    </SidebarMenuSubItem>
  );
};
