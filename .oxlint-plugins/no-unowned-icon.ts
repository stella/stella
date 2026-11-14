// Entry point that keeps the `no-unowned-icon/no-unowned-icon` rule id; the
// detector lives in ./restricted-import.ts, and its rows are read from the
// `ownedBy:` lines of packages/ui/src/icons.ts (./icon-ownership.ts).

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-unowned-icon" },
  rules: {
    "no-unowned-icon": {
      meta: restrictedImportMeta("no-unowned-icon"),
      createOnce(context) {
        return restrictedImportVisitors(context, "no-unowned-icon");
      },
    },
  },
});
