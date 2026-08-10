// The three pillars from the repo README ("Data infrastructure", "Legal
// intelligence", "Workspace"). The Product menu, nav ordering, and footer all
// read the slug ordering from here; translated labels live only in the message
// catalog. The ids and slug ordering are the spine.
//
// `slugs` lists which product pages belong to each pillar, in order.

export const pillars = [
  {
    id: "data",
    slugs: ["public-data", "anonymization"],
  },
  {
    id: "intelligence",
    slugs: ["tabular-review", "agent", "templates"],
  },
  {
    id: "workspace",
    slugs: ["workspace", "editor", "cli-mcp"],
  },
] as const;

export type Pillar = (typeof pillars)[number];
export type PillarId = Pillar["id"];

/**
 * Slug of a product page, as listed by the pillars. Menu copy is keyed on it
 * (`nav.products.<slug>.*`), so adding a pillar slug without its catalog
 * entries fails typecheck rather than rendering a raw key.
 */
export type ProductSlug = (typeof pillars)[number]["slugs"][number];
