// Entry point that keeps the `no-direct-streamdown-import/no-direct-streamdown-import`
// rule id; the table row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-direct-streamdown-import" },
  rules: {
    "no-direct-streamdown-import": {
      meta: restrictedImportMeta("no-direct-streamdown-import"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-direct-streamdown-import");
      },
    },
  },
});
