import { panic } from "better-result";

import type { QueryView } from "@/lib/query-view.logic";

import type { SuggestedSkill, SuggestedSkills } from "./use-suggested-skills";

/**
 * Where the suggestions stand, from the skill pages' read and the
 * suggestions the pages read so far yield. A page can hold only skills the
 * composer does not offer, so while a later page may still supply one,
 * "none" is not known yet; a failed page read settles it, so its error shows
 * instead of the landing waiting forever.
 */
export const suggestedSkillsFrom = ({
  hasNextPage,
  skills,
  view,
}: {
  hasNextPage: boolean;
  skills: readonly SuggestedSkill[];
  view: QueryView<unknown, unknown>;
}): SuggestedSkills => {
  switch (view.type) {
    case "pending":
      return { type: "pending" };
    case "error":
      return { type: "error", feedback: view };
    case "empty":
    case "items": {
      const refetchError =
        view.type === "items" ? view.refetchError : undefined;
      if (skills.length === 0 && hasNextPage && refetchError === undefined) {
        return { type: "pending" };
      }
      return { type: "loaded", feedback: view, skills };
    }
    default:
      view satisfies never;
      return panic("Unhandled suggested skills state");
  }
};
