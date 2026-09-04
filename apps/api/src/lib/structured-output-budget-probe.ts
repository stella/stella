import { panic, Result } from "better-result";

import type { AiExtractablePropertyContent } from "@/api/db/schema-validators";
import { brandDerivedPropertyId } from "@/api/lib/safe-id-boundaries";
import {
  checkStructuredOutputBudget,
  resolveStructuredOutputBudget,
  type StructuredOutputMeasure,
  type StructuredOutputTarget,
} from "@/api/lib/structured-output-budget";
import { structuredOutputWireJsonSchema } from "@/api/lib/tanstack-ai-generate";
import { buildBatchSchema } from "@/api/lib/workflow/ai-prompts";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";

// A provider without a measured or documented ceiling (see `basis` on
// `StructuredOutputBudget`) carries a large placeholder so a runaway schema
// still gets rejected somewhere. Probing that placeholder's actual edge would
// mean sending a six-figure-byte schema on a guess every day; the probe caps
// there instead, at a size that is still "large enough to say the placeholder
// is not wildly wrong" without being sized on nothing.
const PLACEHOLDER_BUDGET_PROBE_MAX_BYTES = 20_000;

const BATCH_CONTENT_KINDS = [
  "text",
  "date",
  "int",
  "single-select",
  "multi-select",
] as const;
type BatchContentKind = (typeof BATCH_CONTENT_KINDS)[number];

const OPTION_VALUES = [
  "Delaware",
  "England and Wales",
  "New York",
  "California",
  "Singapore",
] as const;

const contentForKind = (
  kind: BatchContentKind,
): AiExtractablePropertyContent => {
  switch (kind) {
    case "text":
      return { version: 1, type: "text" };
    case "date":
      return { version: 1, type: "date" };
    case "int":
      return { version: 1, type: "int" };
    case "single-select":
    case "multi-select":
      return {
        version: 1,
        type: kind,
        options: OPTION_VALUES.map((value) => ({ color: "blue", value })),
        fallback: null,
      };
    default: {
      kind satisfies never;
      return panic(`Unhandled batch content kind: ${String(kind)}`);
    }
  }
};

// Cycles through every AI-extractable content kind so the probe schema
// matches a real mixed-type workflow batch rather than N copies of the
// cheapest shape.
const syntheticProperty = (index: number): AIBatchProperty => {
  const kind = BATCH_CONTENT_KINDS[index % BATCH_CONTENT_KINDS.length];
  if (kind === undefined) {
    return panic("BATCH_CONTENT_KINDS must not be empty.");
  }
  return {
    id: brandDerivedPropertyId(`budget-edge-probe-${index}`),
    status: "stale",
    content: contentForKind(kind),
    dependencies: [],
    tool: {
      version: 1,
      type: "ai-model",
      prompt: `Extract the ${kind} value for synthetic budget-edge field ${index}.`,
    },
  };
};

export type BudgetEdgeSchema = {
  /** The projected schema `checkStructuredOutputBudget` already confirmed fits. */
  outputSchema: ReturnType<typeof buildBatchSchema>;
  propertyCount: number;
  measured: StructuredOutputMeasure;
  budget: ReturnType<typeof resolveStructuredOutputBudget>["budget"];
  /** The provider whose grammar compiler the schema was sized against. */
  compiler: StructuredOutputTarget["provider"];
};

/**
 * Builds the largest workflow-batch-shaped structured-output schema that
 * still fits `target`'s resolved budget, one synthetic mixed-type property
 * at a time — the same shape `buildBatchSchema` sends in production, so the
 * edge this finds is the edge a real batch would hit.
 *
 * For a measured or documented budget (Anthropic, OpenAI) that edge sits
 * just under `maxSchemaBytes`. For a placeholder budget the edge is capped
 * at `PLACEHOLDER_BUDGET_PROBE_MAX_BYTES`: nothing is known about the real
 * ceiling, so the probe only needs to land somewhere reasonably large, not
 * find an exact number.
 *
 * Each property in this batch shape carries the full justification
 * sub-schema (~1.1-1.5 KB projected), so growth moves in coarse, per-property
 * steps. For Anthropic that means the byte edge binds at 4-5 properties,
 * carrying 5-6 union-typed `answer` fields — well under its 16-parameter
 * union cap, which this batch shape cannot reach without first breaking the
 * byte budget. The union cap still gets exercised (via
 * `checkStructuredOutputBudget` below); it just is not this probe's binding
 * constraint today.
 */
export const buildBudgetEdgeSchema = ({
  provider,
  modelId,
}: StructuredOutputTarget): BudgetEdgeSchema => {
  const { provider: compiler, budget } = resolveStructuredOutputBudget({
    provider,
    modelId,
  });
  const byteCeiling =
    budget.basis === "placeholder"
      ? Math.min(budget.maxSchemaBytes, PLACEHOLDER_BUDGET_PROBE_MAX_BYTES)
      : budget.maxSchemaBytes;

  let properties: AIBatchProperty[] = [];
  let accepted: {
    outputSchema: ReturnType<typeof buildBatchSchema>;
    measured: StructuredOutputMeasure;
  } | null = null;

  for (let index = 0; ; index += 1) {
    const candidateProperties = [...properties, syntheticProperty(index)];
    const outputSchema = buildBatchSchema(candidateProperties, []);
    const wireSchema = structuredOutputWireJsonSchema({
      outputSchema,
      provider,
    });
    const check = checkStructuredOutputBudget({
      provider,
      modelId,
      schema: wireSchema,
    });
    if (Result.isError(check) || check.value.bytes > byteCeiling) {
      break;
    }
    properties = candidateProperties;
    accepted = { outputSchema, measured: check.value };
  }

  // Unreachable for the current budgets: the first synthetic property alone
  // (~1.1-1.5 KB) fits under every provider's byte ceiling, placeholder cap
  // included. Guarded rather than assumed, so a budget tightened well below
  // that floor fails loudly here instead of returning an empty schema.
  if (accepted === null) {
    return panic(
      `No synthetic property fits the ${compiler} structured-output budget ` +
        `(${byteCeiling} bytes); the budget-edge probe cannot build a schema.`,
    );
  }

  return {
    outputSchema: accepted.outputSchema,
    propertyCount: properties.length,
    measured: accepted.measured,
    budget,
    compiler,
  };
};
