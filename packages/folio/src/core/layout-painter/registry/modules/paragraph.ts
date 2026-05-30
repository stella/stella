/**
 * Paragraph feature module — wraps `renderParagraphFragment`.
 *
 * The paragraph orchestrator is intentionally still monolithic: it dispatches
 * paragraph-internal kinds (runs, fields, inline images, hyperlinks). Future
 * work can split that into a sub-registry without changing this module's
 * external contract.
 */

import { renderParagraphFragment } from "../../renderParagraph";
import type { FeatureModule } from "../types";

export const paragraphModule: FeatureModule<"paragraph"> = {
  kind: "paragraph",
  render({ fragment, block, measure, context, doc }) {
    return renderParagraphFragment(fragment, block, measure, context, {
      document: doc,
    });
  },
};
