import type { ProvisionPreview } from "@/api/lib/legal-search/legislation-provision-preview";
import { projectResponseText } from "@/api/lib/search/project-response-text";

import {
  decisionProvisionsSuccessResponseSchema,
  PROVISION_PREVIEW_BLOCKS_MAX,
  PROVISION_PREVIEW_HEADINGS_MAX,
} from "./response-schema";

type KeyedPreview = ProvisionPreview & { key: string };

// The hover card is a preview: tell the caller when its display window ends.
export const projectProvisionPreview = (preview: KeyedPreview) => {
  const schema =
    decisionProvisionsSuccessResponseSchema.properties.previews.items;
  const bounded = projectResponseText(
    {
      ...preview,
      headings: preview.headings.slice(0, PROVISION_PREVIEW_HEADINGS_MAX),
      blocks: preview.blocks.slice(0, PROVISION_PREVIEW_BLOCKS_MAX),
      truncated: false,
    },
    schema,
  );
  bounded.truncated =
    bounded.headings.length !== preview.headings.length ||
    bounded.blocks.length !== preview.blocks.length ||
    bounded.heading?.text !== preview.heading?.text ||
    bounded.headings.some(
      (heading, index) => heading.text !== preview.headings.at(index)?.text,
    ) ||
    bounded.blocks.some(
      (block, index) => block.text !== preview.blocks.at(index)?.text,
    );
  return bounded;
};
