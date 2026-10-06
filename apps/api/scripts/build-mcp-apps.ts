import "../src/tests/setup-env";
import { Ajv } from "ajv";
import standaloneCode from "ajv/dist/standalone";
import { panic } from "better-result";
import path from "node:path";

import { MCP_APP_OUTPUT_SCHEMAS } from "../src/mcp/app-contracts";
import { MCP_APPS } from "../src/mcp/apps/manifest";
import { defineChatProjectionMcpToolOutput } from "../src/mcp/valibot-tool-definition";
import { buildMcpAppMessages } from "./lib/mcp-app-catalog";

const generatedRoot = path.resolve(
  import.meta.dirname,
  "../src/mcp/apps/shared/generated",
);
await Bun.write(
  path.join(generatedRoot, "messages.json"),
  `${JSON.stringify(await buildMcpAppMessages(), null, 2)}\n`,
);
const schemas = Object.fromEntries(
  Object.entries(MCP_APP_OUTPUT_SCHEMAS).map(([name, schema]) => [
    name,
    defineChatProjectionMcpToolOutput(schema).outputSchema,
  ]),
);
await Bun.write(
  path.join(generatedRoot, "schemas.json"),
  `${JSON.stringify(schemas, null, 2)}\n`,
);
// Hosts forbid eval; compile validators before bundling rather than in the app.
const validator = new Ajv({
  strict: false,
  validateFormats: false,
  code: { source: true, esm: true },
});
for (const [name, schema] of Object.entries(schemas)) {
  validator.addSchema(schema, name);
}
await Bun.write(
  path.join(generatedRoot, "validators.js"),
  standaloneCode(
    validator,
    Object.fromEntries(Object.keys(schemas).map((name) => [name, name])),
  ),
);
await Bun.write(
  path.join(generatedRoot, "validators.d.ts"),
  `import type { ValidateFunction } from "ajv";\n${Object.keys(schemas)
    .map((name) => `export declare const ${name}: ValidateFunction;`)
    .join("\n")}\n`,
);

const MCP_APP_DIRECTORIES = MCP_APPS.map(({ directory }) => directory);
const MCP_APP_INPUTS = ["app.html"] as const;
const EXTERNAL_SCRIPT_PATTERN = /<script\b[^>]*\bsrc\s*=/iu;
const EXTERNAL_STYLESHEET_PATTERN =
  /<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet\b)[^>]*>/iu;

const buildMcpApp = async ({
  directory,
  input,
}: {
  directory: string;
  input: string;
}): Promise<void> => {
  const appRoot = path.resolve(
    import.meta.dirname,
    "../src/mcp/apps",
    directory,
  );
  const app = `${directory}/${input}`;
  const result = await Bun.build({
    compile: true,
    entrypoints: [path.join(appRoot, input)],
    minify: true,
    target: "browser",
  });
  if (!result.success) {
    const messages = result.logs.map(({ message }) => message).join("\n");
    panic(messages || `MCP app build failed for ${app} without a diagnostic`);
  }

  const output = result.outputs.at(0);
  if (result.outputs.length !== 1 || output?.kind !== "entry-point") {
    panic(
      `MCP app build for ${app} emitted ${result.outputs.length} outputs; expected one`,
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
    panic(`MCP app build for ${app} contains an external script or stylesheet`);
  }

  await Bun.write(
    path.join(appRoot, "generated", `${input}.txt`),
    canonicalHtml,
  );
};

await Promise.all(
  MCP_APP_DIRECTORIES.flatMap((directory) =>
    MCP_APP_INPUTS.map(
      async (input) => await buildMcpApp({ directory, input }),
    ),
  ),
);
