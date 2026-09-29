import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import {
  catalogueKeys,
  catalogueOptions,
} from "@/lib/knowledge/queries/catalogue";

/** The organization's view of the tools catalogue, with its install state. */
const useToolsCatalogue = (organizationId: string) => {
  const { id: userId } = useAuthenticatedUser();
  return useSuspenseQuery(catalogueOptions(organizationId, userId));
};

/** Reads of the organization's tools. */
export const memberToolsSource = {
  useToolsCatalogue,
};

/**
 * Refreshes after a tool changes outside the catalogue's own install and
 * remove calls (a new custom skill, a connected server).
 */
const useToolsActions = (organizationId: string) => {
  const queryClient = useQueryClient();

  const invalidateCatalogue = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: catalogueKeys.all(organizationId),
      }),
      "knowledge-tools.invalidate",
    );
  };

  return {
    invalidateCatalogue,
    invalidateSkillsAndCatalogue: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.skills.all(organizationId),
        }),
        "catalogue-browser.invalidate",
      );
      invalidateCatalogue();
    },
  };
};

/** Writes to the organization's tools. Install and remove live in their own
 *  row hooks, beside the rows that show their progress. */
export const memberToolsActions = {
  useToolsActions,
};
