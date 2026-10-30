import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  CI_GENERATED_FILES,
  MCP_APP_DIRECTORY_OUTPUTS,
  MCP_APP_GENERATED_OUTPUTS,
} from "./generated-files";

type GeneratedInventoryOptions = { generatedRoot?: string };

// The dispatch aggregator names its complete module set. Restores read it from
// the artifact before any output exists in the destination checkout.
export const ciGeneratedFiles = (
  root: string,
  { generatedRoot = root }: GeneratedInventoryOptions = {},
) => {
  const aggregator = path.join(
    generatedRoot,
    "apps/api/src/mcp/generated/capability-dispatch.ts",
  );
  const apps = path.join(root, "packages/mcp-apps/src");
  const dispatch = existsSync(aggregator)
    ? [
        ...readFileSync(aggregator, "utf-8").matchAll(
          /from "\.\/capability-dispatch\/([a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+)"/gu,
        ),
      ].map(
        (match) =>
          `apps/api/src/mcp/generated/capability-dispatch/${match[1]}.ts`,
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
