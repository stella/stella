import { Type, type SchemaOptions, type TSchema } from "@sinclair/typebox";
import type { JsonSchema } from "@valibot/to-json-schema";
import { panic } from "better-result";

const TYPEBOX_STRUCTURE_KEYS = new Set([
  "type",
  "anyOf",
  "enum",
  "properties",
  "required",
  "items",
]);

const unionOf = (schemas: TSchema[], options: SchemaOptions) => {
  const first = schemas.at(0);
  if (first === undefined) {
    return Type.Never(options);
  }
  let union = Type.Union([first], options);
  for (const schema of schemas.slice(1)) {
    union = Type.Union([union, schema], options);
  }
  return union;
};

/** Native TypeBox nodes for finite JSON schemas, including nested unions. */
export const jsonSchemaToTypeBox = (schema: JsonSchema | boolean): TSchema => {
  if (typeof schema === "boolean") {
    return schema ? Type.Any() : Type.Never();
  }
  if (
    schema.$ref !== undefined ||
    schema.allOf !== undefined ||
    schema.oneOf !== undefined ||
    schema.not !== undefined
  ) {
    return panic("The TypeBox adapter requires a finite direct JSON schema");
  }
  const options = Object.fromEntries(
    Object.entries(schema).filter(
      ([key, value]) => value !== undefined && !TYPEBOX_STRUCTURE_KEYS.has(key),
    ),
  );
  if (schema.anyOf) {
    return unionOf(schema.anyOf.map(jsonSchemaToTypeBox), options);
  }
  if (schema.enum) {
    return unionOf(
      schema.enum.map((value) => {
        if (value === null) {
          return Type.Null();
        }
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return Type.Literal(value);
        }
        return panic("The TypeBox adapter requires primitive enum values");
      }),
      options,
    );
  }
  if (Array.isArray(schema.type)) {
    return unionOf(
      schema.type.map((type) => jsonSchemaToTypeBox({ ...schema, type })),
      options,
    );
  }
  if (schema.type === undefined) {
    return panic("The TypeBox adapter requires an explicit JSON schema type");
  }
  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required);
      const properties = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([name, definition]) => {
          const property = jsonSchemaToTypeBox(definition);
          return [
            name,
            required.has(name) ? property : Type.Optional(property),
          ];
        }),
      );
      return Type.Object(properties, options);
    }
    case "array":
      if (schema.items === undefined || Array.isArray(schema.items)) {
        return panic("The TypeBox adapter requires a homogeneous array schema");
      }
      return Type.Array(jsonSchemaToTypeBox(schema.items), options);
    case "string":
      return Type.String(options);
    case "number":
      return Type.Number(options);
    case "integer":
      return Type.Integer(options);
    case "boolean":
      return Type.Boolean(options);
    case "null":
      return Type.Null(options);
    default:
      return panic("The TypeBox adapter requires an explicit JSON schema type");
  }
};
