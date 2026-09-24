// Entry point that keeps the `no-direct-entity-glyph/no-direct-entity-glyph` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-direct-entity-glyph" },
  rules: {
    "no-direct-entity-glyph": {
      meta: restrictedImportMeta("no-direct-entity-glyph"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-direct-entity-glyph");
      },
    },
  },
});
