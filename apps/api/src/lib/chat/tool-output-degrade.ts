import { Result, TaggedError } from "better-result";
import * as v from "valibot";

import { declareFailureClass } from "@stll/errors";

import { captureError } from "@/api/lib/analytics/capture";
import { logger } from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Degraded parsing of a tool result against its output contract, shared by
 * the chat projection (`projectForChat`) and the MCP boundary
 * (`serializeToolResult`). A result that violates its contract ONLY because a
 * handler emitted keys a `strictObject` does not declare is not refused: the
 * undeclared keys are removed (schema-guided, at any depth: nested objects,
 * arrays, union/variant branches), the stripped copy is strict-parsed again,
 * and the defect is reported so the contract gets fixed. Any missing or
 * invalid DECLARED field still fails, because the stripped copy then fails
 * the same strict parse. The returned value is always the strict parse's
 * output, so it can never carry more than the contract allows.
 *
 * Keep this module's imports limited to `@/api/lib/*`, valibot, and
 * better-result: both `lib/chat` and `mcp` depend on it.
 */

const WRAPPER_TYPES = new Set([
  "optional",
  "exact_optional",
  "nullable",
  "nullish",
  "undefinedable",
  "non_optional",
  "non_nullable",
  "non_nullish",
]);

const OBJECT_TYPES = new Set([
  "object",
  "strict_object",
  "loose_object",
  "object_with_rest",
]);

const UNION_TYPES = new Set(["union", "variant"]);

const isSchemaNode = (value: unknown): value is v.GenericSchema =>
  isRecord(value) &&
  value["kind"] === "schema" &&
  typeof value["type"] === "string";

/** Append one path step in the `a.b` / `a[].b` grammar (arrays collapsed). */
const withKey = (segments: readonly string[], key: string): string[] => [
  ...segments,
  key,
];

const withArrayItem = (segments: readonly string[]): string[] => {
  const last = segments.at(-1);
  if (last === undefined) {
    return ["[]"];
  }
  return last.endsWith("[]")
    ? [...segments]
    : [...segments.slice(0, -1), `${last}[]`];
};

const joinPath = (segments: readonly string[]): string =>
  segments.length > 0 ? segments.join(".") : "(root)";

/**
 * A union/variant: keep the value untouched when some option already accepts
 * it, otherwise take the option that parses after removing the fewest
 * undeclared keys (so a wider option is never cut down to a narrower one). No
 * option parsing even after stripping leaves the value as is, for the final
 * strict parse to refuse.
 */
const stripUnion = (
  node: Record<string, unknown>,
  value: unknown,
  segments: readonly string[],
  removed: string[],
): unknown => {
  const options = node["options"];
  if (!Array.isArray(options)) {
    return value;
  }
  const schemas = options.filter(isSchemaNode);
  if (schemas.some((option) => v.safeParse(option, value).success)) {
    return value;
  }
  let best: { value: unknown; removed: string[] } | undefined;
  for (const option of schemas) {
    const optionRemoved: string[] = [];
    const candidate = stripNode(option, value, segments, optionRemoved);
    if (optionRemoved.length === 0 || !v.safeParse(option, candidate).success) {
      continue;
    }
    if (best === undefined || optionRemoved.length < best.removed.length) {
      best = { removed: optionRemoved, value: candidate };
    }
  }
  if (best === undefined) {
    return value;
  }
  removed.push(...best.removed);
  return best.value;
};

const stripObject = (
  node: Record<string, unknown>,
  value: Record<string, unknown>,
  segments: readonly string[],
  removed: string[],
): Record<string, unknown> => {
  const entries = node["entries"];
  if (!isRecord(entries)) {
    return value;
  }
  const strict = node["type"] === "strict_object";
  const rest = node["rest"];
  const kept: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    const childSegments = withKey(segments, key);
    if (Object.hasOwn(entries, key)) {
      kept.push([key, stripNode(entries[key], child, childSegments, removed)]);
    } else if (strict) {
      removed.push(joinPath(childSegments));
    } else if (isSchemaNode(rest)) {
      kept.push([key, stripNode(rest, child, childSegments, removed)]);
    } else {
      // A non-strict object: an unknown key is no contract violation; the
      // parse drops or keeps it per its own semantics.
      kept.push([key, child]);
    }
  }
  return Object.fromEntries(kept);
};

/**
 * Walk a schema node alongside a value, returning a copy without the keys a
 * `strictObject` does not declare and recording each removed key's path.
 * Unknown structure (a value that does not fit the node) is returned as is:
 * the walk only removes keys, it never repairs or guesses, and the strict
 * parse that follows remains the authority.
 */
