// The three pillars from the repo README ("Data infrastructure", "Legal
// intelligence", "Workspace"). The Product menu, nav ordering, and footer all
// read the labels and slug ordering from here, so the landing can't drift
// from the README's structure.
//
// `slugs` lists which product pages belong to each pillar, in order.

export type PillarId = "data" | "intelligence" | "workspace";

export type Pillar = {
  id: PillarId;
  label: string;
  slugs: readonly string[];
};

export const pillars: readonly Pillar[] = [
  {
    id: "data",
    label: "Data infrastructure",
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
] as const;
