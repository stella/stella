import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import * as v from "valibot";

import capabilityCatalog from "@stll/cli/capability-catalog.json";

import { withNullOptionalsOmitted } from "@/api/mcp/capability-tools";
import { DEFAULT_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";

/**
 * A strict tool-schema client must send every property a tool declares, so it
 * sends `null` for the optional ones it is not setting. Null is not a value on
 * this surface: it reads as a rename, as an AI-drafted field, as an empty
 * lookup path. `nullAsAbsent` makes the schema itself drop those nulls, so
 * every consumer of the schema gets it rather than one handler that remembers.
 *
 * This walks the registry and requires the property to hold, tool by tool,
 * instead of trusting that each new tool opts in.
 */
const definitionsWithRuntimeSchema = DEFAULT_MCP_TOOL_DEFINITIONS.filter(
  (definition) => "inputSchemaSource" in definition,
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A property that advertises `null` as one of its own values, such as
 * save_document's `label` ("pass null to clear"). Null carries meaning there,
 * so it is not absence and must reach the handler intact.
 */
const advertisesNull = (schema: unknown): boolean => {
  if (!isRecord(schema)) {
    return false;
  }
  const type = schema["type"];
  if (type === "null" || (Array.isArray(type) && type.includes("null"))) {
    return true;
  }
  return ["anyOf", "oneOf", "allOf"].some((keyword) => {
    const branches = schema[keyword];
    return Array.isArray(branches) && branches.some(advertisesNull);
  });
};

/** Advertised properties a client may omit and that carry no meaning for
 * null: exactly the ones a strict client will send as null. */
const optionalProperties = (schema: unknown): string[] => {
  if (!isRecord(schema)) {
    return [];
  }
  const properties = schema["properties"];
  const required = schema["required"];
  const requiredNames = new Set(
    Array.isArray(required)
      ? required.filter((name) => typeof name === "string")
      : [],
  );
  return isRecord(properties)
    ? Object.entries(properties)
        .filter(
          ([name, property]) =>
            !requiredNames.has(name) && !advertisesNull(property),
        )
        .map(([name]) => name)
    : [];
};

describe("MCP tool inputs read null as an omitted optional property", () => {
  test("every valibot-defined tool parses through the null-as-absent wrapper", () => {
    const unwrapped = definitionsWithRuntimeSchema
      .filter(
        ({ inputSchemaSource }) => !("advertisedSchema" in inputSchemaSource),
      )
      .map(({ name }) => name);

    expect(
      unwrapped,
      `These tools parse their declared object directly, so a strict client's null for an unset optional property reaches validation as a value: ${unwrapped.join(", ")}. Wrap the schema in nullAsAbsent(...) from tool-utils.`,
    ).toEqual([]);
  });

  /**
   * The outcome of a parse, reduced to what a caller sees. A conditionally
   * required property still reports its own rule (`name is required to create
   * a template`); the property under test is that setting it to null must
   * reach that rule at exactly the same place as omitting it.
   */
  const parseOutcome = (schema: v.GenericSchema, input: unknown): string => {
    const parsed = v.safeParse(schema, input);
    return parsed.success
      ? `ok:${JSON.stringify(parsed.output)}`
      : parsed.issues
          .map(
            (issue) =>
              `${(issue.path ?? []).map(({ key }) => String(key)).join(".")}: ${issue.message}`,
          )
          .sort()
          .join(" | ");
  };

  test("every advertised optional property parses null exactly as omission", () => {
    const divergent: string[] = [];
    for (const definition of definitionsWithRuntimeSchema) {
      const omitted = parseOutcome(definition.inputSchemaSource, {});
      for (const property of optionalProperties(definition.inputSchema)) {
        const withNull = parseOutcome(definition.inputSchemaSource, {
          [property]: null,
        });
        if (withNull !== omitted) {
          divergent.push(`${definition.name}.${property}`);
        }
      }
    }

    expect(
      divergent,
      `Setting these optional properties to null does not read as omitting them, so a strict tool-schema client that must send every property cannot call the tool: ${divergent.join(", ")}.`,
    ).toEqual([]);
  });

  /**
   * A property a client can read as accepting anything: it advertises no type
   * and no branches, so `t.Any()` / `t.Unknown()` land here and their null is a
   * value the handler asked for, not an unset property.
   */
  const acceptsAnything = (schema: unknown): boolean =>
    isRecord(schema) &&
    !("type" in schema) &&
    !("anyOf" in schema) &&
    !("oneOf" in schema);

  /**
   * Unlike the native tools, the capability path runs one chain for every
   * capability, so there is no per-capability opt-in to forget. What this buys
   * is coverage: `withNullOptionalsOmitted` is run over every part schema the
   * committed catalog carries (the same `advertisedSchemas` projection
   * `invoke_capability` validates against), so a schema shape it mishandles
   * shows up as a property it rewrote or one whose null it carried through.
   */
  test("every optional capability property reads null as omission", () => {
    const rewritten: string[] = [];
    const carriedThrough: string[] = [];
    for (const entry of capabilityCatalog) {
      const schema: unknown = entry.inputSchema;
      if (!isRecord(schema)) {
        continue;
      }
      for (const part of ["body", "params", "query"] as const) {
        const partSchema = schema[part];
        if (!isRecord(partSchema) || !isRecord(partSchema["properties"])) {
          continue;
        }
        const properties = partSchema["properties"];
        for (const property of optionalProperties(partSchema)) {
          const label = `${entry.id}.${part}.${property}`;
          const read = JSON.stringify(
            withNullOptionalsOmitted(partSchema, { [property]: null }),
          );
          if (read === "{}") {
            continue;
          }
          if (read !== JSON.stringify({ [property]: null })) {
            rewritten.push(label);
          } else if (!acceptsAnything(properties[property])) {
            carriedThrough.push(label);
          }
        }
      }
    }

    expect(
      rewritten,
      `Reading a null under these capability properties rewrote the input instead of dropping the property: ${rewritten.join(", ")}.`,
    ).toEqual([]);
    expect(
      carriedThrough,
      `These capability properties are optional and constrain their value without admitting null, yet their null reaches validation as a value: ${carriedThrough.join(", ")}.`,
    ).toEqual([]);
  });

  /**
   * The wrapper only helps the handlers that parse it. A handler parsing the
   * declared object directly would keep the old behaviour with nothing to show
   * for it in the registry, so bind the two here: every tool-argument parse in
   * this directory reads either a definition's `inputSchemaSource` or a local
   * schema declared through `nullAsAbsent`.
   */
  test("every handler parses its arguments through a null-as-absent schema", () => {
    const directory = import.meta.dir;
    const sources = readdirSync(directory).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(nodePath.join(directory, file), "utf-8");
      for (const match of source.matchAll(
        /v\.safeParse\(\s*([\w.]+)\s*,\s*args\s*,?\s*\)/gu,
      )) {
        const [, schema] = match;
        if (schema === undefined || schema.endsWith(".inputSchemaSource")) {
          continue;
        }
        if (
          new RegExp(
            `(?:^|\\n)(?:export )?const ${schema} = nullAsAbsent\\(`,
            "u",
          ).test(source)
        ) {
          continue;
        }
        offenders.push(`${file}: ${schema}`);
      }
    }

    expect(
      offenders,
      `These handlers parse tool arguments through a schema that does not drop a strict client's nulls: ${offenders.join(", ")}. Parse the definition's inputSchemaSource, or declare the schema as nullAsAbsent(...).`,
    ).toEqual([]);
  });
});
