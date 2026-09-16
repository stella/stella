import { useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { TaskStatus } from "@stll/api-contract";
import { UserText } from "@stll/ui/bidi-text";
import { KanbanCellAction } from "@stll/ui/kanban";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type NewEntityViewTaskProps = {
  organizationId: string;
  workspaceId: string | null;
  status: TaskStatus;
  agendaKind?: "task" | "deadline";
  assigneeUserId?: string | null | undefined;
  onChanged: () => Promise<void>;
};

export const NewEntityViewTask = ({
  organizationId,
  workspaceId,
  status,
  onChanged,
  agendaKind = "task",
  assigneeUserId,
}: NewEntityViewTaskProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const canCreate = usePermissions({ entity: ["create"] });
  const { data } = useQuery(workspacesNavigationOptions(organizationId));
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const create = async (selectedWorkspaceId: string) => {
    if (pendingRef.current) {
      return;
    }
    pendingRef.current = true;
    setPending(true);
    const result = await Result.tryPromise(async () =>
      unwrapEden(
        await api
          .tasks({ workspaceId: toSafeId<"workspace">(selectedWorkspaceId) })
          .put({
            name: t("tasks.untitled"),
            status,
            agendaKind,
            ...(assigneeUserId === undefined
              ? {}
              : {
                  assigneeIds:
                    assigneeUserId === null
                      ? []
                      : [toSafeId<"user">(assigneeUserId)],
                }),
          }),
      ),
    );
    if (result.isErr()) {
      analytics.captureError(result.error);
      stellaToast.error(
        userErrorFromThrown(result.error, t("common.unexpectedError")),
      );
    } else {
      await Promise.all([
        onChanged(),
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(selectedWorkspaceId),
        }),
      ]);
      useInspectorTabsStore.getState().openTask({
        taskId: result.value.entityId,
        workspaceId: selectedWorkspaceId,
        isNew: true,
      });
    }
    pendingRef.current = false;
    setPending(false);
  };
  if (!canCreate) {
    return null;
  }
  if (workspaceId) {
    return (
      <KanbanCellAction
        disabled={pending}
        onClick={() => detached(create(workspaceId), "entity-view.create-task")}
      >
        {t(
          agendaKind === "deadline"
            ? "inbox.suggestion.createDeadline"
            : "tasks.newTask",
        )}
      </KanbanCellAction>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <KanbanCellAction
            disabled={
              pending || data === undefined || data.workspaces.length === 0
            }
          />
        }
      >
        {t(
          agendaKind === "deadline"
            ? "inbox.suggestion.createDeadline"
            : "tasks.newTask",
        )}
      </MenuTrigger>
      <MenuPopup>
        {data?.workspaces.map((workspace) => (
          <MenuItem
            key={workspace.id}
            onClick={() =>
              detached(create(workspace.id), "entity-view.create-task")
            }
          >
            <UserText>{workspace.name}</UserText>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
};
