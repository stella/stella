/** Where the published tools' own pages live (`<base>/<slug>`). */
export type PublicToolsBasePath = "/knowledge/tools" | "/tools";

// Under Knowledge the tools' base is an organization's own page, so the
// published list has an address of its own; the older top-level pages list
// the tools at their base. Free of imports, so the crawl policy and the
// scripts that read it can use it outside the app.
const TOOLS_CATALOGUE_PATH = {
  "/knowledge/tools": "/knowledge/tools/catalogue",
  "/tools": "/tools",
} as const satisfies Record<PublicToolsBasePath, `/${string}`>;

export type PublicToolsCataloguePath =
  (typeof TOOLS_CATALOGUE_PATH)[PublicToolsBasePath];

/** The published tools' list for the tools living under `base`. */
export const toolsCataloguePathOf = <Base extends PublicToolsBasePath>(
  base: Base,
): (typeof TOOLS_CATALOGUE_PATH)[Base] => TOOLS_CATALOGUE_PATH[base];
