import { Result, TaggedError } from "better-result";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { type McpAppDirectory, mcpAppBundlePath } from "./bundle-paths";

export {
  MCP_APP_BUNDLE_PATHS,
  mcpAppBundlePath,
  type McpAppDirectory,
} from "./bundle-paths";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

export class McpAppBundleReadError extends TaggedError(
  "McpAppBundleReadError",
)<{
  directory: McpAppDirectory;
  message: string;
  cause: unknown;
}> {}

export const readMcpAppBundle = async (
  directory: McpAppDirectory,
  root = repositoryRoot,
) => {
  const result = await Result.tryPromise({
    try: async () => {
      // Compiled API binaries embed the text imports; source consumers read the
      // same files without eagerly loading missing build output at import time.
      if (
        root === repositoryRoot &&
        import.meta.dirname.startsWith("/$bunfs/")
      ) {
        const { MCP_APP_BUNDLES } = await import("./embedded-bundles");
        return MCP_APP_BUNDLES[directory];
      }
      return readFile(mcpAppBundlePath(directory, root), "utf-8");
    },
    catch: (cause) =>
      new McpAppBundleReadError({
        directory,
        cause,
        message: `Cannot read MCP app bundle ${directory}. Run bun --filter @stll/mcp-apps build.`,
      }),
  });
  if (result.isErr()) {
    throw result.error;
  }
  return result.value;
};
