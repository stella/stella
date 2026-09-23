// Entry point that keeps the `no-raw-use-effect/no-raw-use-effect` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-raw-use-effect" },
  rules: {
    "no-raw-use-effect": {
      meta: restrictedImportMeta("no-raw-use-effect"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-raw-use-effect");
      },
    },
  },
});
