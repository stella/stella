/**
 * Table feature module — wraps `renderTableFragment`.
 *
 * Like paragraph, the table orchestrator still owns row/cell rendering.
 * Splitting cell-level renderers into a sub-registry is future work.
 */

import { renderTableFragment } from "../../renderTable";
import type { FeatureModule } from "../types";

export const tableModule: FeatureModule<"table"> = {
  kind: "table",
  render({ fragment, block, measure, context, doc }) {
    return renderTableFragment(fragment, block, measure, context, {
      document: doc,
    });
  },
};
