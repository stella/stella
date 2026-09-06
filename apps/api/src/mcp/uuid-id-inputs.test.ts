import { describe, expect, test } from "bun:test";

import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import {
  describeTemplateArgsSchema,
  fillTemplateArgsSchema,
  saveFilledTemplateArgsSchema,
} from "@/api/mcp/template-tools";

/**
 * Every id a tool accepts is either a UUID this codebase mints or one of the
 * few identifiers that are deliberately not. The first kind reaches SQL as a
 * `uuid` column, so an unvalidated one fails in Postgres (22P02) and surfaces
 * as `internal_error` with a captured DrizzleQueryError, instead of the
 * `validation_error` naming the field that the caller can act on. Declaring
 * the format also tells a client what shape to send before it sends it.
 *
 * This walks the advertised input schema of every registered tool -- the same
 * definitions `tools/list` serializes -- and requires a uuid check on every
 * property named `id` or ending in `_id`. For a `defineValibotMcpTool` tool
 * the advertised schema is projected from the `v.strictObject` its handler
 * parses, so the assertion binds the runtime validator, not a mirror of it.
 *
 * The tools on the decreasing legacy list in `static-tool-definitions.ts` still
 * advertise a hand-written schema alongside that validator, so the advertised
 * side alone would let a one-sided edit ship a contract the handler does not
 * enforce. `LEGACY_MANUAL_INPUT_VALIDATORS` binds the two, in both directions,
 * until those tools migrate.
 */
const NON_UUID_ID_INPUTS: Record<string, string> = {
  // Auth-provider (better-auth) user ids are alphanumeric text, and the
  // columns that hold them are `text`/`varchar`, never `uuid`.
  "list_time_entries.user_id": "better-auth user id (text column)",
  "resolve_rate.user_id": "better-auth user id (text column)",
  "save_task.add_assignee_user_id": "better-auth user id (text column)",
  "save_task.remove_assignee_user_id": "better-auth user id (text column)",
  "list_audit_log.user_id": "better-auth user id (text column)",
  "manage_organization.user_id": "better-auth user id (text column)",
  // The audit log records one text `resource_id` for every resource type it
  // audits, including the text user ids above.
  "list_audit_log.resource_id":
    "audit-log resource id of any type (text column)",
  // An IANA time zone name (`Europe/Prague`), not an id this codebase mints.
  "save_time_entry.timezone_id": "IANA time zone name",
  // External statute-corpus identifiers, fetched over HTTP and never stored:
  // already shape-checked by their own regexes (e.g. `BOE-A-1889-4763`).
  "search_legislation.law_id": "external statute corpus identifier",
  "search_legislation.block_id": "external statute text-block identifier",
  // A host-assigned reference from the MCP client's file payload, used only
  // as a display-name fallback.
  "upload_document_version.file.file_id": "host-assigned client file reference",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isIdProperty = (name: string): boolean =>
  name === "id" || name.endsWith("_id");

/**
 * True when a property schema constrains its string to a UUID. A nullable or
 * unioned id (`anyOf: [{ format: "uuid" }, { type: "null" }]`) counts only if
 * every branch that can hold a string is itself uuid-constrained, so one
 * unconstrained branch cannot smuggle a raw string through.
 */
const declaresUuid = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  if (schema["format"] === "uuid") {
    return true;
  }
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) {
      continue;
    }
    const stringBranches = branches.filter(
      (branch) => !(isRecord(branch) && branch["type"] === "null"),
    );
    if (
      stringBranches.length > 0 &&
      stringBranches.every((branch) => declaresUuid(branch))
    ) {
      return true;
    }
  }
  return false;
};

/**
 * The validator each legacy tool's handler actually parses, keyed by tool name.
 * `list_templates` reaches its detail branch through `describeTemplateArgsSchema`.
 */
const LEGACY_MANUAL_INPUT_VALIDATORS = {
  list_templates: describeTemplateArgsSchema,
  fill_template: fillTemplateArgsSchema,
  save_filled_template: saveFilledTemplateArgsSchema,
};

/**
 * True when a Valibot schema enforces a uuid on the value it accepts: a `uuid`
 * action anywhere in its pipe, through any `optional`/`nullable` wrapper. This
 * reads the schema the handler runs, so it is evidence of enforcement rather
 * than of what the tool advertises.
 */
const validatorEnforcesUuid = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  if (schema["kind"] === "validation" && schema["type"] === "uuid") {
    return true;
  }
  const pipe = schema["pipe"];
  if (Array.isArray(pipe) && pipe.some(validatorEnforcesUuid)) {
    return true;
  }
  return validatorEnforcesUuid(schema["wrapped"]);
};

