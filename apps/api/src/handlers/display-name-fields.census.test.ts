/**
 * Census: every name a request body or a native MCP tool input carries goes
 * through `displayNameSchema`, which stores it without explicit directional
 * formatting.
 *
 * The walk reads the live route table and tool registry, so a new route or
 * tool, or a new name field on an existing one, fails here until its schema
 * uses the owner or the field is listed below with the reason it is not a
 * stored display name.
 */

import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import "@/api/tests/setup-env";

import { DISPLAY_NAME_NORMALIZER } from "@stll/api-contract/display-name";

import { apiRoutes } from "@/api/api-routes";
import type { RouteEntry } from "@/api/http/route";
import { displayNameSchema } from "@/api/lib/custom-schema";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

const NAME_KEY = /^(?:name|\w+Name|\w+_name)$/u;

/** `entities.name` has its own stricter owner, `normalizeEntityName`. */
const ENTITY_NAMES = [
  "POST /v1/uploads/:workspaceId/presign body.name",
  "POST /v1/uploads/:workspaceId/entity-create/tree body.directories[].name",
  "POST /v1/uploads/:workspaceId/entity-create/tree body.files[].name",
  "POST /v1/entities/:workspaceId/upload body.name",
  "POST /v1/entities/:workspaceId/upload-generated-document body.name",
  "PUT /v1/entities/:workspaceId body.name",
  "PUT /v1/entities/:workspaceId/blank-document body.name",
  "PUT /v1/entities/:workspaceId/blank-document-from-style-set body.name",
  "POST /v1/entities/:workspaceId/create-from-legal-source body.name",
  "POST /v1/entities/:workspaceId/folder-from-selection body.name",
  "PATCH /v1/entities/:workspaceId/rename body.name",
  "POST /v1/entities/:workspaceId/duplicate body.name",
  "POST /v1/templates/:templateId/fill-to/:workspaceId body.name",
  "PUT /v1/tasks/:workspaceId body.name",
  "PATCH /v1/tasks/:workspaceId body.name",
];

/** File names: `sanitizeFilename` owns them. */
const FILE_NAMES = [
  "POST /v1/contacts/procuracao-upload body.name",
  "POST /v1/chat body.forwardedProps.activeDraft.fileName",
  "POST /v1/chat body.forwardedProps.activeFile.fileName",
  "POST /v1/chat body.forwardedProps.activeTemplate.fileName",
  "POST /v1/desktop/billing-drafts body.previousResult.drafts[].flags[].ruleRef.fileName",
  "POST /v1/desktop/billing-drafts body.previousResult.checkedGuidelines[].fileName",
];

/** Read for one request (a lookup, a prompt, an echo) and never stored as a name. */
const TRANSIENT_VALUES = [
  "POST /v1/properties/:workspaceId/suggest-prompt body.name",
  "POST /v1/entities/:workspaceId/organize-suggestions body.existingFolders[].name",
  "POST /v1/entities/:workspaceId/organize-suggestions body.files[].originalName",
  "POST /v1/contacts/business-registries/checks body.name",
  "POST /v1/contacts/business-registries/checks body.firstName",
  "POST /v1/contacts/business-registries/checks body.lastName",
  "POST /v1/sanctions/search body.subject.name",
  "POST /v1/sanctions/search body.subject.firstName",
  "POST /v1/sanctions/search body.subject.lastName",
  "POST /v1/chat body.tools[].name",
  "POST /v1/chat body.forwardedProps.userContext.userName",
  "POST /v1/chat body.forwardedProps.userContext.wordEditAuthorName",
  "POST /v1/chat body.forwardedProps.activeExternal.sourceToolName",
  "POST /v1/chat body.forwardedProps.activeSkill.skillName",
  "POST /v1/desktop/billing-drafts body.previousResult.drafts[].operations[].targetMatterName",
  "POST /v1/desktop/time-entries/narrative body.matterName",
];

/** Identifiers and account labels a program supplies, not a person. */
const IDENTIFIERS = [
  "POST /v1/folio-collab-rooms/authorize body.roomName",
  "POST /v1/chat/tool-grants body.toolName",
  "POST /v1/entities/:workspaceId/desktop-edit-handoffs body.linkedAccount.name",
];

/** Native MCP tool inputs, for the same reasons as the routes above. */
const MCP_NOT_DISPLAY_NAMES = [
  // `entities.name`, owned by `normalizeEntityName`.
  "save_filled_template input.name",
  "save_document input.name",
  "save_task input.name",
  // File names, owned by `sanitizeFilename`.
  "create_template input.file.file_name",
  "upload_document_version input.file.file_name",
  "prepare_file_comparison input.base.name",
  "prepare_file_comparison input.target.name",
  "prepare_file_comparison_from_links input.base.name",
  "prepare_file_comparison_from_links input.target.name",
  // A lookup, never stored.
  "check_counterparty input.subject.first_name",
  "check_counterparty input.subject.last_name",
  "check_counterparty input.subject.name",
];

