import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";

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
        return unwrapEden(response);
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
        return unwrapEden(response);
      }

      const response = await api.catalogue["install-skill"].post({
        slug: entry.slug,
        queryKey: ["skills"],
      });
      return unwrapEden(response);
    },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: catalogueKeys.list(organizationId),
        }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: ["mcp"] }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        "onSuccess",
      );
    },
  });
};
