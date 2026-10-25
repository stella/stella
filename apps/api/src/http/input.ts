import type { StandardSchemaV1 } from "@standard-schema/spec";

import type {
  ApiValidationConstraint,
  ApiValidationIssue,
} from "@stll/api-contract";

import { HTTP_FAILURE, HttpFailureError } from "@/api/http/errors";
import { hasRequestBody } from "@/api/http/request-body";

/** Keys that would walk up the prototype chain if written onto an object. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** One rejected request answers with a bounded list of failing fields. */
const MAX_VALIDATION_ISSUES = 20;

type QueryValue = string | string[];
export type QueryRecord = Record<string, QueryValue>;

type FormValue = string | File;
type FormRecord = Record<string, FormValue | FormValue[]>;

/**
 * Flat key/value pairs to a record: values pass through untouched and a key
 * sent more than once collects into an array in wire order. Nested key syntax
 * (`a.b`, `a[0]`) is not expanded and nothing is JSON-parsed: a schema that
 * wants structure in a field says so with a transform.
 */
const collectEntries = <TValue>(
  entries: Iterable<[string, TValue]>,
): Record<string, TValue | TValue[]> => {
  const fields = new Map<string, TValue | TValue[]>();
  for (const [key, value] of entries) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    const existing = fields.get(key);
    if (existing === undefined) {
      fields.set(key, value);
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      fields.set(key, [existing, value]);
    }
  }
  return Object.fromEntries(fields);
};

export const parseQuery = (url: URL): QueryRecord =>
  collectEntries(url.searchParams.entries());

/** A request's form, as `Request.formData()` reads it. */
type RequestFormData = Awaited<ReturnType<Request["formData"]>>;

const parseForm = (form: RequestFormData): FormRecord =>
  collectEntries(form.entries());

/** How a route reads its body. */
export type BodyMode =
  /** By content type: JSON, text, url-encoded or multipart form, raw bytes; others unread. */
  | "auto"
  /** As text whatever the content type (signed webhooks verify the raw text). */
  | "text"
  /** Not at all: the handler reads `request` itself (auth handler, MCP transport). */
  | "none";

const mediaType = (request: Request): string =>
  (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase() ?? "";

const readJson = async (request: Request): Promise<unknown> => {
  const text = await request.text();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new HttpFailureError(HTTP_FAILURE.malformed, { cause: error });
  }
};

const readFormData = async (request: Request): Promise<RequestFormData> => {
  try {
    // oxlint-disable-next-line typescript/no-deprecated -- Bun parses the form natively, within Bun.serve's request body limit; the deprecation is undici's advice for its own parser
    return await request.formData();
  } catch (error) {
    throw new HttpFailureError(HTTP_FAILURE.malformed, { cause: error });
  }
};

export const readBody = async (
  request: Request,
  mode: BodyMode,
): Promise<unknown> => {
  if (mode === "none" || !hasRequestBody(request)) {
    return undefined;
  }
  if (mode === "text") {
    return await request.text();
  }
  const type = mediaType(request);
  if (type === "application/json" || type.endsWith("+json")) {
    return await readJson(request);
  }
  if (type === "multipart/form-data") {
    return parseForm(await readFormData(request));
  }
  if (type === "application/x-www-form-urlencoded") {
    return collectEntries(new URLSearchParams(await request.text()).entries());
  }
  if (type.startsWith("text/")) {
    return await request.text();
  }
  if (type === "application/octet-stream") {
    return await request.arrayBuffer();
  }
  // Another content type is not read: a route that needs one says how
  // (`bodyMode: "text"` for a signed token), and its schema decides the rest.
  return undefined;
};

type AnySchema = StandardSchemaV1;

const fieldOf = (issue: StandardSchemaV1.Issue): string =>
  (issue.path ?? [])
    .map((segment) =>
      String(typeof segment === "object" ? segment.key : segment),
    )
    .join(".");

/** A field of a validator's own issue, when the validator reports it. */
const issueDetail = (issue: StandardSchemaV1.Issue, key: string): unknown =>
  Object.hasOwn(issue, key) ? Reflect.get(issue, key) : undefined;

/**
 * Which constraint failed. A Standard Schema issue carries a message and a
 * path; the validator's own details (valibot reports the check `type`, its
 * numeric `requirement` and the `input`) refine it when present.
 */
const constraintOf = (
  issue: StandardSchemaV1.Issue,
): { constraint: ApiValidationConstraint; limit?: number } => {
  if (
    issueDetail(issue, "kind") === "schema" &&
    Object.hasOwn(issue, "input") &&
    issueDetail(issue, "input") === undefined
  ) {
    return { constraint: "required" };
  }
  const requirement = issueDetail(issue, "requirement");
  const limit = typeof requirement === "number" ? requirement : undefined;
  const type = issueDetail(issue, "type");
  if (type === "max_length" && limit !== undefined) {
    return { constraint: "maxLength", limit };
  }
  if (type === "min_length" && limit !== undefined) {
    return { constraint: "minLength", limit };
  }
  return { constraint: "invalid" };
};

/**
 * The failing fields of a rejected input, deduplicated, without the values
 * that failed.
 */
const validationIssues = (
  issues: readonly StandardSchemaV1.Issue[],
): ApiValidationIssue[] => {
  const seen = new Set<string>();
  const result: ApiValidationIssue[] = [];
  for (const issue of issues) {
    const answer = { field: fieldOf(issue), ...constraintOf(issue) };
    const key = `${answer.field}:${answer.constraint}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(answer);
    if (result.length === MAX_VALIDATION_ISSUES) {
      break;
    }
  }
  return result;
};

/** Validate one request slot; a rejection is the caller's 422. */
export const decodeRequestInput = async <TSchema extends AnySchema>(
  schema: TSchema,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> => {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new HttpFailureError(HTTP_FAILURE.invalidRequest, {
      issues: validationIssues(result.issues),
    });
  }
  return result.value;
};

/**
 * Validate a handler's answer against its declared response schema. The
 * validated output is what is sent, so undeclared fields never leave the
 * server; a mismatch is the handler's fault, answered 500.
 */
export const encodeResponseOutput = async <TSchema extends AnySchema>(
  schema: TSchema,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<TSchema>> => {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new HttpFailureError(HTTP_FAILURE.invalidResponse, {
      issues: validationIssues(result.issues),
    });
  }
  return result.value;
};
