import { statSync } from "node:fs";
import path from "node:path";

import { MCP_APPS } from "../packages/mcp-apps/src/manifest";
import {
  MCP_APP_DIRECTORY_OUTPUTS,
  MCP_APP_GENERATED_OUTPUTS,
} from "../packages/scripts/src/generated-files";

export const MCP_APP_OUTPUT_PATTERNS = [
  ...MCP_APP_DIRECTORY_OUTPUTS.map(
    (file) => `packages/mcp-apps/src/*/generated/${file}`,
  ),
  ...Object.values(MCP_APP_GENERATED_OUTPUTS).flat(),
];

const EMPTY_APP_CSS = "app.css.txt";

type McpAppOutputFailuresOptions = {
  root: string;
  appDirectories?: readonly string[];
};

export const mcpAppOutputFailures = ({
  root,
  appDirectories = MCP_APPS.map(({ directory }) => directory),
}: McpAppOutputFailuresOptions): string[] => {
  const failures: string[] = [];
  for (const pattern of MCP_APP_OUTPUT_PATTERNS) {
    const files = pattern.includes("/*/")
      ? appDirectories.map((directory) =>
          pattern.replace("/*/", () => `/${directory}/`),
        )
      : [pattern];
    for (const file of files) {
      const stat = statSync(path.join(root, file), { throwIfNoEntry: false });
      if (stat === undefined || !stat.isFile()) {
        failures.push(`${file}: missing generated file`);
      } else if (stat.size === 0 && path.basename(file) !== EMPTY_APP_CSS) {
        failures.push(`${file}: empty generated file`);
      }
    }
  }
  return failures;
};

if (import.meta.main) {
  const failures = mcpAppOutputFailures({
    root: path.resolve(import.meta.dirname, ".."),
  });
  for (const failure of failures) {
    console.error(failure);
  }
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}
