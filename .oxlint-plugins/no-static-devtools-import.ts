// Entry point that keeps the `no-static-devtools-import/no-static-devtools-import` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-static-devtools-import" },
  rules: {
    "no-static-devtools-import": {
      meta: restrictedImportMeta("no-static-devtools-import"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-static-devtools-import");
      },
    },
  },
});
