import { panic } from "better-result";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const input = process.env["MCP_APP_INPUT"];
if (input === undefined) {
  panic("MCP_APP_INPUT is required");
}

const appRoot = path.resolve(
  import.meta.dirname,
  "../src/mcp/apps/document-upload",
);

const canonicalizeGeneratedApp = (): Plugin => ({
  name: "stella:mcp-app-canonical-output",
  generateBundle: {
    order: "post",
    handler: (_options, bundle) => {
      for (const output of Object.values(bundle)) {
        if (output.type === "asset" && typeof output.source === "string") {
          output.source = output.source
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n");
          if (output.fileName.endsWith(".html")) {
            // Bun's bundler treats .html imports as HTML entry points even
            // with a text import attribute. A .txt suffix makes the compiled
            // API embed the single-file app as an ordinary string asset.
            output.fileName = `${output.fileName}.txt`;
          }
        }
      }
    },
  },
});

export default defineConfig({
  root: appRoot,
  plugins: [viteSingleFile(), canonicalizeGeneratedApp()],
  build: {
    emptyOutDir: true,
    minify: true,
    outDir: path.join(appRoot, "generated"),
    rolldownOptions: { input: path.join(appRoot, input) },
  },
});
