import { isPublicKnowledgeEnabled } from "@/lib/knowledge/public-knowledge-launch";
import { toolsCataloguePathOf } from "@/lib/knowledge/public-tools-catalogue-path";
import type {
  PublicToolsBasePath,
  PublicToolsCataloguePath,
} from "@/lib/knowledge/public-tools-catalogue-path";
import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";

// Every address of the published tools comes from here. They live under
// Knowledge once Knowledge is readable without an account, and at the older
// top-level `/tools` pages until then; nothing redirects between the two.
// This module and the `/tools` routes go once the Knowledge flag is permanent.

type ToolsPathOptions = { publicKnowledge?: boolean };

export type { PublicToolsBasePath, PublicToolsCataloguePath };

export const publicToolsBasePath = ({
  publicKnowledge = isPublicKnowledgeEnabled(),
}: ToolsPathOptions = {}): PublicToolsBasePath =>
  publicKnowledge ? "/knowledge/tools" : "/tools";

/** The published tools' list: `/knowledge/tools` itself is an
 *  organization's own page. */
export const publicToolsCataloguePath = (
  options?: ToolsPathOptions,
): PublicToolsCataloguePath =>
  toolsCataloguePathOf(publicToolsBasePath(options));

export const publicToolPath = (
  slug: string,
  options?: ToolsPathOptions,
): `/${string}` => `${publicToolsBasePath(options)}/${slug}`;

/** The tool's page with the intent to add it, kept through sign-in. */
export const publicToolInstallPath = (
  slug: string,
  options?: ToolsPathOptions,
): `/${string}` => `${publicToolPath(slug, options)}?install=1`;

export const publicToolDownloadPath = (
  slug: string,
  options?: ToolsPathOptions,
): `/${string}` => `${publicToolPath(slug, options)}/download`;

export const isPublicToolDownloadPath = (pathname: string): boolean => {
  const normalized = pathname.replace(/\/$/u, "");
  const slug = normalized.split("/").at(-2);
  if (!slug) {
    return false;
  }
  return (
    normalized === publicToolDownloadPath(slug, { publicKnowledge: false }) ||
    normalized === publicToolDownloadPath(slug, { publicKnowledge: true })
  );
};

export const publicToolsContributePath = (
  options?: ToolsPathOptions,
): `/${string}` => `${publicToolsBasePath(options)}/contribute`;

/** Whether the older top-level `/tools` pages answer at all. */
export const legacyToolsRoutesServed = ({
  publicKnowledge = isPublicKnowledgeEnabled(),
}: ToolsPathOptions = {}): boolean =>
  !publicKnowledge && isPublicToolsRouteEnabled();