// A function declaration: the walk is mutually recursive with `stripUnion`
// and `stripObject`, declared above it.
function stripNode(
  node: unknown,
  value: unknown,
  segments: readonly string[],
  removed: string[],
): unknown {
  if (!isRecord(node) || node["kind"] !== "schema") {
    return value;
  }
  const nodeType = node["type"];
  if (typeof nodeType !== "string") {
    return value;
  }
  if (WRAPPER_TYPES.has(nodeType)) {
    if (value === null || value === undefined) {
      return value;
    }
    return stripNode(node["wrapped"], value, segments, removed);
  }
  if (UNION_TYPES.has(nodeType)) {
    return stripUnion(node, value, segments, removed);
  }
  if (OBJECT_TYPES.has(nodeType)) {
    return isRecord(value)
      ? stripObject(node, value, segments, removed)
      : value;
  }
  if (nodeType === "array") {
    if (!Array.isArray(value)) {
      return value;
    }
    const itemSegments = withArrayItem(segments);
    return value.map((entry: unknown) =>
      stripNode(node["item"], entry, itemSegments, removed),
    );
  }
  if (nodeType === "record") {
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        stripNode(node["value"], child, withKey(segments, key), removed),
      ]),
    );
  }
  // Scalars, and schema kinds no tool contract uses (tuple, intersect,
  // lazy): nothing to strip, the strict parse decides.
  return value;
}

/** A successful (possibly degraded) contract parse. */
export type DegradedContractParse<TOutput> = {
  output: TOutput;
  /**
   * Paths (`a.b` / `a[].b`, never values) of the undeclared keys removed so
   * the result could satisfy its contract; empty when it parsed as returned.
   */
  undeclaredPaths: readonly string[];
};

/** The contract parse failed for a reason stripping cannot fix. */
export type ContractParseFailure = {
  issues: readonly v.BaseIssue<unknown>[];
};

/**
 * Strict-parse `value` against `schema`; when that fails, retry once on a
 * copy stripped of every undeclared `strictObject` key. Success after the
 * retry is the degrade case (`undeclaredPaths` non-empty); a retry that still
 * fails returns the ORIGINAL parse's issues, so the caller reports exactly
 * what it reported before this degrade existed.
 */
export const parseStrippingUndeclaredKeys = <TSchema extends v.GenericSchema>(
  schema: TSchema,
  value: unknown,
): Result<
  DegradedContractParse<v.InferOutput<TSchema>>,
  ContractParseFailure
> => {
  const parsed = v.safeParse(schema, value);
  if (parsed.success) {
    return Result.ok({ output: parsed.output, undeclaredPaths: [] });
  }
  const removed: string[] = [];
  const stripped = stripNode(schema, value, [], removed);
  if (removed.length === 0) {
    return Result.err({ issues: parsed.issues });
  }
  const reparsed = v.safeParse(schema, stripped);
  if (!reparsed.success) {
    return Result.err({ issues: parsed.issues });
  }
  return Result.ok({
    output: reparsed.output,
    undeclaredPaths: [...new Set(removed)],
  });
};

/**
 * A tool result reached its caller degraded: undeclared fields were stripped,
 * or (chat) a leaf carrying an unmappable internal id was dropped. The call
 * succeeded, so nothing else would surface the handler/contract drift; it is
 * a defect and reported at error level.
 */
class ToolOutputContractDegradedError extends TaggedError(
  "ToolOutputContractDegradedError",
)<{
  message: string;
}> {
  static {
    declareFailureClass(this, "response_invalid");
  }
}

export type ToolOutputDegradeDefect = "undeclared_fields" | "unmapped_id";

export type ToolOutputDegradeSource =
  | "mcp"
  | "run-registry-tool"
  | "run-registry-write-tool";

export const TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT =
  "tool_output.contract_degraded";

/**
 * Report a degraded tool result: an ERROR log line plus a captured exception,
 * both carrying the affected paths only. Never values: tool payloads carry
 * privileged matter content.
 */
export const reportToolOutputDegrade = ({
  defect,
  paths,
  source,
  toolName,
}: {
  defect: ToolOutputDegradeDefect;
  paths: readonly string[];
  source: ToolOutputDegradeSource;
  toolName: string;
}): void => {
  const joinedPaths = paths.join(", ");
  logger.error(TOOL_OUTPUT_CONTRACT_DEGRADED_EVENT, {
    defect,
    paths: joinedPaths,
    source,
    tool: toolName,
  });
  captureError(
    new ToolOutputContractDegradedError({
      message: `Tool output degraded (${defect}) at ${joinedPaths}`,
    }),
    { defect, paths: joinedPaths, source, toolName },
  );
};
