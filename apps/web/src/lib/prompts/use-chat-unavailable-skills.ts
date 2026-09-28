import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";

import type { UnavailableSkillIds } from "@/components/chat-editor-slash-items";
import { chatUnavailableSkillsOptions } from "@/lib/knowledge/queries";

/**
 * The skills chat cannot offer the caller, keyed by id, with the tools each
 * lacks. Menus leave these out; the tools page says why. Empty until the
 * server answers and when there is no organization.
 */
export const useChatUnavailableSkills = (
  organizationId: string | undefined,
): ReadonlyMap<string, readonly string[]> => {
  const { data } = useQuery({
    ...chatUnavailableSkillsOptions(organizationId ?? ""),
    enabled: organizationId !== undefined,
  });
  return useMemo(
    () =>
      new Map(
        data === undefined
          ? []
          : data.map(({ missingTools, skillId }) => [skillId, missingTools]),
      ),
    [data],
  );
};

/** The ids of {@link useChatUnavailableSkills}, as the slash menus take them. */
export const useChatUnavailableSkillIds = (
  organizationId: string | undefined,
): UnavailableSkillIds => {
  const unavailable = useChatUnavailableSkills(organizationId);
  return useMemo(() => new Set(unavailable.keys()), [unavailable]);
};
