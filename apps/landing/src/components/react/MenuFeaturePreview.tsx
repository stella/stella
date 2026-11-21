import { panic } from "better-result";

import {
  DocumentsPreview,
  MattersPreview,
  ResearchPreview,
} from "@stll/workspace-ui/feature-previews";
import type {
  DocumentsPreviewLabels,
  MattersPreviewLabels,
  ResearchPreviewLabels,
} from "@stll/workspace-ui/feature-previews";

/** Interface labels for every scene the Product menu can draw, resolved from
 *  the landing catalog by the caller. */
export type MenuFeaturePreviewLabels = {
  matters: MattersPreviewLabels;
  documents: DocumentsPreviewLabels;
  research: ResearchPreviewLabels;
};

export type MenuFeaturePreviewScene = keyof MenuFeaturePreviewLabels;

type MenuFeaturePreviewProps = {
  scene: MenuFeaturePreviewScene;
  labels: MenuFeaturePreviewLabels;
  locale: string;
};

// A product scene composed from the app's own components
// (`@stll/workspace-ui/feature-previews`). Rendered by Astro without a client
// directive: static HTML styled by the landing's Tailwind build, no JS shipped.
export const MenuFeaturePreview = ({
  scene,
  labels,
  locale,
}: MenuFeaturePreviewProps) => {
  switch (scene) {
    case "matters":
      return <MattersPreview labels={labels.matters} locale={locale} />;
    case "documents":
      return <DocumentsPreview labels={labels.documents} locale={locale} />;
    case "research":
      return <ResearchPreview labels={labels.research} locale={locale} />;
    default: {
      scene satisfies never;
      return panic(`Unhandled menu preview scene: ${String(scene)}`);
    }
  }
};
