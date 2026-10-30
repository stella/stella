import type { MenuFeaturePreviewScene } from "../../components/react/MenuFeaturePreview";
import type { ProductSlug } from "./pillars";

// Which Product-menu panes draw a live feature preview (composed from the
// app's components) instead of the product's hero capture. `null` keeps the
// hero thumbnail; a total map, so a new product page needs a decision here.
export const MENU_FEATURE_PREVIEWS = {
  "public-data": "research",
  anonymization: null,
  "tabular-review": null,
  agent: null,
  templates: null,
  workspace: "matters",
  editor: "documents",
  "cli-mcp": null,
} as const satisfies Record<ProductSlug, MenuFeaturePreviewScene | null>;
