import { EventType } from "@tanstack/ai";
import type {
  AnyTextAdapter,
  ContentPart,
  ModelMessage,
  StreamChunk,
  TextPart,
  TokenUsage,
} from "@tanstack/ai";
import { panic } from "better-result";

import { isMockAI } from "@/api/consts";
import { registerTanStackMockTextAdapterFactory } from "@/api/lib/tanstack-ai-models";
import { generateBatchMock } from "@/api/lib/workflow/generate-batch-mock";
import { registerBatchGenerator } from "@/api/lib/workflow/generate-batch-provider";

// Dev/test-only preload: wired via the api `dev` script's `--preload`, never
// imported from `src/server.ts`. Registering the faker-backed mock generator here
// (rather than referencing it from the production handlers) keeps
// `generate-batch-mock` and `@faker-js/faker` out of the production build — both
// the compiled binary and the knip `--production` graph.

// The reply every mocked chat turn streams. It carries no "mock"/"stub"
// scaffolding prefix on purpose: the marketing captures film this text
// verbatim whenever a scene sends a live message, so it has to read like a
// plausible answer. Nothing asserts on the string — the chat specs key on the
// assistant message's rendered affordances (its Copy/Retry actions) instead,
// which is what actually proves a reply painted. `USE_MOCK_AI` remains the
// only signal that the model is stubbed.
const MOCK_REPLY =
  "Based on the documents in this workspace, the notice periods, governing " +
  "law, and liability caps are the provisions that differ most. Ask a " +
  "follow-up to open any of them at the cited passage.";

// A user message containing this marker makes the mock adapter stream its
// reply as many small delayed chunks instead of one instant chunk, giving an
// e2e spec a real streaming window to hold open (e.g. to type into the
// composer while a response is still arriving).
const E2E_SLOW_STREAM_MARKER = "Stream slowly please";

// A user message containing this marker makes the mock adapter finish the run
// with zero output — the shape of a real provider empty completion — so specs
// can exercise the server's ChatEmptyCompletionError path (stream-chat.ts) and
// the client's run-error handling deterministically.
const E2E_EMPTY_COMPLETION_MARKER = "Return an empty completion please";

const EMPTY_COMPLETION_DELAY_MS = 1500;

// A user message containing this marker makes the mock adapter answer with a
// `create-document` tool call (a client-executed tool), the shape of a real
// drafting turn: the run pauses at TanStack's native interrupt boundary, the
// chat client compiles the draft and posts the result back, and only the
// continuation run answers with text. This exercises the whole client-tool
// round trip (server persistence of the paused turn, the durable-turn claim,
// the resume continuation, and the inspector draft) deterministically.
const E2E_CREATE_DOCUMENT_MARKER = "Draft it as a document please";

const E2E_CREATE_DOCUMENT_TOOL_NAME = "create-document";
const E2E_CREATE_DOCUMENT_NAME = "Mutual NDA";
const E2E_CREATE_DOCUMENT_SOURCE =
  "@doc kind=agreement locale=en page=A4\n" +
  "@title MUTUAL NON-DISCLOSURE AGREEMENT\n" +
  "@clause Definition of Confidential Information\n" +
  "Confidential Information means any information disclosed by " +
  "[[Disclosing Party]] to [[Receiving Party]].\n" +
  "@signatures\nparty: [[Party A]]\nparty: [[Party B]]\n";
const E2E_CREATE_DOCUMENT_REPLY =
  "The draft is open in the panel. Placeholders left to fill: the parties " +
  "and the effective date.";

const SLOW_STREAM_REPLY =
  "This mock reply streams back in many small pieces instead of arriving all " +
  "at once, so an end to end test has a real window while the assistant is " +
  "still responding. Each small piece lands only after a short delay, giving " +
  "the interface time to re-render before the whole message finally finishes " +
  "and the run completes for the test to inspect.";

