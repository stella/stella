import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import { shortcutsOptions } from "@/routes/_protected.knowledge/-queries";

import type { ChatPrompt } from "./types";

const MAX_SUGGESTIONS = 4;

/**
 * Returns up to 4 of the most recently created shortcuts from the
 * user's saved shortcuts (private + team). Deterministic order avoids
 * the flicker that random sampling causes across stale→fresh refetches.
 */
export const useSavedPrompts = (): ChatPrompt[] => {
  const { data: shortcuts = [] } = useQuery(shortcutsOptions());

  return useMemo(
    () =>
      shortcuts.slice(0, MAX_SUGGESTIONS).map((s) => ({
        id: s.id,
        scope: s.scope,
        name: s.name,
        body: s.prompt,
      })),
    [shortcuts],
  );
};
