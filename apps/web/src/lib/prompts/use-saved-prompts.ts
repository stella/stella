import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";

import { shortcutsOptions } from "@/routes/_protected.knowledge/-queries";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

const protectedRouteApi = getRouteApi("/_protected");

/**
 * Returns up to 4 of the most recently created shortcuts from the
 * user's saved shortcuts (private + team). Deterministic order avoids
 * the flicker that random sampling causes across stale→fresh refetches.
 */
export const useSavedPrompts = (): ChatPrompt[] => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: shortcuts = [] } = useQuery(
    shortcutsOptions(activeOrganizationId),
  );

  return useMemo(
    () =>
      shortcuts.slice(0, MAX_SUGGESTIONS).map((s) => ({
        id: s.id,
        scope: s.scope,
        name: s.name,
        command: s.command,
        body: s.prompt,
      })),
    [shortcuts],
  );
};