/** Every id-named property in an advertised schema, at any nesting depth. */
const collectIdProperties = (
  schema: unknown,
  path: string,
  found: { path: string; schema: unknown }[],
): void => {
  if (!isRecord(schema)) {
    return;
  }
  if (isRecord(schema["properties"])) {
    for (const [key, property] of Object.entries(schema["properties"])) {
      const propertyPath = `${path}.${key}`;
      if (isIdProperty(key)) {
        found.push({ path: propertyPath, schema: property });
      }
      collectIdProperties(property, propertyPath, found);
    }
  }
  collectIdProperties(schema["items"], `${path}[]`, found);
  for (const keyword of ["anyOf", "allOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      collectIdProperties(branch, path, found);
    }
  }
};

const idProperties = DEFAULT_MCP_TOOL_DEFINITIONS.flatMap((tool) => {
  const found: { path: string; schema: unknown }[] = [];
  collectIdProperties(tool.inputSchema, tool.name, found);
  return found;
});

describe("MCP id inputs are validated as UUIDs", () => {
  test("every id input either validates as a uuid or is a declared exception", () => {
    const unvalidated = idProperties
      .filter(
        ({ path, schema }) =>
          NON_UUID_ID_INPUTS[path] === undefined && !declaresUuid(schema),
      )
      .map(({ path }) => path);

    expect(
      unvalidated,
      `These id inputs reach SQL without a uuid check, so a malformed value fails as a Postgres cast error reported as internal_error: ${unvalidated.join(", ")}. Declare each with uuidInputSchema(...) from tool-utils, or add it to NON_UUID_ID_INPUTS with the reason it is not a uuid.`,
    ).toEqual([]);
  });

  test("no declared exception outlives the input it exempts", () => {
    const advertised = new Set(idProperties.map(({ path }) => path));
    const stale = Object.keys(NON_UUID_ID_INPUTS).filter(
      (path) => !advertised.has(path),
    );

    expect(
      stale,
      `These NON_UUID_ID_INPUTS entries name inputs the registry no longer advertises: ${stale.join(", ")}. Remove them so the exception list cannot outlive its reason.`,
    ).toEqual([]);
  });

  test("a hand-written schema cannot advertise a uuid its validator omits", () => {
    const mismatches: string[] = [];
    for (const [toolName, validator] of Object.entries(
      LEGACY_MANUAL_INPUT_VALIDATORS,
    )) {
      const tool = DEFAULT_MCP_TOOL_DEFINITIONS.find(
        ({ name }) => name === toolName,
      );
      if (tool === undefined) {
        throw new Error(`${toolName} is no longer a registered tool`);
      }
      const advertised: { path: string; schema: unknown }[] = [];
      collectIdProperties(tool.inputSchema, toolName, advertised);
      for (const { path, schema } of advertised) {
        const key = path.slice(`${toolName}.`.length);
        const validatorEntry = Object.entries(validator.entries)
          .find(([name]) => name === key)
          ?.at(1);
        if (declaresUuid(schema) !== validatorEnforcesUuid(validatorEntry)) {
          mismatches.push(path);
        }
      }
    }

    expect(
      mismatches,
      `The advertised schema and the validator its handler parses disagree on whether these ids are uuids: ${mismatches.join(", ")}. Both sides are hand-written for these tools, so change them together, or move the tool to defineValibotMcpTool so the advertised schema is projected from the validator.`,
    ).toEqual([]);
  });

  test("every hand-written schema carrying an id is bound to its validator", () => {
    const unbound = DEFAULT_MCP_TOOL_DEFINITIONS.filter(
      (tool) =>
        !("inputSchemaSource" in tool) &&
        !(tool.name in LEGACY_MANUAL_INPUT_VALIDATORS) &&
        idProperties.some(({ path }) => path.startsWith(`${tool.name}.`)),
    ).map(({ name }) => name);

    expect(
      unbound,
      `These tools advertise a hand-written schema with an id input but no validator to bind it to: ${unbound.join(", ")}. Add the validator to LEGACY_MANUAL_INPUT_VALIDATORS, or define the tool with defineValibotMcpTool.`,
    ).toEqual([]);
  });

  test("the registry advertises id inputs at all", () => {
    // Guards the walk itself: a projection change that stopped exposing
    // properties would make both checks above pass vacuously.
    expect(idProperties.length).toBeGreaterThan(30);
  });
});
