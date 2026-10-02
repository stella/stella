// Entry point that keeps the `confine-server-reads/confine-server-reads` rule
// id; the table row and detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "confine-server-reads" },
  rules: {
    "confine-server-reads": {
      meta: restrictedImportMeta("confine-server-reads"),
      createOnce(context) {
        return restrictedImportVisitors(context, "confine-server-reads");
      },
    },
  },
});
