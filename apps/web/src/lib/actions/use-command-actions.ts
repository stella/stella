import { useMemo } from "react";

import { useNavigate, useParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { COMMAND_ACTIONS } from "./registry";
import type { CommandAction, CommandActionContext } from "./types";

export type ResolvedCommandAction = {
  title: string;
} & CommandAction

export function useCommandActions(): {
  actions: ResolvedCommandAction[];
  executeAction: (actionId: string) => void;
} {
  const t = useTranslations();
  const navigate = useNavigate();
  const workspaceId = useParams({
    strict: false,
    select: (params) => (params as { workspaceId?: string }).workspaceId,
  });

  const context: CommandActionContext = useMemo(
    () => ({
      navigate: (opts) => {
        navigate(opts);
      },
      workspaceId,
    }),
    [navigate, workspaceId],
  );

  const actions = useMemo(() => 
    COMMAND_ACTIONS.filter((action) => action.isAvailable(context)).map(
      (action) => ({
        id: action.id,
        group: action.group,
        titleKey: action.titleKey,
        icon: action.icon,
        hotkey: action.hotkey,
        isAvailable: action.isAvailable,
        run: action.run,
        title: String(t.raw(action.titleKey as Parameters<typeof t.raw>[0])),
      }),
    )
  , [context, t]);

  const executeAction = (actionId: string) => {
    const action = actions.find((a) => a.id === actionId);
    if (action) {
      action.run(context);
    }
  };

  return { actions, executeAction };
}
