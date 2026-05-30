/**
 * Text-box feature module — renders `TextBoxFragment`.
 */

import { renderTextBoxFragment } from "../../renderTextBox";
import type { FeatureModule } from "../types";

export const textBoxModule: FeatureModule<"textBox"> = {
  kind: "textBox",
  render({ fragment, block, measure, context, doc }) {
    return renderTextBoxFragment(fragment, block, measure, context, {
      document: doc,
    });
  },
};
