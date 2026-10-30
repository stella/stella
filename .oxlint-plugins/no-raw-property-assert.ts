// Restrict the runner export at its binding, including default/namespace
// member reads, aliases, destructuring and re-exports. Dynamic property names
// and values passed through arbitrary functions are outside syntax analysis.
import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-raw-property-assert" },
  rules: {
    "no-raw-property-assert": {
      meta: restrictedImportMeta("no-raw-property-assert"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-raw-property-assert");
      },
    },
  },
});
