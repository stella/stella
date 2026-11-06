import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  CI_GENERATED_FILES,
  MCP_APP_DIRECTORY_OUTPUTS,
  MCP_APP_GENERATED_OUTPUTS,
} from "./generated-files";

// Discover outputs from committed inputs so clean checkouts have the same inventory.
export const ciGeneratedFiles = (root: string) => {
  const catalog = path.join(root, "packages/cli/capabilities");
  const apps = path.join(root, "packages/mcp-apps/src");
  const dispatch = existsSync(catalog)
    ? readdirSync(catalog)
        .filter((file) => file.endsWith(".json"))
        .map(
          (file) =>
            `apps/api/src/mcp/generated/capability-dispatch/${file.slice(0, -5)}.ts`,
        )
    : [];
  const bundles = existsSync(apps)
    ? readdirSync(apps, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isDirectory() &&
            existsSync(path.join(apps, entry.name, "app.html")),
        )
        .flatMap(({ name }) =>
          MCP_APP_DIRECTORY_OUTPUTS.map(
            (file) => `packages/mcp-apps/src/${name}/generated/${file}`,
          ),
        )
    : [];
  const shared = existsSync(apps)
    ? Object.values(MCP_APP_GENERATED_OUTPUTS).flat()
    : [];
  return [
    ...new Set([...CI_GENERATED_FILES, ...dispatch, ...bundles, ...shared]),
  ].toSorted();
};
