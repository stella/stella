import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { skillCommandsOptions } from "@/routes/_protected.knowledge/-queries";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

const protectedRouteApi = getRouteApi("/_protected");

/**
 * Returns up to 4 of the most recently created skills with a slash
 * command set. "Saved prompts" is the unified surface's name for the
 * subset of skills the user can fire from the chat composer; the
 * underlying row lives in `agent_skills` after the prompts/skills
 * consolidation. Deterministic order avoids the flicker that random
 * sampling causes across stale→fresh refetches.
 */
export const useSavedPrompts = (): ChatPrompt[] => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data = [] } = useQuery(skillCommandsOptions(activeOrganizationId));

  return useMemo(
    () =>
      data.slice(0, MAX_SUGGESTIONS).flatMap<ChatPrompt>((row) => {
        // Defensive: the server filters for command-bearing rows, but
        // mapping a nullable column needs an explicit narrowing so the
        // ChatPrompt shape can keep `command: string`.
        if (row.command === null) {
          return [];
        }
        return [
          {
            id: row.id,
            scope: row.scope,
            name: row.name,
            command: row.command,
            body: row.body,
          },
        ];
      }),
    [data],
  );
};