// Word-ish deltas (each chunk keeps its trailing whitespace so the deltas
// concatenate back into SLOW_STREAM_REPLY exactly).
const SLOW_STREAM_CHUNKS = SLOW_STREAM_REPLY.match(/\S+\s*/gu) ?? [
  SLOW_STREAM_REPLY,
];

const SLOW_STREAM_CHUNK_DELAY_MS = 100;

const mockUsage: TokenUsage = {
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
};

const isTextPart = (part: ContentPart): part is TextPart =>
  part.type === "text";

// Adapter-facing messages carry either a plain string or a content-part array
// (see ModelMessage in @tanstack/ai); flatten either shape down to the text
// the marker check cares about.
const getLatestUserText = (messages: ModelMessage[]): string => {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );

  if (!latestUserMessage) {
    return "";
  }

  const { content } = latestUserMessage;
  if (typeof content === "string") {
    return content;
  }

  if (content === null) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (isTextPart(part)) {
      textParts.push(part.content);
    }
  }
  return textParts.join("");
};

type MockCreateDocumentPhase = "call" | "reply" | null;

const resolveCreateDocumentPhase = ({
  latestUserText,
  messages,
}: {
  latestUserText: string;
  messages: ModelMessage[];
}): MockCreateDocumentPhase => {
  if (!latestUserText.includes(E2E_CREATE_DOCUMENT_MARKER)) {
    return null;
  }
  return messages.at(-1)?.role === "tool" ? "reply" : "call";
};

const createMockTextAdapter = (modelId: string): AnyTextAdapter => ({
  kind: "text",
  name: "mock",
  model: modelId,
  "~types": {
    providerOptions: {},
    inputModalities: ["text"],
    messageMetadataByModality: {},
    toolCapabilities: [],
    toolCallMetadata: {},
    systemPromptMetadata: undefined,
  },
  async *chatStream({ model, runId, threadId, messages }) {
    const resolvedRunId = runId ?? "mock-run";
    const resolvedThreadId = threadId ?? "mock-thread";
    const messageId = "mock-message";
    const timestamp = Date.now();
    const latestUserText = getLatestUserText(messages);
    const slowStream = latestUserText.includes(E2E_SLOW_STREAM_MARKER);
    // The continuation after the client posted the draft result ends with a
    // tool message; only the first turn of the marker prompt calls the tool.
    const createDocumentPhase = resolveCreateDocumentPhase({
      latestUserText,
      messages,
    });

    yield {
      type: EventType.RUN_STARTED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
    } satisfies StreamChunk;

    if (createDocumentPhase === "call") {
      yield {
        type: EventType.TEXT_MESSAGE_START,
        messageId,
        role: "assistant",
        model,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: "mock-create-document-call",
        toolCallName: E2E_CREATE_DOCUMENT_TOOL_NAME,
        parentMessageId: messageId,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "mock-create-document-call",
        delta: JSON.stringify({
          name: E2E_CREATE_DOCUMENT_NAME,
          source: E2E_CREATE_DOCUMENT_SOURCE,
        }),
        model,
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.TOOL_CALL_END,
        toolCallId: "mock-create-document-call",
        timestamp,
      } satisfies StreamChunk;
      yield {
        type: EventType.RUN_FINISHED,
        runId: resolvedRunId,
        threadId: resolvedThreadId,
        model,
        timestamp,
        finishReason: "tool_calls",
        usage: mockUsage,
      } satisfies StreamChunk;
      return;
    }

    if (latestUserText.includes(E2E_EMPTY_COMPLETION_MARKER)) {
      // Real providers return an empty completion only after a round-trip;
      // holding the run open briefly lets the destination surface mount and
      // render the streaming state before the terminal event arrives, which
      // is the window the incident's render loop lived in.
      await Bun.sleep(EMPTY_COMPLETION_DELAY_MS);
      yield {
        type: EventType.RUN_FINISHED,
        runId: resolvedRunId,
        threadId: resolvedThreadId,
        model,
        timestamp,
        finishReason: "stop",
        usage: mockUsage,
      } satisfies StreamChunk;
      return;
    }

    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
      model,
      timestamp,
    } satisfies StreamChunk;

    if (slowStream) {
      for (const delta of SLOW_STREAM_CHUNKS) {
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
          model,
          timestamp,
        } satisfies StreamChunk;
        await Bun.sleep(SLOW_STREAM_CHUNK_DELAY_MS);
      }
    } else {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta:
          createDocumentPhase === "reply"
            ? E2E_CREATE_DOCUMENT_REPLY
            : MOCK_REPLY,
        model,
        timestamp,
      } satisfies StreamChunk;
    }

    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
      model,
      timestamp,
    } satisfies StreamChunk;
    yield {
      type: EventType.RUN_FINISHED,
      runId: resolvedRunId,
      threadId: resolvedThreadId,
      model,
      timestamp,
      finishReason: "stop",
      usage: mockUsage,
    } satisfies StreamChunk;
  },
  structuredOutput: async ({ outputSchema }) => {
    await Promise.resolve();
    const data = mockStructuredData(outputSchema);
    return {
      data,
      rawText: JSON.stringify(data),
      usage: mockUsage,
    };
  },
});

