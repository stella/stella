import { Kind, TypeGuard, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Result } from "better-result";

import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ResponseIdentity = { route: string; status: number };
const failure = ({ route, status }: ResponseIdentity, issuePath: string) =>
  new ResponseConformanceError({
    route,
    status,
    issuePath,
    message: `Response conformance failed: ${route} status ${status} at ${issuePath}`,
  });

type SchemaReferences = {
  models?: Readonly<Record<string, unknown>> | undefined;
  references?: readonly TSchema[] | undefined;
};

const resolveSchema = (
  schema: unknown,
  identity: ResponseIdentity,
  { models, references = [] }: SchemaReferences,
): unknown => {
  let current = schema;
  const seen = new Set<unknown>();
  while (
    typeof current === "string" ||
    (TypeGuard.IsSchema(current) && current[Kind] === "Ref")
  ) {
    if (seen.has(current)) {
      throw failure(identity, "(schema)");
    }
    seen.add(current);
    if (typeof current === "string") {
      if (models === undefined || !Object.hasOwn(models, current)) {
        throw failure(identity, "(schema)");
      }
      current = models[current];
    } else if (TypeGuard.IsSchema(current)) {
      const reference: unknown = current["$ref"];
      current = references.find((candidate) => candidate.$id === reference);
    }
  }
  if (current === undefined || current === null) {
    throw failure(identity, "(schema)");
  }
  return current;
};

const collectReferences = ({ models, references = [] }: SchemaReferences) => [
  ...references,
  ...Object.values(models ?? {}).filter(TypeGuard.IsSchema),
];

const selectSchema = (
  schema: unknown,
  identity: ResponseIdentity,
  references: SchemaReferences,
) => {
  if (schema === undefined || schema === null) {
    return { type: "missing" } as const;
  }
  if (
    typeof schema === "string" ||
    TypeGuard.IsSchema(schema) ||
    (isRecord(schema) && "~standard" in schema)
  ) {
    if (identity.status !== 200) {
      throw failure(identity, "(status)");
    }
    return {
      type: "declared",
      schema: resolveSchema(schema, identity, references),
    } as const;
  }
  if (!isRecord(schema)) {
    throw failure(identity, "(schema)");
  }
  const keys = Object.keys(schema);
  if (
    keys.length === 0 ||
    !keys.every((key) => /^\d{3}$/u.test(key) || key === "default")
  ) {
    throw failure(identity, "(schema)");
  }
  const key = String(identity.status);
  if (!(key in schema) && !("default" in schema)) {
    throw failure(identity, "(status)");
  }
  return {
    type: "declared",
    schema: resolveSchema(
      key in schema ? schema[key] : schema["default"],
      identity,
      references,
    ),
  } as const;
};

const standardIssuePath = (issue: unknown): string => {
  if (!isRecord(issue) || !Array.isArray(issue["path"])) {
    return "(root)";
  }
  const segments: string[] = [];
  for (const segment of issue["path"]) {
    if (typeof segment === "string" || typeof segment === "number") {
      segments.push(String(segment));
    } else if (isRecord(segment)) {
      const key = segment["key"];
      if (typeof key === "string" || typeof key === "number") {
        segments.push(String(key));
      }
    }
  }
  return segments.length === 0 ? "(root)" : segments.join(".");
};

type ValidateValueOptions = ResponseIdentity & {
  schema: unknown;
  value: unknown;
  references: readonly TSchema[];
};
const validateValue = async ({
  schema,
  value,
  references,
  ...identity
}: ValidateValueOptions) => {
  if (TypeGuard.IsSchema(schema)) {
    const checked = Result.try(() => {
      if (Value.Check(schema, [...references], value)) {
        return undefined;
      }
      return (
        Value.Errors(schema, [...references], value).First()?.path || "(root)"
      );
    });
    if (Result.isError(checked)) {
      throw failure(identity, "(schema)");
    }
    if (checked.value !== undefined) {
      throw failure(identity, checked.value);
    }
    return;
  }
  if (!isRecord(schema)) {
    throw failure(identity, "(schema)");
  }
  const standard = schema["~standard"];
  if (!isRecord(standard) || typeof standard["validate"] !== "function") {
    throw failure(identity, "(schema)");
  }
  const validate = standard["validate"];
  const checked = await Result.tryPromise(async () => {
    const result: unknown = await Reflect.apply(validate, standard, [value]);
    return result;
  });
  if (Result.isError(checked) || !isRecord(checked.value)) {
    throw failure(identity, "(schema)");
  }
  const issues = checked.value["issues"];
  if (issues === undefined) {
    if (!("value" in checked.value)) {
      throw failure(identity, "(schema)");
    }
    return;
  }
  if (!Array.isArray(issues) || issues.length === 0) {
    throw failure(identity, "(schema)");
  }
  throw failure(identity, standardIssuePath(issues.at(0)));
};

