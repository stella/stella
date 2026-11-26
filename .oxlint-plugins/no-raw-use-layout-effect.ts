// Entry point that keeps the `no-raw-use-layout-effect/no-raw-use-layout-effect`
// rule id; the table row and the detector live in ./restricted-import.ts.

import { eslintCompatPlugin } from "@oxlint/plugins";

import {
  restrictedImportMeta,
  restrictedImportVisitors,
} from "./restricted-import.ts";

export default eslintCompatPlugin({
  meta: { name: "no-raw-use-layout-effect" },
  rules: {
    "no-raw-use-layout-effect": {
      meta: restrictedImportMeta("no-raw-use-layout-effect"),
      createOnce(context) {
        // First-week rollout: only lines a change touched
        // (scripts/guard-rollouts/no-raw-use-layout-effect.json).
        return restrictedImportVisitors(context, "no-raw-use-layout-effect", {
          rollout: "no-raw-use-layout-effect",
        });
      },
    },
  },
});