// Two playbook structured-output features have curated fixtures below because
// their semantic *values* matter (a grade, a derived question) beyond mere
// schema validity. Every other structured-output caller falls through to
// `synthesizeJsonSchemaObject`, which walks the JSON schema TanStack hands the
// adapter (already converted from the caller's Valibot schema, see
// `generateTanStackObjectForRole` in tanstack-ai-generate.ts) and builds the
// minimal value that satisfies it. Returning `{}` here previously passed
// schema validation to the caller's `v.parse`, which throws on any missing
// required field — every new structured-output feature was born broken
// under the documented `USE_MOCK_AI=true` dev default.
// templates.prefill (apps/api/src/handlers/templates/prefill.ts), tmpl-supply
// only: the mapped-id answers the "Prefill from documents" panel expects.
// `buildPrefillTargets` (apps/api/src/handlers/templates/prefill-fields.ts)
// allocates f1..f16 over the merged manifest fields sorted ALPHABETICALLY BY
// PATH, not the manifest's own declaration order — verified by loading the
// seeded template's manifest and calling buildPrefillTargets against it
// directly (capacityHeadroomPercent, customerAddress, customerJurisdiction,
// customerName, date, deliveryLocation, deliveryTerms,
// includeLiquidatedDamages, includeStepInRights, liabilityCapPercent,
// startDate, supplierAddress, supplierJurisdiction, supplierName, termYears,
// terminationNoticeDays -> f1..f16 in that order). Every value and
// sourceSnippet below is frozen from a real extraction, hand-verified against
// the seeded Supplier_Agreement.docx body (the "Meridian supply agreement"
// matter, apps/api/scripts/seed-dev.ts) — never edit a value here without
// re-checking it against that document (and the id order above against
// buildPrefillTargets, if the manifest's field set ever changes), or the
// fixture drifts into fiction. deliveryLocation and includeStepInRights are
// null because the source document does not state either.
const TMPL_SUPPLY_PREFILL_FIXTURE: {
  id: string;
  value: string | null;
  sourceSnippet: string | null;
}[] = [
  {
    id: "f1", // capacityHeadroomPercent
    value: "120",
    sourceSnippet:
      "up to one hundred and twenty per cent (120%) of the most recent quarterly forecast volume",
  },
  {
    id: "f2", // customerAddress
    value: "548 Market Street, San Francisco, California 94104, United States",
    sourceSnippet:
      "offices at 548 Market Street, San Francisco, California 94104, United States",
  },
  {
    id: "f3", // customerJurisdiction
    value: "Delaware",
    sourceSnippet: "Northstar Robotics, Inc., a Delaware corporation",
  },
  {
    id: "f4", // customerName
    value: "Northstar Robotics, Inc.",
    sourceSnippet:
      "Northstar Robotics, Inc., a Delaware corporation with offices at 548 Market Street, San Francisco, California 94104, United States",
  },
  {
    id: "f5", // date
    value: "2026-07-01",
    sourceSnippet: "is entered into as of 1 July 2026 (the “Effective Date”)",
  },
  { id: "f6", value: null, sourceSnippet: null }, // deliveryLocation
  {
    id: "f7", // deliveryTerms
    value: "DAP (Incoterms 2020)",
    sourceSnippet:
      "The Supplier shall deliver the Products DAP (Incoterms 2020) to the Customer's facility identified in the Order.",
  },
  {
    id: "f8", // includeLiquidatedDamages
    value: "true",
    sourceSnippet:
      "the Customer is entitled to a delay credit of 0.5% of the Order value per commenced week of delay, up to 5% of the Order value",
  },
  { id: "f9", value: null, sourceSnippet: null }, // includeStepInRights
  {
    id: "f10", // liabilityCapPercent
    value: "100",
    sourceSnippet:
      "The Supplier's aggregate liability shall not exceed 100% of the annual fees paid under this Agreement.",
  },
  {
    id: "f11", // startDate
    value: "2026-07-01",
    sourceSnippet:
      "This Agreement starts on the Effective Date and continues for an initial term of three (3) years",
  },
  {
    id: "f12", // supplierAddress
    value: "Werkstrasse 12, 80339 Munich, Germany",
    sourceSnippet:
      "registered offices at Werkstrasse 12, 80339 Munich, Germany",
  },
  {
    id: "f13", // supplierJurisdiction
    value: "Germany",
    sourceSnippet: "organised under the laws of Germany",
  },
  {
    id: "f14", // supplierName
    value: "Meridian Precision Components GmbH",
    sourceSnippet:
      "Meridian Precision Components GmbH, a company organised under the laws of Germany with registered offices at Werkstrasse 12, 80339 Munich, Germany",
  },
  {
    id: "f15", // termYears
    value: "3",
    sourceSnippet:
      "continues for an initial term of three (3) years, renewing automatically for successive one (1) year periods",
  },
  {
    id: "f16", // terminationNoticeDays
    value: "30",
    sourceSnippet:
      "Either Party may terminate this Agreement for convenience by giving the other Party thirty (30) days' prior written notice.",
  },
];

