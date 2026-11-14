import { describe, expect, test } from "bun:test";

import { MCP_APPS } from "@stll/mcp-apps/manifest";

import { inspectAppManifest } from "./app-guards";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "./static-tool-definitions";
import type { McpToolDefinition } from "./tool-types";

const readerTool = {
  name: "reader_blocks",
  description: "Read decision blocks",
  access: "read",
  permissions: { type: "open-read", reason: "reads only fixture data" },
  readClass: "public",
  annotationReasons: {
    readOnlyHint: "Reads fixture data without modifying it.",
    destructiveHint: "The fixture changes no existing data.",
    openWorldHint: "The fixture reads local data only.",
  },
  anonymized: { exposure: "passthrough" },
  consumesServices: false,
  scope: "stella:read",
  inputSchema: { type: "object" },
  annotations: {
    title: "Decision blocks",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: ["app"] } },
} as const satisfies McpToolDefinition;

const opener = {
  ...readerTool,
  name: "open_reader",
  _meta: {
    ui: {
      resourceUri: "ui://stella/test-reader",
      visibility: ["model", "app"],
    },
  },
} as const satisfies McpToolDefinition;

const manifest = [
  {
    type: "presentation",
    directory: "test-reader",
    uri: "ui://stella/test-reader",
    linkedTools: [opener.name],
    callableTools: [readerTool.name],
  },
];

const inspect = (tool: McpToolDefinition) =>
  inspectAppManifest({
    apps: manifest,
    tools: [opener, tool],
    directories: ["test-reader"],
  });

describe("presentation app tool audiences", () => {
  test("citation graph's linked and callable tools satisfy the app contract", () => {
    expect(
      inspectAppManifest({
        apps: MCP_APPS,
        tools: DEFAULT_MCP_TOOL_DEFINITIONS,
        directories: MCP_APPS.map(({ directory }) => directory),
      }),
    ).toEqual([]);
  });

  test("app-only read tools need no resource link", () => {
    expect(inspect(readerTool)).toEqual([]);
  });

  test("model-only tools cannot be app call targets", () => {
    expect(
      inspect({ ...readerTool, _meta: { ui: { visibility: ["model"] } } }),
    ).toEqual(["App calls require app-visible tools: reader_blocks"]);
  });

  test("app-only writes are allowed for presentation apps", () => {
    const writeTool = {
      name: readerTool.name,
      description: readerTool.description,
      scope: readerTool.scope,
      inputSchema: readerTool.inputSchema,
      annotations: { ...readerTool.annotations, readOnlyHint: false },
      annotationReasons: {
        ...readerTool.annotationReasons,
        readOnlyHint: "Writes fixture data.",
      },
      anonymized: readerTool.anonymized,
      consumesServices: readerTool.consumesServices,
      _meta: readerTool._meta,
      access: "write",
      permissions: { type: "delegated", reason: "Test upstream authorization" },
      accountAccess: "account-control",
    } as const satisfies McpToolDefinition;
    expect(inspect(writeTool)).toEqual([]);
  });

  test("model-visible writes remain forbidden for presentation apps", () => {
    const writeTool = {
      name: readerTool.name,
      description: readerTool.description,
      scope: readerTool.scope,
      inputSchema: readerTool.inputSchema,
      annotations: { ...readerTool.annotations, readOnlyHint: false },
      annotationReasons: {
        ...readerTool.annotationReasons,
        readOnlyHint: "Changes the selected record.",
      },
      anonymized: readerTool.anonymized,
      consumesServices: readerTool.consumesServices,
      _meta: {
        ui: { visibility: ["model", "app"] },
      },
      access: "write",
      permissions: { type: "delegated", reason: "The target enforces access" },
      accountAccess: "standard",
    } as const satisfies McpToolDefinition;

    expect(inspect(writeTool)).toContain(
      "Presentation apps cannot call model-visible write tools: reader_blocks",
    );
  });
});
