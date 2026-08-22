import { panic } from "better-result";
import path from "node:path";

const MCP_APP_INPUTS = ["app.html"] as const;
const EXTERNAL_SCRIPT_PATTERN = /<script\b[^>]*\bsrc\s*=/iu;
const EXTERNAL_STYLESHEET_PATTERN =
  /<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)[^>]*>/iu;

const appRoot = path.resolve(
  import.meta.dirname,
  "../src/mcp/apps/document-upload",
);
await Promise.all(
  MCP_APP_INPUTS.map(async (input) => {
    const result = await Bun.build({
      compile: true,
      entrypoints: [path.join(appRoot, input)],
      minify: true,
      target: "browser",
    });
    if (!result.success) {
      const messages = result.logs.map(({ message }) => message).join("\n");
      panic(
        messages || `MCP app build failed for ${input} without a diagnostic`,
      );
    }

    const output = result.outputs.at(0);
    if (result.outputs.length !== 1 || output?.kind !== "entry-point") {
      panic(
        `MCP app build for ${input} emitted ${result.outputs.length} outputs; expected one`,
      );
    }

    const canonicalHtml = (await output.text())
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n");
    if (
      EXTERNAL_SCRIPT_PATTERN.test(canonicalHtml) ||
      EXTERNAL_STYLESHEET_PATTERN.test(canonicalHtml)
    ) {
      panic(
        `MCP app build for ${input} contains an external script or stylesheet`,
      );
    }

    const outputPath = path.join(appRoot, "generated", `${input}.txt`);
    await Bun.write(outputPath, canonicalHtml);
  }),
);
