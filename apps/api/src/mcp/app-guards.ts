import * as v from "valibot";

import {
  DOCUMENT_VERSION_UPLOAD_TRANSPORT,
  FILE_COMPARISON_TRANSPORT,
} from "@stll/api-contract";

import type { McpToolDefinition } from "./tool-types";
import { isMcpToolVisibleTo } from "./tool-visibility";

const appSchema = v.strictObject({
  directory: v.string(),
  uri: v.pipe(v.string(), v.startsWith("ui://")),
  linkedTools: v.pipe(v.array(v.string()), v.nonEmpty()),
  callableTools: v.array(v.string()),
});
const manifestSchema = v.array(
  v.variant("type", [
    v.strictObject({ ...appSchema.entries, type: v.literal("presentation") }),
    v.strictObject({
      ...appSchema.entries,
      type: v.literal("host-approved-mutation"),
      reason: v.pipe(v.string(), v.nonEmpty()),
    }),
  ]),
);

// Existing browser upload flows are the only mutation apps; this set can shrink.
const MUTATION_APP_URIS: ReadonlySet<string> = new Set([
  DOCUMENT_VERSION_UPLOAD_TRANSPORT.resourceUri,
  FILE_COMPARISON_TRANSPORT.resourceUri,
]);

type InspectAppManifestArgs = {
  apps: unknown;
  tools: readonly McpToolDefinition[];
  directories: readonly string[];
};

export const inspectAppManifest = ({
  apps,
  tools,
  directories,
}: InspectAppManifestArgs): string[] => {
  const parsed = v.safeParse(manifestSchema, apps);
  if (!parsed.success) {
    return ["Every app requires a declared call class and tool policy"];
  }
  const issues: string[] = [];
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const entries = parsed.output;
  const registered = new Set(entries.map(({ directory }) => directory));
  if (
    registered.size !== entries.length ||
    new Set(entries.map(({ uri }) => uri)).size !== entries.length
  ) {
    issues.push("App registrations must be unique");
  }
  for (const directory of directories) {
    if (!registered.has(directory)) {
      issues.push(`Unclassified app: ${directory}`);
    }
  }
  for (const app of entries) {
    if (!directories.includes(app.directory)) {
      issues.push(`App entrypoint is missing: ${app.directory}`);
    }
    if (
      app.type === "host-approved-mutation" &&
      !MUTATION_APP_URIS.has(app.uri)
    ) {
      issues.push(
        `Only existing upload flows may be mutation apps: ${app.uri}`,
      );
    }
    for (const name of app.callableTools) {
      const tool = toolMap.get(name);
      if (tool === undefined) {
        issues.push(`Unknown app tool: ${name}`);
      } else {
        if (!isMcpToolVisibleTo(tool, "app")) {
          issues.push(`App calls require app-visible tools: ${name}`);
        }
        if (app.type === "presentation" && tool.access !== "read") {
          issues.push(`Presentation apps require read-only tools: ${name}`);
        }
      }
    }
    for (const name of app.linkedTools) {
      const tool = toolMap.get(name);
      const ui = tool?._meta?.["ui"];
      if (
        typeof ui !== "object" ||
        ui === null ||
        !("resourceUri" in ui) ||
        ui.resourceUri !== app.uri
      ) {
        issues.push(`App link does not match its tool: ${name}`);
      }
    }
  }
  for (const tool of tools) {
    const ui = tool._meta?.["ui"];
    if (
      typeof ui !== "object" ||
      ui === null ||
      !("resourceUri" in ui) ||
      typeof ui.resourceUri !== "string"
    ) {
      continue;
    }
    const app = entries.find(({ uri }) => uri === ui.resourceUri);
    if (app === undefined || !app.linkedTools.includes(tool.name)) {
      issues.push(`Tool has an unregistered app link: ${tool.name}`);
    }
  }
  return issues;
};

type InspectAppSchemasArgs = {
  actual: Readonly<Record<string, unknown>>;
  expected: Readonly<Record<string, unknown>>;
};
export const inspectAppSchemas = ({
  actual,
  expected,
}: InspectAppSchemasArgs): string[] => {
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  return [...keys]
    .filter(
      (key) => JSON.stringify(actual[key]) !== JSON.stringify(expected[key]),
    )
    .map((key) => `App schema differs from tool output: ${key}`);
};
