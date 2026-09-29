// Entry point that keeps the `no-direct-lucide-import/no-direct-lucide-import` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-direct-lucide-import" },
  rules: {
    "no-direct-lucide-import": {
      meta: restrictedImportMeta("no-direct-lucide-import"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-direct-lucide-import");
      },
    },
  },
});
