// Entry point that keeps the `no-nanoid/no-nanoid` rule id; the table row and
// the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-nanoid" },
  rules: {
    "no-nanoid": {
      meta: restrictedImportMeta("no-nanoid"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-nanoid");
      },
    },
  },
});
