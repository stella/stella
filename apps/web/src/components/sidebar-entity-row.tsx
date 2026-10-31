import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ENTITY_NAME_MAX_LENGTH } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { type EntityAction, EntityActions } from "@stll/ui/entity-actions";
import { PenLineIcon, Trash2Icon } from "@stll/ui/icons";
import { InlineRenameInput } from "@stll/ui/inline-rename";
import { containedEventHandler } from "@stll/ui/use-contained-handler";

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
  const actions: EntityAction[] = [
    ...(canRename
      ? [
          {
            icon: <PenLineIcon />,
            label: t("common.rename"),
            onClick: () => rename.startEditing(),
          },
        ]
      : []),
    ...(canDelete
      ? [
          {
            icon: <Trash2Icon />,
            label: t("common.delete"),
            onClick: () => onDelete(returnFocus.current),
            variant: "destructive" as const,
          },
        ]
      : []),
  ];

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
        <EntityActions actions={actions} label={t("common.actions")}>
          <MatterActivityRow>
            <Button
              data-entity-id={entityId}
              data-entity-kind={entityKind}
              onClick={containedEventHandler(onOpen)}
              ref={returnFocus}
              size="sm"
              variant="ghost"
            >
              {children}
            </Button>
          </MatterActivityRow>
        </EntityActions>
      )}
    </SidebarMenuSubItem>
  );
};
