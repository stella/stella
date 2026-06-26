import type { ComponentType } from "react";

import type { ProductPreviewKey } from "./keys";
import { TabularReviewPreview } from "./TabularReviewPreview";

// Key -> live preview component. A Record (not a switch) makes it exhaustive: a
// new ProductPreviewKey fails typecheck until it is wired here. Rendered by Astro
// without a client directive — static HTML with pure-CSS animation, no JS shipped.
const PREVIEWS: Record<ProductPreviewKey, ComponentType> = {
  "review-grid": TabularReviewPreview,
};

export const ProductPreview = ({
  previewKey,
}: {
  previewKey: ProductPreviewKey;
}) => {
  const Preview = PREVIEWS[previewKey];
  return <Preview />;
};
