import { describe, expect, test } from "bun:test";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

/**
 * The client-engagement container has one name on the advertised surface:
 * `matter_id`. "Matter" is the word practitioners and agents use, and it is the
 * public vocabulary across the tools, the CLI flags, and the capability ids;
 * "workspace" stays the internal identifier (the DB schema, `workspaceId` in
 * TypeScript, and the HTTP routes). This suite is the class guard for that
 * split: a tool that scopes to a matter under any other name, or one that
 * regains `workspace_id`, fails here rather than reaching the wire.
 */

/** The one name a matter-scoping input may carry. */
const CANONICAL_SCOPING_FIELD = "matter_id";

/**
 * Every other spelling of the container that has appeared, or could plausibly
 * appear, on an input. Advertised names are snake_case (enforced in
 * `registry-quality.test.ts`), but the camelCase spellings are listed too so a
 * hand-written schema cannot slip one through.
 */
const REJECTED_SCOPING_FIELDS = [
  "matter",
  "matterId",
  "workspace",
  "workspaceId",
  "workspace_id",
] as const;

/**
 * The tools that take a matter id, pinned explicitly. Derived membership is
 * compared against this list, so adding or removing a scoping input is a
 * reviewed change rather than a silent one.
 */
const MATTER_SCOPED_TOOLS = [
  "delete_matter",
  "link_matter_contact",
  "list_audit_log",
  "list_documents",
  "list_invoices",
  "list_matters",
  "list_properties",
  "list_tasks",
  "list_time_entries",
  "manage_organization",
  "resolve_rate",
  "run_playbook",
  "save_document",
  "save_filled_template",
  "save_matter",
  "save_task",
  "save_time_entry",
] as const;

const tools: readonly McpToolDefinition[] = DEFAULT_MCP_TOOL_DEFINITIONS;

const inputPropertyNames = (tool: McpToolDefinition): readonly string[] =>
  Object.keys(tool.inputSchema.properties ?? {});

describe("MCP input vocabulary: the container is a matter", () => {
  test("no input uses another spelling of the container", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const name of inputPropertyNames(tool)) {
        if (REJECTED_SCOPING_FIELDS.some((candidate) => candidate === name)) {
          offenders.push(`${tool.name}.${name}`);
        }
      }
    }
    expect(
      offenders,
      `Name the matter-scoping input ${CANONICAL_SCOPING_FIELD}: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("the matter-scoped tool set matches the pinned list", () => {
    const declaring = tools
      .filter((tool) =>
        inputPropertyNames(tool).includes(CANONICAL_SCOPING_FIELD),
      )
      .map((tool) => tool.name);
    expect([...declaring].sort()).toEqual([...MATTER_SCOPED_TOOLS].sort());
  });

  test("every scoping field is documented as a matter", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      const property = tool.inputSchema.properties?.[CANONICAL_SCOPING_FIELD];
      const description =
        typeof property === "object" &&
        property !== null &&
        "description" in property
          ? property.description
          : undefined;
      if (typeof description !== "string") {
        continue;
      }
      if (!description.toLowerCase().includes("matter")) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no advertised input description calls the container a workspace", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      for (const [name, property] of Object.entries(
        tool.inputSchema.properties ?? {},
      )) {
        const description =
          typeof property === "object" &&
          property !== null &&
          "description" in property
            ? property.description
            : undefined;
        if (
          typeof description === "string" &&
          description.toLowerCase().includes("workspace")
        ) {
          offenders.push(`${tool.name}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