export const mockStructuredData = (
  outputSchema: unknown,
): Record<string, unknown> => {
  const properties = jsonSchemaProperties(outputSchema);

  // playbook.verdict — tier-match. Return a plain "deviation" with no `matched`
  // so the object is valid regardless of whether the prompt listed fallbacks.
  if ("tier" in properties) {
    return { tier: "deviation", rationale: "Mock verdict." };
  }

  // playbook.derive-ask — question + content type.
  if ("question" in properties && "contentType" in properties) {
    return {
      question: "What does the contract say about this issue?",
      contentType: "text",
    };
  }

  // templates.prefill — tmpl-supply fixture (see comment above). Its values
  // are semantic source-document evidence, so generic schema synthesis cannot
  // produce a useful recording response.
  if ("fields" in properties) {
    return { fields: TMPL_SUPPLY_PREFILL_FIXTURE };
  }

  // contacts.extractProcuracao — outorgante candidates from an uploaded
  // procuração. Two fake rows so the review grid exercises multi-outorgante
  // rendering without needing a real provider key.
  if ("outorgantes" in properties) {
    return {
      outorgantes: [
        {
          nome: "Maria da Silva Souza",
          taxId: "123.456.789-09",
          rg: "12.345.678-9",
          nacionalidade: "brasileira",
          estadoCivil: "casada",
          uniaoEstavel: null,
          profissao: "empresária",
          email: null,
          endereco: "Rua das Flores, 123, São Paulo/SP",
          contactType: "person",
        },
        {
          nome: "João Pedro Souza",
          taxId: "987.654.321-00",
          rg: null,
          nacionalidade: "brasileiro",
          estadoCivil: "casado",
          uniaoEstavel: null,
          profissao: "engenheiro",
          email: null,
          endereco: "Rua das Flores, 123, São Paulo/SP",
          contactType: "person",
        },
      ],
    };
  }

  return synthesizeJsonSchemaObject(outputSchema);
};

