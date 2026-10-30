// Entry point that keeps the `retention-oracle-owner/retention-oracle-owner`
// rule id; the table row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "retention-oracle-owner" },
  rules: {
    "retention-oracle-owner": {
      meta: restrictedImportMeta("retention-oracle-owner"),
      createOnce(context) {
        return restrictedImportVisitors(context, "retention-oracle-owner");
      },
    },
  },
});
