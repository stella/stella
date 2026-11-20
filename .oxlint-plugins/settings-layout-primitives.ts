// Entry point that keeps the
// `settings-layout-primitives/settings-layout-primitives` rule id; the table
// row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "settings-layout-primitives" },
  rules: {
    "settings-layout-primitives": {
      meta: restrictedImportMeta("settings-layout-primitives"),
      createOnce(context) {
        return restrictedImportVisitors(context, "settings-layout-primitives");
      },
    },
  },
});
