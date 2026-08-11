import { useMutation, useQueryClient } from "@tanstack/react-query";

import { installCatalogueEntry } from "@/lib/catalogue-install";
import { detached } from "@/lib/detached";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";
import {
  agentSkillsQueryRoot,
  mcpQueryRoot,
} from "@/lib/resource-query-roots.logic";

import type { CatalogueEntry } from "./catalogue-types";

/**
 * Installs a catalogue entry by routing to the right backend mutation
 * per kind (see `installCatalogueEntry`), then invalidates the affected
 * caches so the catalogue, MCP, and skills views refresh.
 */
export const useInstallEntry = (organizationId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entry: CatalogueEntry) =>
      await installCatalogueEntry(entry),
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: catalogueKeys.list(organizationId),
        }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: mcpQueryRoot() }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: agentSkillsQueryRoot() }),
        "onSuccess",
      );
    },
  });
};
