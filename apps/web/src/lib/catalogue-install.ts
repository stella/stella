import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors/api";

/**
 * Minimal per-kind shape needed to install a catalogue entry. Kept
 * narrower than the org-enriched catalogue types so both the protected
 * catalogue browser and the public tools detail page can call one
 * install path: any fuller entry (loaded static bundle or org-enriched)
 * is structurally assignable.
 */
export type InstallableCatalogueEntry =
  | { kind: "native-tool"; backendSlug: string }
  | { kind: "mcp"; displayName: string; description: string; url: string }
  | { kind: "skill"; slug: string };

/**
 * Routes a catalogue install to the right backend mutation per kind:
 *   - native-tool → PATCH /mcp/native-tools/:slug { enabled: true }
 *   - mcp         → POST /mcp/connectors
 *   - skill       → POST /catalogue/install-skill
 * Throws an `APIError` on failure so callers can toast/handle uniformly.
 */
export const installCatalogueEntry = async (
  entry: InstallableCatalogueEntry,
) => {
  if (entry.kind === "native-tool") {
    const response = await api.mcp["native-tools"]({
      slug: entry.backendSlug,
    }).patch({ enabled: true, queryKey: ["mcp"] });
    if (response.error) {
      throw toAPIError(response.error);
    }
    return response.data;
  }

  if (entry.kind === "mcp") {
    // create-connector auto-discovers authType + iconUrl by probing the
    // URL. The user still connects (provides credentials) from the MCP
    // settings page; install here just adds the connector.
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
};
