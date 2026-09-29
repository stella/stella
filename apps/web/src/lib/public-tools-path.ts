import { isPublicKnowledgeEnabled } from "@/lib/public-knowledge-launch";
import { isPublicToolsRouteEnabled } from "@/lib/public-tools-launch";

// Every address of the published tools comes from here. They live under
// Knowledge once Knowledge is readable without an account, and at the older
// top-level `/tools` pages until then; nothing redirects between the two.
// This module and the `/tools` routes go once the Knowledge flag is permanent.

type ToolsPathOptions = { publicKnowledge?: boolean };

export type PublicToolsBasePath = "/knowledge/tools" | "/tools";

export const publicToolsBasePath = ({
  publicKnowledge = isPublicKnowledgeEnabled(),
}: ToolsPathOptions = {}): PublicToolsBasePath =>
  publicKnowledge ? "/knowledge/tools" : "/tools";

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

export const publicToolsContributePath = (
  options?: ToolsPathOptions,
): `/${string}` => `${publicToolsBasePath(options)}/contribute`;

/** Whether the older top-level `/tools` pages answer at all. */
export const legacyToolsRoutesServed = ({
  publicKnowledge = isPublicKnowledgeEnabled(),
}: ToolsPathOptions = {}): boolean =>
  !publicKnowledge && isPublicToolsRouteEnabled();
