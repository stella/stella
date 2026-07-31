// The three pillars from the repo README ("Data infrastructure", "Legal
// intelligence", "Workspace"). The Product menu, nav ordering, and footer all
// read the labels and slug ordering from here, so the landing can't drift
// from the README's structure. The menu labels are shorter than the README's
// section names where the longer form reads as jargon on a marketing surface
// ("Data", not "Data infrastructure"); the ids and slug ordering are the spine.
//
// `slugs` lists which product pages belong to each pillar, in order.

export type PillarId = "data" | "intelligence" | "workspace";

export type Pillar = {
  id: PillarId;
  /**
   * English source of the group label. The mega-menu renders the localized
   * `nav.pillars.<id>` catalog value instead; menu-copy.test.ts asserts the two
   * English sources agree, the same way it does for `nav.products.<slug>.*`.
   */
  label: string;
  slugs: readonly string[];
};

// `as const satisfies`, not a `: readonly Pillar[]` annotation: the annotation
// widens every slug to `string`, and `ProductSlug` below needs the literals so
// the mega-menu's per-slug message keys are checked against the catalog.
export const pillars = [
  {
    id: "data",
    label: "Data",
    slugs: ["public-data", "anonymization"],
  },
  {
    id: "intelligence",
    label: "Legal intelligence",
    slugs: ["tabular-review", "agent", "templates"],
  },
  {
    id: "workspace",
    label: "Workspace",
    slugs: ["workspace", "editor", "cli-mcp"],
  },
] as const satisfies readonly Pillar[];

/**
 * Slug of a product page, as listed by the pillars. Menu copy is keyed on it
 * (`nav.products.<slug>.*`), so adding a pillar slug without its catalog
 * entries fails typecheck rather than rendering a raw key.
 */
export type ProductSlug = (typeof pillars)[number]["slugs"][number];
