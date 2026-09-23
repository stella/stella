// Entry point that keeps the `no-direct-matter-glyph/no-direct-matter-glyph` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-direct-matter-glyph" },
  rules: {
    "no-direct-matter-glyph": {
      meta: restrictedImportMeta("no-direct-matter-glyph"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-direct-matter-glyph");
      },
    },
  },
});