const NOT_DISPLAY_NAMES = new Set([
  ...ENTITY_NAMES,
  ...FILE_NAMES,
  ...TRANSIENT_VALUES,
  ...IDENTIFIERS,
  ...MCP_NOT_DISPLAY_NAMES,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const listOf = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

/** Fixed values hold only what the code wrote. */
const FIXED_VALUE_TYPES = new Set(["literal", "picklist", "null"]);

/** Whether parsing through this schema runs the owner's normalizer. */
const normalizesDisplayName = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  if (
    typeof schema["type"] === "string" &&
    FIXED_VALUE_TYPES.has(schema["type"])
  ) {
    return true;
  }
  if ("wrapped" in schema) {
    return normalizesDisplayName(schema["wrapped"]);
  }
  if (Array.isArray(schema["options"])) {
    return schema["options"].every(normalizesDisplayName);
  }
  const pipe = listOf(schema["pipe"]);
  return (
    pipe.includes(DISPLAY_NAME_NORMALIZER) ||
    (pipe[0] !== schema && pipe[0] !== undefined
      ? normalizesDisplayName(pipe[0])
      : false)
  );
};

type NameField = { field: string; schema: unknown };

const nameFields = (
  schema: unknown,
  path: string,
  seen: Set<unknown>,
): NameField[] => {
  if (!isRecord(schema) || seen.has(schema)) {
    return [];
  }
  seen.add(schema);
  const pipe = listOf(schema["pipe"]).filter((item) => item !== schema);
  const children: [unknown, string][] = [
    ...pipe.map((item): [unknown, string] => [item, path]),
    [schema["wrapped"], path],
    [schema["item"], `${path}[]`],
    ...listOf(schema["options"]).map((option): [unknown, string] => [
      option,
      path,
    ]),
    ...(schema["type"] === "record"
      ? [[schema["value"], `${path}{}`] satisfies [unknown, string]]
      : []),
  ];
  const entries = isRecord(schema["entries"]) ? schema["entries"] : {};
  const own = Object.entries(entries).flatMap(([key, entry]) => [
    ...(NAME_KEY.test(key) ? [{ field: `${path}.${key}`, schema: entry }] : []),
    ...nameFields(entry, `${path}.${key}`, seen),
  ]);
  return [
    ...own,
    ...children.flatMap(([child, childPath]) =>
      nameFields(child, childPath, seen),
    ),
  ];
};

type SchemaOwner = { key: string; schema: unknown; root: string };

/** Every name field under each owner's schema, keyed `<owner> <root>.field`. */
const ownedNameFields = (
  owners: readonly SchemaOwner[],
): Map<string, boolean> => {
  const fields = new Map<string, boolean>();
  for (const owner of owners) {
    for (const { field, schema } of nameFields(
      owner.schema,
      owner.root,
      new Set(),
    )) {
      const key = `${owner.key} ${field}`;
      // One field can be reached through several union members.
      fields.set(
        key,
        (fields.get(key) ?? true) && normalizesDisplayName(schema),
      );
    }
  }
  return fields;
};

/** Every name field of every route body, keyed `METHOD /path body.field`. */
const routeNameFields = (routes: readonly RouteEntry[]): Map<string, boolean> =>
  ownedNameFields(
    routes.map((route) => ({
      key: `${route.method} ${route.path}`,
      schema: route.definition.config.body,
      root: "body",
    })),
  );

/** Route bodies and native MCP tool inputs, which call handlers directly. */
const liveNameFields = (): Map<string, boolean> =>
  new Map([
    ...routeNameFields(apiRoutes),
    ...ownedNameFields(
      DEFAULT_MCP_TOOL_DEFINITIONS.map((tool) => ({
        key: tool.name,
        schema: tool.inputSchemaSource,
        root: "input",
      })),
    ),
  ]);

const fixtureRoute = (body: v.GenericSchema): RouteEntry => ({
  method: "PUT",
  path: "/fixture/widgets",
  middleware: [],
  definition: {
    access: "member",
    config: { description: "Create a widget.", body },
    run: async () => body,
  },
});

describe("display name fields", () => {
  test("a raw name field fails and an owned one passes, through wrappers", () => {
    const body = v.strictObject({
      name: v.pipe(v.string(), v.minLength(1)),
      parts: v.array(
        v.object({
          firstName: v.optional(v.nullable(displayNameSchema())),
          lastName: v.pipe(displayNameSchema(), v.regex(/\S/u)),
          cleared_name: v.union([displayNameSchema(), v.literal("")]),
          other_name: v.union([displayNameSchema(), v.string()]),
        }),
      ),
    });
    expect(Object.fromEntries(routeNameFields([fixtureRoute(body)]))).toEqual({
      "PUT /fixture/widgets body.name": false,
      "PUT /fixture/widgets body.parts[].firstName": true,
      "PUT /fixture/widgets body.parts[].lastName": true,
      "PUT /fixture/widgets body.parts[].cleared_name": true,
      "PUT /fixture/widgets body.parts[].other_name": false,
    });
  });

  test("the owner stores a name without directional controls", () => {
    expect(v.parse(displayNameSchema(), "Lease \u202Efdp.exe\u2069")).toBe(
      "Lease fdp.exe",
    );
    expect(v.parse(displayNameSchema(), "\u200Fשלום")).toBe("\u200Fשלום");
    expect(v.safeParse(displayNameSchema(), "\u202E\u202C").success).toBe(
      false,
    );
    expect(v.parse(displayNameSchema({ allowEmpty: true }), "\u2066")).toBe("");
  });

  test("every route body and tool input name uses the owner unless listed", () => {
    const unowned = [...liveNameFields()]
      .filter(([key, owned]) => !owned && !NOT_DISPLAY_NAMES.has(key))
      .map(([key]) => key)
      .toSorted();
    expect(unowned).toEqual([]);
  });

  test("every listed exception still names a field the owner skips", () => {
    const fields = liveNameFields();
    expect(
      [...NOT_DISPLAY_NAMES].filter((key) => fields.get(key) !== false),
    ).toEqual([]);
  });
});
