// Entry point that keeps the `require-oauth-grant-admission/require-oauth-grant-admission` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "require-oauth-grant-admission" },
  rules: {
    "require-oauth-grant-admission": {
      meta: restrictedImportMeta("require-oauth-grant-admission"),
      createOnce(context) {
        return restrictedImportVisitors(
          context,
          "require-oauth-grant-admission",
        );
      },
    },
  },
});