type AssertResponseConformanceOptions = ResponseIdentity &
  SchemaReferences & { schema: unknown; value: unknown };
export const assertResponseConformance = async ({
  route,
  status,
  schema,
  value,
  models,
  references,
}: AssertResponseConformanceOptions): Promise<"missing" | "valid"> => {
  const resolvedReferences = collectReferences({ models, references });
  const selected = selectSchema(
    schema,
    { route, status },
    { models, references: resolvedReferences },
  );
  if (selected.type === "missing") {
    return "missing";
  }
  await validateValue({
    schema: selected.schema,
    value,
    route,
    status,
    references: resolvedReferences,
  });
  return "valid";
};

/** The response methods validation consumes, shared by Bun and undici clones. */
export type ConformanceHttpResponse = {
  status: number;
  headers: { get: (name: string) => string | null };
  blob: () => Promise<unknown>;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

type AssertHttpResponseConformanceOptions = SchemaReferences & {
  route: string;
  response: ConformanceHttpResponse;
  method: string;
  schema: unknown;
};

/** The observer supplies a clone; this helper owns only that clone's body. */
export const assertHttpResponseConformance = async ({
  route,
  response,
  method,
  schema,
  models,
  references,
}: AssertHttpResponseConformanceOptions): Promise<"missing" | "valid"> => {
  const identity = { route, status: response.status };
  const resolvedReferences = collectReferences({ models, references });
  const selected = selectSchema(schema, identity, {
    models,
    references: resolvedReferences,
  });
  if (selected.type === "missing") {
    return "missing";
  }
  const bodySchema = selected.schema;
  if (
    !TypeGuard.IsSchema(bodySchema) &&
    !(
      isRecord(bodySchema) &&
      isRecord(bodySchema["~standard"]) &&
      typeof bodySchema["~standard"]["validate"] === "function"
    )
  ) {
    throw failure(identity, "(schema)");
  }
  if (
    method.toUpperCase() === "HEAD" ||
    response.status === 204 ||
    response.status === 304
  ) {
    return "valid";
  }
  if (
    TypeGuard.IsSchema(bodySchema) &&
    (bodySchema[Kind] === "Any" || bodySchema[Kind] === "Unknown")
  ) {
    return "valid";
  }
  const contentType = response.headers
    .get("content-type")
    ?.split(";")
    .at(0)
    ?.trim()
    .toLowerCase();
  const jsonBody =
    contentType === "application/json" ||
    contentType?.endsWith("+json") === true;
  const body = await Result.tryPromise(async () => {
    if (TypeGuard.IsSchema(bodySchema) && bodySchema[Kind] === "File") {
      return await response.blob();
    }
    if (jsonBody) {
      const value: unknown = await response.json();
      return value;
    }
    return await response.text();
  });
  if (Result.isError(body)) {
    throw failure(identity, "(body)");
  }
  // Elysia sends numeric and boolean handler results as text/plain.
  // Preserve an accepted string before considering that encoding.
  if (!jsonBody && typeof body.value === "string") {
    const text = body.value;
    const original = await Result.tryPromise(async () => {
      await validateValue({
        schema: bodySchema,
        value: text,
        ...identity,
        references: resolvedReferences,
      });
    });
    if (Result.isOk(original)) {
      return "valid";
    }
    const originalIssue = original.error.cause;
    if (!ResponseConformanceError.is(originalIssue)) {
      throw failure(identity, "(schema)");
    }
    if (originalIssue.issuePath === "(schema)") {
      throw originalIssue;
    }
    const primitive = Result.try(() => {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    });
    if (
      Result.isError(primitive) ||
      (typeof primitive.value !== "number" &&
        typeof primitive.value !== "boolean")
    ) {
      throw originalIssue;
    }
    await validateValue({
      schema: bodySchema,
      value: primitive.value,
      ...identity,
      references: resolvedReferences,
    });
    return "valid";
  }
  await validateValue({
    schema: bodySchema,
    value: body.value,
    ...identity,
    references: resolvedReferences,
  });
  return "valid";
};
