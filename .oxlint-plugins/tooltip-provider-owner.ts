// Entry point that keeps the `tooltip-provider-owner/tooltip-provider-owner`
// rule id; the table row and detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "tooltip-provider-owner" },
  rules: {
    "tooltip-provider-owner": {
      meta: restrictedImportMeta("tooltip-provider-owner"),
      createOnce(context) {
        return restrictedImportVisitors(context, "tooltip-provider-owner");
      },
    },
  },
});
