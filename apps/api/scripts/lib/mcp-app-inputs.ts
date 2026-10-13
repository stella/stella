import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone";
import { panic } from "better-result";
import path from "node:path";

import { MCP_APPS } from "../../src/mcp/apps/manifest";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "../../src/mcp/static-tool-definitions";

export const generateMcpAppInputs = async (generatedRoot: string) => {
  const tools = [
    ...new Set(
      MCP_APPS.filter((app) => app.type === "presentation").flatMap(
        (app) => app.callableTools,
      ),
    ),
  ];
  const schemas = Object.fromEntries(
    tools.map((name) => {
      const definition =
        DEFAULT_MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name) ??
        panic(`Missing app input contract: ${name}`);
      return [name, definition.inputSchema];
    }),
  );
  // Runtime compilation requires eval, which the embedded-app CSP prohibits.
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    code: { source: true, esm: true },
  });
  addFormats(ajv);
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(schema, name);
  }
  await Bun.write(
    path.join(generatedRoot, "input-schemas.json"),
    `${JSON.stringify(schemas, null, 2)}\n`,
  );
  await Bun.write(
    path.join(generatedRoot, "input-validators.js"),
    `${standaloneCode(ajv, Object.fromEntries(tools.map((name) => [name, name])))}\nexport default { ${tools.join(", ")} };\n`,
  );
  await Bun.write(
    path.join(generatedRoot, "input-validators.d.ts"),
    `// Generated from declared MCP tool input schemas.\ntype InputValidator = ((input: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; params: Record<string, unknown> }[] | null };\ndeclare const validators: Record<${tools.map((name) => JSON.stringify(name)).join(" | ")}, InputValidator>;\nexport default validators;\n`,
  );
};
