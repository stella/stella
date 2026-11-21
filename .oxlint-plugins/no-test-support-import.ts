// Entry point that keeps the `no-test-support-import/no-test-support-import`
// rule id; the table row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-test-support-import" },
  rules: {
    "no-test-support-import": {
      meta: restrictedImportMeta("no-test-support-import"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-test-support-import");
      },
    },
  },
});
