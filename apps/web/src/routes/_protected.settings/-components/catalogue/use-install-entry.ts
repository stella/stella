import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { catalogueKeys } from "@/routes/_protected.settings/-queries/catalogue";

import type { CatalogueEntry } from "./catalogue-types";

/**
 * Installs a catalogue entry by routing to the right backend mutation
 * per kind:
 *   - mcp        → POST /mcp/connectors
 *   - native-tool → PATCH /mcp/native-tools/:slug { enabled: true }
 *   - skill      → POST /catalogue/install-skill
 */
export const useInstallEntry = (organizationId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entry: CatalogueEntry) => {
      if (entry.kind === "native-tool") {
        const response = await api.mcp["native-tools"]({
          slug: entry.backendSlug,
        }).patch({
          enabled: true,
          queryKey: ["mcp"],
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        return response.data;
      }

      if (entry.kind === "mcp") {
        // create-connector auto-discovers authType + iconUrl from
        // probing the URL. The user still needs to connect (provide
        // credentials) from the MCP settings page; install here just
        // adds the connector to their workspace.
        const response = await api.mcp.connectors.post({
          displayName: entry.displayName,
          description: entry.description,
          url: entry.url,
          queryKey: ["mcp"],
        });
        if (response.error) {
          throw toAPIError(response.error);
        }
        return response.data;
      }

      const response = await api.catalogue["install-skill"].post({
        slug: entry.slug,
        queryKey: ["skills"],
      });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: catalogueKeys.list(organizationId),
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
};
