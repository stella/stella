// Entry point that keeps the
// `retention-source-independence/retention-source-independence` rule id; the
// table row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "retention-source-independence" },
  rules: {
    "retention-source-independence": {
      meta: restrictedImportMeta("retention-source-independence"),
      createOnce(context) {
        return restrictedImportVisitors(
          context,
          "retention-source-independence",
        );
      },
    },
  },
});
