import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

import { CI_GENERATED_FILES } from "./generated-files";

/** Inventory follows canonical catalog and app sources, even on a clean checkout. */
export const ciGeneratedFiles = (root: string) => {
  const catalog = path.join(root, "packages/cli/capabilities");
  const apps = path.join(root, "apps/api/src/mcp/apps");
  const dispatch = existsSync(catalog)
    ? readdirSync(catalog)
        .filter((file) => file.endsWith(".json"))
        .map(
          (file) =>
            `apps/api/src/mcp/generated/capability-dispatch/${file.slice(0, -5)}.ts`,
        )
    : [];
  const bundles = existsSync(apps)
    ? readdirSync(apps)
        .filter((directory) =>
          existsSync(path.join(apps, directory, "app.html")),
        )
        .map(
          (directory) =>
            `apps/api/src/mcp/apps/${directory}/generated/app.html.txt`,
        )
    : [];
  const shared =
    bundles.length === 0
      ? []
      : [
          "messages.json",
          "schemas.json",
          "reader-messages.json",
          "reader-inputs.json",
          "style.css",
          "style.css.d.ts",
        ].map((file) => `apps/api/src/mcp/apps/shared/generated/${file}`);
  return [...CI_GENERATED_FILES, ...dispatch, ...bundles, ...shared];
};
