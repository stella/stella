import { useMutation, useQueryClient } from "@tanstack/react-query";

import { installCatalogueEntry } from "@/lib/catalogue-install";
import { detached } from "@/lib/detached";
import type { CatalogueDisplayEntry } from "@/lib/knowledge/catalogue-types";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";
import {
  agentSkillsQueryRoot,
  mcpQueryRoot,
} from "@/lib/resource-query-roots.logic";

/**
 * Installs a catalogue entry by routing to the right backend mutation
 * per kind (see `installCatalogueEntry`), then invalidates the affected
 * caches so the catalogue, MCP, and skills views refresh.
 */
export const useInstallEntry = (organizationId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entry: CatalogueDisplayEntry) =>
      await installCatalogueEntry(entry),
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: catalogueKeys.all(organizationId),
        }),
        "use-install-entry.invalidate",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: mcpQueryRoot() }),
        "use-install-entry.invalidate",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: agentSkillsQueryRoot() }),
        "use-install-entry.invalidate",
      );
    },
  });
};
