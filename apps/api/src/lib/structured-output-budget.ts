import { Result, TaggedError } from "better-result";

import type { TanStackAIProvider } from "@stll/ai-catalog";

/**
 * What one structured-output request may put on the wire for a provider.
 *
 * Providers compile a strict output schema into a decoding grammar and reject
 * the request outright once that grammar is too large. The rejection is an
 * HTTP 400 from the provider, so it cannot be retried or recovered from: the
 * schema has to be smaller before it is sent.
 */
export type StructuredOutputBudget = {
  maxSchemaBytes: number;
  maxUnionParameters: number;
};

export const STRUCTURED_OUTPUT_BUDGETS = {
  // Measured 2026-09-02 against claude-sonnet-5 through the workflow batch
  // path: a 5726-byte projected schema was accepted, a 6668-byte one was
  // rejected with HTTP 400 "The compiled grammar is too large, which would
  // cause performance issues. Simplify your tool schemas or reduce the number
  // of strict tools." The byte cap sits under the largest accepted size.
  // The union cap is quoted by Anthropic's second rejection: "limit: 16
  // parameters with unions". Sharing sub-schemas through `$defs`/`$ref` does
  // not help; the grammar is compiled from the inlined schema either way.
  anthropic: { maxSchemaBytes: 5600, maxUnionParameters: 16 },
  // Documented: OpenAI's strict structured outputs allow 120 000 total
  // characters across the schema. 100_000 keeps headroom for request framing.
  // The union cap is a placeholder; OpenAI publishes no union-parameter limit.
  openai: { maxSchemaBytes: 100_000, maxUnionParameters: 1000 },
  // Placeholders. No schema-size or union limit is published for these
  // providers, so these values only stop a runaway schema rather than
  // encoding a known ceiling. An OpenRouter model id in particular resolves
  // to an arbitrary upstream (Anthropic included), so its placeholder can
  // under-constrain; tighten it from a measurement, not a guess.
  bedrock: { maxSchemaBytes: 100_000, maxUnionParameters: 1000 },
  google: { maxSchemaBytes: 100_000, maxUnionParameters: 1000 },
  mistral: { maxSchemaBytes: 100_000, maxUnionParameters: 1000 },
  openrouter: { maxSchemaBytes: 100_000, maxUnionParameters: 1000 },
} as const satisfies Record<TanStackAIProvider, StructuredOutputBudget>;

export type StructuredOutputMeasure = {
  bytes: number;
  unionParameters: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Anthropic counts a "parameter with a union type" as any schema node whose
// `type` is an array or that carries `anyOf`. `oneOf` is counted with it:
// the provider-safe projection can emit either, and both compile to a
// branching grammar node.
const isUnionNode = (node: Record<string, unknown>): boolean =>
  Array.isArray(node["type"]) ||
  node["anyOf"] !== undefined ||
  node["oneOf"] !== undefined;

const countUnionParameters = (node: unknown): number => {
  if (Array.isArray(node)) {
    return node.reduce<number>(
      (total, item) => total + countUnionParameters(item),
      0,
    );
  }
  if (!isRecord(node)) {
    return 0;
  }
  return Object.values(node).reduce<number>(
    (total, value) => total + countUnionParameters(value),
    isUnionNode(node) ? 1 : 0,
  );
};

/**
 * Measures a projected JSON schema the way the providers do: the serialized
 * size they compile, and the number of union-typed nodes anywhere in it.
 */
export const measureStructuredOutputSchema = (
  schema: unknown,
): StructuredOutputMeasure => {
  if (schema === undefined) {
    return { bytes: 0, unionParameters: 0 };
  }
  return {
    bytes: JSON.stringify(schema).length,
    unionParameters: countUnionParameters(schema),
  };
};

export class StructuredOutputBudgetError extends TaggedError(
  "StructuredOutputBudgetError",
)<{
  message: string;
  provider: TanStackAIProvider;
  measured: StructuredOutputMeasure;
  budget: StructuredOutputBudget;
}> {}

type CheckStructuredOutputBudgetOptions = {
  provider: TanStackAIProvider;
  schema: unknown;
};

export const checkStructuredOutputBudget = ({
  provider,
  schema,
}: CheckStructuredOutputBudgetOptions): Result<
  StructuredOutputMeasure,
  StructuredOutputBudgetError
> => {
  const budget = STRUCTURED_OUTPUT_BUDGETS[provider];
  const measured = measureStructuredOutputSchema(schema);

  const violations: string[] = [];
  if (measured.bytes > budget.maxSchemaBytes) {
    violations.push(
      `${measured.bytes} schema bytes over the ${budget.maxSchemaBytes} limit`,
    );
  }
  if (measured.unionParameters > budget.maxUnionParameters) {
    violations.push(
      `${measured.unionParameters} union parameters over the ${budget.maxUnionParameters} limit`,
    );
  }

  if (violations.length === 0) {
    return Result.ok(measured);
  }

  return Result.err(
    new StructuredOutputBudgetError({
      message: `Structured-output schema exceeds the ${provider} budget: ${violations.join("; ")}`,
      provider,
      measured,
      budget,
    }),
  );
};

type SplitPropertiesForBudgetOptions<TProperty> = {
  /** Projects the JSON schema a request carrying exactly these properties would send. */
  buildSchema: (properties: readonly TProperty[]) => unknown;
  properties: readonly TProperty[];
  provider: TanStackAIProvider;
};

/**
 * Partitions properties, in order, into the largest consecutive groups whose
 * schema still fits the provider budget. A single property that cannot fit
 * alone is an error: no split of the batch would make that request legal.
 */
export const splitPropertiesForBudget = <TProperty>({
  buildSchema,
  properties,
  provider,
}: SplitPropertiesForBudgetOptions<TProperty>): Result<
  TProperty[][],
  StructuredOutputBudgetError
> => {
  const chunks: TProperty[][] = [];
  let current: TProperty[] = [];

  for (const property of properties) {
    current.push(property);
    const withProperty = checkStructuredOutputBudget({
      provider,
      schema: buildSchema(current),
    });
    if (Result.isOk(withProperty)) {
      continue;
    }
    if (current.length === 1) {
      return Result.err(withProperty.error);
    }

    current.pop();
    chunks.push(current);
    current = [property];
    const alone = checkStructuredOutputBudget({
      provider,
      schema: buildSchema(current),
    });
    if (Result.isError(alone)) {
      return Result.err(alone.error);
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return Result.ok(chunks);
};
