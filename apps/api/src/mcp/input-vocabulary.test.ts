import { describe, expect, test } from "bun:test";

import {
  applyDeprecatedInputAliases,
  DEPRECATED_MCP_INPUT_ALIASES,
} from "@/api/mcp/deprecated-input-aliases";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import type { McpToolDefinition } from "@/api/mcp/tool-types";

/**
 * The scoping container has one name on the advertised surface: `workspace_id`.
 * The product UI, the CLI capability commands, and every handler (which maps
 * the field straight to `workspaceId`) already call it that; the tools used to
 * call it `matter_id`, and an agent-orientation eval showed models guessing the
 * workspace vocabulary for the CLI. This suite is the class guard for that
 * rename: a new tool that scopes to a workspace under any other name, or a
 * renamed tool that quietly regains `matter_id`, fails here rather than
 * reaching the wire.
 */

/**
 * Tools whose subject IS the matter record, so `matter_id` names the thing
 * being read or written rather than the container it lives in. Each entry
 * carries the reason it is exempt; nothing else may declare the name.
 */
const MATTER_ENTITY_TOOLS: Readonly<Record<string, string>> = {
  save_matter:
    "creates or updates the matter record itself; the id selects the record to update",
  delete_matter: "deletes the matter record named by the id",
  list_matters:
    "lists matter records, or reads one matter's overview when the id is given",
  link_matter_contact:
    "links a contact to the matter record named by the id (the join row's matter side)",
};

/** The one name a workspace-scoping input may carry. */
const CANONICAL_SCOPING_FIELD = "workspace_id";

/**
 * Every other spelling of the container that has appeared, or could plausibly
 * appear, on an input. Advertised names are snake_case (enforced in
 * `registry-quality.test.ts`), but the camelCase spellings are listed too so a
 * hand-written schema cannot slip one through.
 */
const REJECTED_SCOPING_FIELDS = [
  "matter",
  "matterId",
  "matter_id",
  "workspace",
  "workspaceId",
] as const;

/**
 * The tools that scope to a workspace container, pinned explicitly. Derived
 * membership is compared against this list, so adding or removing a scoping
 * input is a reviewed change rather than a silent one.
 */
const WORKSPACE_SCOPED_TOOLS = [
  "list_documents",
  "save_document",
  "list_properties",
  "list_tasks",
  "save_task",
  "run_playbook",
  "list_time_entries",
  "save_time_entry",
  "resolve_rate",
  "list_invoices",
  "list_audit_log",
  "manage_organization",
  "save_filled_template",
] as const;

const tools: readonly McpToolDefinition[] = DEFAULT_MCP_TOOL_DEFINITIONS;

const inputPropertyNames = (tool: McpToolDefinition): readonly string[] =>
  Object.keys(tool.inputSchema.properties ?? {});

describe("MCP input vocabulary: the container is a workspace", () => {
  test("only matter-entity tools declare matter_id", () => {
    const offenders = tools
      .filter((tool) => inputPropertyNames(tool).includes("matter_id"))
      .map((tool) => tool.name)
      .filter((name) => !(name in MATTER_ENTITY_TOOLS));
    expect(
      offenders,
      `These tools scope to a workspace but name the input matter_id: ${offenders.join(", ")}. Rename the input to ${CANONICAL_SCOPING_FIELD}; matter_id survives only where the matter record itself is the subject.`,
    ).toEqual([]);
  });

  test("every matter-entity exemption is still used", () => {
    // The converse: an exemption that no longer matches a real declaration is
    // stale permission to reintroduce the old name.
    const declaring = new Set(
      tools
        .filter((tool) => inputPropertyNames(tool).includes("matter_id"))
        .map((tool) => tool.name),
    );
    const unused = Object.keys(MATTER_ENTITY_TOOLS).filter(
      (name) => !declaring.has(name),
    );
    expect(unused).toEqual([]);
  });

  test("no input uses another spelling of the container", () => {
    const offenders: string[] = [];
    for (const tool of tools) {
      const exempt = tool.name in MATTER_ENTITY_TOOLS;
      for (const name of inputPropertyNames(tool)) {
        const rejected = REJECTED_SCOPING_FIELDS.some(
          (candidate) => candidate === name,
        );
        if (rejected && !(exempt && name === "matter_id")) {
          offenders.push(`${tool.name}.${name}`);
        }
      }
    }
    expect(
      offenders,
      `Name the workspace-scoping input ${CANONICAL_SCOPING_FIELD}: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("the workspace-scoped tool set matches the pinned list", () => {
    const declaring = tools
      .filter((tool) =>
        inputPropertyNames(tool).includes(CANONICAL_SCOPING_FIELD),
      )
      .map((tool) => tool.name);
    expect([...declaring].sort()).toEqual([...WORKSPACE_SCOPED_TOOLS].sort());
  });

  test("every scoping field is documented as a workspace", () => {
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
      if (!description.toLowerCase().includes("workspace")) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("deprecated input aliases", () => {
  const schemaOf = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`No such tool: ${name}`);
    }
    return tool.inputSchema;
  };

  test("matter_id is still accepted as workspace_id for one release", () => {
    expect(DEPRECATED_MCP_INPUT_ALIASES.matter_id).toBe(
      CANONICAL_SCOPING_FIELD,
    );
    expect(
      applyDeprecatedInputAliases({
        args: { limit: 10, matter_id: "ws_1" },
        inputSchema: schemaOf("list_documents"),
      }),
    ).toEqual({
      args: { limit: 10, workspace_id: "ws_1" },
      status: "normalized",
    });
  });

  test("a matter-entity tool keeps its own matter_id", () => {
    expect(
      applyDeprecatedInputAliases({
        args: { matter_id: "ws_1", name: "Acme" },
        inputSchema: schemaOf("save_matter"),
      }),
    ).toEqual({
      args: { matter_id: "ws_1", name: "Acme" },
      status: "normalized",
    });
  });

  test("both names with different values is a conflict, not a winner", () => {
    expect(
      applyDeprecatedInputAliases({
        args: { matter_id: "ws_1", workspace_id: "ws_2" },
        inputSchema: schemaOf("list_documents"),
      }),
    ).toEqual({
      conflicts: [{ alias: "matter_id", canonical: "workspace_id" }],
      status: "conflict",
    });
  });

  test("both names with the same value collapse to the canonical one", () => {
    expect(
      applyDeprecatedInputAliases({
        args: { matter_id: "ws_1", workspace_id: "ws_1" },
        inputSchema: schemaOf("list_documents"),
      }),
    ).toEqual({ args: { workspace_id: "ws_1" }, status: "normalized" });
  });
});
