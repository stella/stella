// The three pillars from the repo README ("Data infrastructure", "Legal
// intelligence", "Workspace"). This is the single source the Product menu,
// the homepage cards, and the below-fold sections all read from, so the
// landing can't drift from the README's structure.
//
// `slugs` lists which product pages belong to each pillar, in order.

export type PillarId = "data" | "intelligence" | "workspace";

export type Pillar = {
  id: PillarId;
  label: string;
  blurb: string;
  slugs: readonly string[];
};

export const pillars: readonly Pillar[] = [
  {
    id: "data",
    label: "Data infrastructure",
    blurb:
      "The legal data stack: official case law and company registries you can pull into a matter, plus anonymization for sensitive material.",
    slugs: ["public-data", "anonymization"],
  },
  {
    id: "intelligence",
    label: "Legal intelligence",
    blurb:
      "AI over the matter: review document sets, draft from templates, and an agent that works across your files and sources, grounded by citations.",
    slugs: ["tabular-review", "agent", "templates"],
  },
  {
    id: "workspace",
    label: "Workspace",
    blurb:
      "Where the work lives: matters, documents, Word editing, and the desktop and MCP surfaces that connect them.",
    slugs: ["workspace"],
  },
] as const;
