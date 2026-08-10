import { agent } from "./agent";
import { anonymization } from "./anonymization";
import { cliMcp } from "./cli-mcp";
import { editor } from "./editor";
import type { ProductSlug } from "./pillars";
import { publicData } from "./public-data";
import { tabularReview } from "./tabular-review";
import { templates } from "./templates";
import type { AnyProduct, Product } from "./types";
import { workspace } from "./workspace";

type ProductRegistry = {
  [TSlug in ProductSlug]: Product<TSlug>;
};

// The registry is total over the pillar slugs. Consumers can index it directly,
// so a new pillar cannot silently disappear from a menu or route when its
// product module is missing. Object declaration order is retained for generated
// catalogue and metadata output; menu ordering still comes from pillars.ts.
export const productBySlug = {
  "public-data": publicData,
  anonymization,
  "tabular-review": tabularReview,
  agent,
  templates,
  editor,
  workspace,
  "cli-mcp": cliMcp,
} as const satisfies ProductRegistry;

export const products: readonly AnyProduct[] = Object.values(productBySlug);
