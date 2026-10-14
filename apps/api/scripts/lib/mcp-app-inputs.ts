import Ajv from "ajv";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone";
import { panic } from "better-result";
import path from "node:path";

import { AGENT_INPUT_NORMALIZATION_KEY } from "@stll/agent-input";
import { MCP_APPS } from "@stll/mcp-apps/manifest";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "../../src/mcp/static-tool-definitions";

type SchemaPurpose = "normalization" | "validation";

const appSchemaValue = (value: unknown, purpose: SchemaPurpose): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => appSchemaValue(entry, purpose));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (
        key === "description" ||
        (key.startsWith("x-stella-") &&
          (purpose === "validation" || key !== AGENT_INPUT_NORMALIZATION_KEY))
      ) {
        return [];
      }
      if (key === "const" || key === "enum" || key === "default") {
        return [[key, entry]];
      }
      if (
        (key === "properties" ||
          key === "patternProperties" ||
          key === "$defs" ||
          key === "definitions") &&
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry)
      ) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(entry).map(([name, child]) => [
                name,
                appSchemaValue(child, purpose),
              ]),
            ),
          ],
        ];
      }
      return [[key, appSchemaValue(entry, purpose)]];
    }),
  );
};

export const appInputSchema = (schema: unknown, purpose: SchemaPurpose) => {
  const value = appSchemaValue(schema, purpose);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return panic("App input must be an object schema");
  }
  return Object.fromEntries(Object.entries(value));
};

/** Browser-side input schemas and CSP-safe validators for presentation app tools. */
export const mcpAppInputArtifacts = (generatedRoot: string) => {
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
      return [name, appInputSchema(definition.inputSchema, "normalization")];
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
    ajv.addSchema(appInputSchema(schema, "validation"), name);
  }
  return [
    {
      path: path.join(generatedRoot, "input-schemas.json"),
      contents: `${JSON.stringify(schemas, null, 2)}\n`,
    },
    {
      path: path.join(generatedRoot, "input-validators.js"),
      // Validators are internal; the app consumes the single default registry.
      contents: `${standaloneCode(ajv, Object.fromEntries(tools.map((name) => [name, name]))).replaceAll("export const ", "const ")}\nexport default { ${tools.join(", ")} };\n`,
    },
    {
      path: path.join(generatedRoot, "input-validators.d.ts"),
      contents: `// Generated from declared MCP tool input schemas.\ntype InputValidator = ((input: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; params: Record<string, unknown> }[] | null };\ndeclare const validators: Record<${tools.map((name) => JSON.stringify(name)).join(" | ")}, InputValidator>;\nexport default validators;\n`,
    },
  ];
};
