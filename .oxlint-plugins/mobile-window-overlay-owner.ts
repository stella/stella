// Entry point that keeps the `mobile-window-overlay-owner` rule id; the table
// row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "mobile-window-overlay-owner" },
  rules: {
    "mobile-window-overlay-owner": {
      meta: restrictedImportMeta("mobile-window-overlay-owner"),
      createOnce(context) {
        return restrictedImportVisitors(context, "mobile-window-overlay-owner");
      },
    },
  },
});