const jsonSchemaProperties = (outputSchema: unknown): JsonSchemaNode => {
  if (
    !isJsonSchemaNode(outputSchema) ||
    !isJsonSchemaNode(outputSchema["properties"])
  ) {
    return {};
  }
  return outputSchema["properties"];
};

type JsonSchemaNode = Record<string, unknown>;

const isJsonSchemaNode = (value: unknown): value is JsonSchemaNode =>
  typeof value === "object" && value !== null;

// `Array.isArray` narrows an `unknown` argument to `any[]`, not `unknown[]`
// (a long-standing TypeScript lib.d.ts gap), which would otherwise leak `any`
// into every caller below.
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

// A branch list (`anyOf`/`oneOf`) that contains an explicit `{ type: "null" }`
// member is how Valibot's `v.nullable()` reaches the mock: a genuinely
// nullable, still-required field. Synthesizing `null` is always valid for it.
const hasExplicitNullBranch = (node: JsonSchemaNode): boolean => {
  const branches = node["anyOf"] ?? node["oneOf"];
  if (!isUnknownArray(branches)) {
    return false;
  }
  return branches.some(
    (branch) => isJsonSchemaNode(branch) && isNullOnlyType(branch["type"]),
  );
};

const isNullOnlyType = (type: unknown): boolean =>
  type === "null" || (isUnknownArray(type) && type.every((t) => t === "null"));

// A field is nullable to the mock through either of two encodings, depending
// on which provider the pipeline projected the schema for before handing it
// over (the mock runs under whatever provider `resolveProvider` picks, which
// defaults to Google when `AI_PROVIDER` is unset): an OpenAI-style `anyOf`
// null branch, or a Google-style `nullable: true` flag
// (provider-safe-json-schema.ts lowers null unions to `nullable`). Real
// structured-output schemas make nullable members `required` rather than
// optional (OpenAI strict output rejects optional properties), so `null` is
// the correct minimal value — and, unlike the `"string"` primitive, it also
// satisfies a nullable field that carries a format constraint (e.g. an ISO
// date), which a mock string would fail.
const isNullable = (node: JsonSchemaNode): boolean =>
  hasExplicitNullBranch(node) || node["nullable"] === true;

// TanStack's `forStructuredOutput` conversion (`convertSchemaForStructuredOutput`,
// applied to every schema before an adapter's `structuredOutput` sees it)
// widens originally-optional properties into `required` entries whose `type`
// gains a `"null"` member (e.g. `"string"` -> `["string", "null"]`), tracked in
// a `nullWideningMap` the caller uses to undo the widening once the real
// provider replies. The mock never receives that map, so this is the only
// signal left that a property was optional in the original Valibot schema:
// unlike `v.nullable()` (an `anyOf`/`oneOf` null branch, see above), the
// widening mutates `type` in place. Detecting it lets the synthesized object
// omit the key, matching what the original schema actually requires.
const isWidenedOptional = (node: JsonSchemaNode): boolean => {
  const type = node["type"];
  if (!isUnknownArray(type) || !type.includes("null")) {
    return false;
  }
  return (
    type.some((t) => t !== "null") &&
    node["anyOf"] === undefined &&
    node["oneOf"] === undefined
  );
};

const primaryType = (type: unknown): string | undefined => {
  if (typeof type === "string") {
    return type;
  }
  if (isUnknownArray(type)) {
    return type.find((t): t is string => typeof t === "string" && t !== "null");
  }
  return undefined;
};

const synthesisFailure = (node: unknown): never =>
  panic(
    "mock AI adapter cannot synthesise structured output for this schema; " +
      `add a fixture in register-mock-ai.ts (schema node: ${JSON.stringify(node)})`,
  );

