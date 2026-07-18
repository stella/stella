import { agent } from "./agent";
import { anonymization } from "./anonymization";
import { cliMcp } from "./cli-mcp";
import { editor } from "./editor";
import { publicData } from "./public-data";
import { tabularReview } from "./tabular-review";
import { templates } from "./templates";
import type { Product } from "./types";
import { workspace } from "./workspace";

// All product pages. Display order in the menu, homepage, and sections is
// driven by pillars.ts (the README spine), not by this list. The [slug].astro
// route and llms-full.txt feed read from here.
export const products: readonly Product[] = [
  publicData,
  anonymization,
  tabularReview,
  agent,
  templates,
  editor,
  workspace,
  cliMcp,
];

export const productBySlug = new Map(products.map((p) => [p.slug, p]));
