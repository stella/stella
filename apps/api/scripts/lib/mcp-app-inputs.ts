import { panic } from "better-result";
import path from "node:path";

import { MCP_APPS } from "@stll/mcp-apps/manifest";

import { mcpAppToolInputSchema } from "../../src/mcp/app-tool-inputs";

const appSchemaValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => appSchemaValue(entry));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (key === "description" || key.startsWith("x-stella-")) {
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
                appSchemaValue(child),
              ]),
            ),
          ],
        ];
      }
      return [[key, appSchemaValue(entry)]];
    }),
  );
};

export const appInputSchema = (schema: unknown) => {
  const value = appSchemaValue(schema);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return panic("App input must be an object schema");
  }
  return Object.fromEntries(Object.entries(value));
};

/** Browser-side input schemas for the tools presentation apps call. */
export const mcpAppInputArtifacts = (generatedRoot: string) => {
  const tools = [
    ...new Set(
      MCP_APPS.filter((app) => app.type === "presentation").flatMap(
        (app) => app.callableTools,
      ),
    ),
  ];
  const schemas = Object.fromEntries(
    tools.map((name) => [name, appInputSchema(mcpAppToolInputSchema(name))]),
  );
  return [
    {
      path: path.join(generatedRoot, "input-schemas.json"),
      contents: `${JSON.stringify(schemas, null, 2)}\n`,
    },
  ];
};