// Generic JSON-schema-shaped value synthesis: walks `outputSchema` and builds
// the minimal value that satisfies it, so any structured-output caller — not
// just the two curated playbook fixtures above — gets a schema-valid mock
// response instead of `{}`.
const synthesizeJsonSchemaValue = (node: unknown): unknown => {
  if (!isJsonSchemaNode(node)) {
    return synthesisFailure(node);
  }

  if ("const" in node) {
    return node["const"];
  }

  if (isUnknownArray(node["enum"]) && node["enum"].length > 0) {
    return node["enum"][0];
  }

  if (isNullable(node)) {
    return null;
  }

  switch (primaryType(node["type"])) {
    case "object":
      return synthesizeJsonSchemaObject(node);
    case "array":
      return synthesizeJsonSchemaArray(node);
    case "string":
      return synthesizeJsonSchemaString(node);
    case "number":
    case "integer":
      return synthesizeJsonSchemaNumber(node);
    case "boolean":
      return false;
    case "null":
      return null;
    case undefined:
      return synthesisFailure(node);
    default:
      return synthesisFailure(node);
  }
};

const synthesizeJsonSchemaObject = (node: unknown): Record<string, unknown> => {
  if (!isJsonSchemaNode(node)) {
    return synthesisFailure(node);
  }

  const properties = isJsonSchemaNode(node["properties"])
    ? node["properties"]
    : {};
  const required = isUnknownArray(node["required"]) ? node["required"] : [];

  const result: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isJsonSchemaNode(propertySchema)) {
      continue;
    }
    if (isWidenedOptional(propertySchema)) {
      continue;
    }
    if (isNullable(propertySchema)) {
      result[key] = null;
      continue;
    }
    if (!required.includes(key)) {
      continue;
    }
    result[key] = synthesizeJsonSchemaValue(propertySchema);
  }
  return result;
};

const numberKeyword = (
  node: JsonSchemaNode,
  key: string,
): number | undefined =>
  typeof node[key] === "number" ? node[key] : undefined;

// The synthesized value has to satisfy the bounds the caller's own schema
// enforces, not just the declared type: a `v.minValue(1)` field that comes
// back as 0 fails the final `v.parse` exactly like a missing one would. A
// fractional bound on an integer field has to be pulled inwards to a whole
// number, or satisfying the bound would break the type instead.
const synthesizeJsonSchemaNumber = (node: JsonSchemaNode): number => {
  const isInteger = primaryType(node["type"]) === "integer";

  const minimum = numberKeyword(node, "minimum");
  if (minimum !== undefined) {
    return isInteger ? Math.ceil(minimum) : minimum;
  }

  const maximum = numberKeyword(node, "maximum");
  if (maximum === undefined || maximum >= 0) {
    return 0;
  }
  return isInteger ? Math.floor(maximum) : maximum;
};

const MOCK_STRING = "mock";

const synthesizeJsonSchemaString = (node: JsonSchemaNode): string => {
  const minLength = numberKeyword(node, "minLength") ?? 0;
  const maxLength = numberKeyword(node, "maxLength");
  if (maxLength !== undefined && maxLength < MOCK_STRING.length) {
    return MOCK_STRING.slice(0, Math.max(maxLength, minLength));
  }

  return minLength <= MOCK_STRING.length
    ? MOCK_STRING
    : MOCK_STRING.padEnd(minLength, "-");
};

const synthesizeJsonSchemaArray = (node: JsonSchemaNode): unknown[] => {
  const minItems = typeof node["minItems"] === "number" ? node["minItems"] : 0;
  if (minItems <= 0) {
    return [];
  }

  const itemsSchema = isUnknownArray(node["items"])
    ? node["items"].at(0)
    : node["items"];
  return Array.from({ length: minItems }, () =>
    synthesizeJsonSchemaValue(itemsSchema),
  );
};

if (isMockAI()) {
  registerBatchGenerator(generateBatchMock);
  registerTanStackMockTextAdapterFactory(createMockTextAdapter);
}
