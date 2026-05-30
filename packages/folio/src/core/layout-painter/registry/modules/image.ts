/**
 * Image feature module — renders `ImageFragment`.
 *
 * Thin wrapper over `renderImageFragment`. Kept as a module so the
 * registry can dispatch image fragments uniformly and so future
 * variants (e.g. SVG, EMF preview) can plug in alongside.
 */

import { renderImageFragment } from "../../renderImage";
import type { FeatureModule } from "../types";

export const imageModule: FeatureModule<"image"> = {
  kind: "image",
  render({ fragment, block, measure, context, doc }) {
    return renderImageFragment(fragment, block, measure, context, {
      document: doc,
    });
  },
};
