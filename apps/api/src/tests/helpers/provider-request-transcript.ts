import type { ModelMessage } from "@tanstack/ai";

import { CHAT_ORACLE, violationsOf } from "@/api/tests/helpers/chat-oracles";
import type { OracleViolation } from "@/api/tests/helpers/chat-oracles";

// The transcript a provider is handed must be settled: a provider rejects a
// request whose tool calls and results do not pair up ("tool_use ids were
// found without tool_result blocks immediately after"), and one that moves a
// signed thinking block off the tool call it was produced with. The stored
// thread can be sound while the request built from it is not (a call the
// history keeps without its result, a result whose call was pruned), so these
// checks read the requests themselves: the message list the engine hands an
// adapter, or the body an adapter sends on the wire.
//
// Every format is reduced to one sequence of messages, and one rule set is
// held to all of them, the strictest the supported providers share:
// - a tool call id occurs once in a request;
// - every tool call is answered exactly once, by the results that follow the
//   message making it with nothing in between;
// - every result answers a call of the message right before it;
// - a message's thinking comes before its text and calls, and every thinking
//   block that must be signed carries its signature.

/** The wire formats the supported provider adapters send. */
export const PROVIDER_WIRE_FORMATS = [
  "anthropic-messages",
  "bedrock-converse",
  "gemini",
  "openai-chat",
  "openai-responses",
] as const;

export type ProviderWireFormat = (typeof PROVIDER_WIRE_FORMATS)[number];

/** What one model call produced: its signed thinking, in order, and the
 *  tool calls it made. */
export type ProducedStep = {
  signatures: readonly string[];
  toolCallIds: readonly string[];
};

/** A request as a provider receives it. */
export type ProviderRequest =
  | {
      /** The messages the engine hands the adapter. */
      format: "model-messages";
      messages: readonly ModelMessage[];
      /** What the thread's earlier model calls produced, in order. */
      earlierSteps: readonly ProducedStep[];
    }
  | {
      body: unknown;
      format: ProviderWireFormat;
      /** Per tool call id: the signature an earlier response of the
       *  conversation sent with the call, which a request replaying the call
       *  must send back with it (Gemini's `thoughtSignature`). */
      signedCalls?: ReadonlyMap<string, string>;
    };

/** A request message as pairing reads it. */
type Entry =
  | {
      /** The message's blocks in order, by what pairing needs of them. */
      blocks: readonly ("call" | "content" | "thinking")[];
      calls: readonly string[];
      /** The signatures of the message's signed thinking, in order. */
      signatures: readonly string[];
      /** Thinking blocks that need a signature and have none. */
      unsigned: number;
      role: "assistant";
      at: number;
    }
  | { results: readonly string[]; role: "results"; at: number }
  | { role: "other"; at: number };

type Finding = {
  message?: number;
  problem: string;
  toolCallId?: string;
};

type Projection = { entries: Entry[]; findings: Finding[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (value: unknown, key: string): string | null => {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  return typeof field === "string" ? field : null;
};

const arrayField = (value: unknown, key: string): unknown[] | null => {
  if (!isRecord(value)) {
    return null;
  }
  const field = value[key];
  return Array.isArray(field) ? field : null;
};

const unreadable = (at: number, what: string): Finding => ({
  message: at,
  problem: `the check cannot read ${what}`,
});

/** Builds an assistant entry from its blocks, in order. */
const assistantEntry = (
  at: number,
  blocks: readonly (
    | { id: string; type: "call" }
    | { signature: string | null; type: "thinking" }
    | { type: "content" }
    | { type: "unsigned-ok-thinking" }
  )[],
): Entry => ({
  at,
  blocks: blocks.map((block) =>
    block.type === "unsigned-ok-thinking" ? "thinking" : block.type,
  ),
  calls: blocks.flatMap((block) => (block.type === "call" ? [block.id] : [])),
  role: "assistant",
  signatures: blocks.flatMap((block) =>
    block.type === "thinking" && block.signature !== null
      ? [block.signature]
      : [],
  ),
  unsigned: blocks.filter(
    (block) =>
      block.type === "thinking" &&
      (block.signature === null || block.signature === ""),
  ).length,
});

// --- Projections, one per format -------------------------------------------

const projectModelMessages = (
  messages: readonly ModelMessage[],
): Projection => {
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  for (const [at, message] of messages.entries()) {
    switch (message.role) {
      case "user":
        entries.push({ at, role: "other" });
        continue;
      case "tool":
        if (message.toolCallId === undefined) {
          findings.push(unreadable(at, "a tool message with no call id"));
          continue;
        }
        entries.push({ at, results: [message.toolCallId], role: "results" });
        continue;
      case "assistant": {
        const hasContent =
          message.content !== null &&
          message.content !== "" &&
          !(Array.isArray(message.content) && message.content.length === 0);
        entries.push(
          assistantEntry(at, [
            // The adapters write an assistant message's thinking first, and
            // leave out thinking no provider signed (the Anthropic adapter
            // drops it; the others never send it back).
            ...(message.thinking ?? []).map((thinking) =>
              thinking.signature === undefined || thinking.signature === ""
                ? { type: "unsigned-ok-thinking" as const }
                : { signature: thinking.signature, type: "thinking" as const },
            ),
            ...(hasContent ? [{ type: "content" as const }] : []),
            ...(message.toolCalls ?? []).map((call) => ({
              id: call.id,
              type: "call" as const,
            })),
          ]),
        );
        continue;
      }
      default:
        message.role satisfies never;
    }
  }
  return { entries, findings };
};

const projectOpenAIChat = (body: unknown): Projection => {
  const messages = arrayField(body, "messages");
  if (messages === null) {
    return { entries: [], findings: [unreadable(-1, "the messages")] };
  }
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  for (const [at, message] of messages.entries()) {
    const role = stringField(message, "role");
    switch (role ?? "") {
      case "system":
      case "developer":
      case "user":
        entries.push({ at, role: "other" });
        continue;
      case "tool": {
        const id = stringField(message, "tool_call_id");
        if (id === null) {
          findings.push(unreadable(at, "a tool message with no call id"));
          continue;
        }
        entries.push({ at, results: [id], role: "results" });
        continue;
      }
      case "assistant": {
        const content: unknown = isRecord(message)
          ? message["content"]
          : undefined;
        const calls = arrayField(message, "tool_calls") ?? [];
        const ids = calls.map((call) => stringField(call, "id"));
        if (ids.includes(null)) {
          findings.push(unreadable(at, "a tool call with no id"));
        }
        entries.push(
          assistantEntry(at, [
            ...((typeof content === "string" && content !== "") ||
            (Array.isArray(content) && content.length > 0)
              ? [{ type: "content" as const }]
              : []),
            ...ids.flatMap((id) =>
              id === null ? [] : [{ id, type: "call" as const }],
            ),
          ]),
        );
        continue;
      }
      default:
        findings.push(unreadable(at, `a message with role ${String(role)}`));
    }
  }
  return { entries, findings };
};

/** A Responses input item that makes a tool call, or (`_output`) answers
 *  one. */
const RESPONSES_CALL_ITEM =
  /^(?:function|custom_tool|shell|local_shell|apply_patch)_call(?<output>_output|)$/u;

const projectOpenAIResponses = (body: unknown): Projection => {
  const input: unknown = isRecord(body) ? body["input"] : undefined;
  if (typeof input === "string") {
    return { entries: [{ at: 0, role: "other" }], findings: [] };
  }
  if (!Array.isArray(input)) {
    return { entries: [], findings: [unreadable(-1, "the input items")] };
  }
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  // Consecutive assistant-side items (reasoning, the assistant's text, its
  // function calls) are one assistant message; consecutive outputs answer it.
  type Block = Parameters<typeof assistantEntry>[1][number];
  let assistant: { at: number; blocks: Block[] } | null = null;
  const flush = () => {
    if (assistant !== null) {
      entries.push(assistantEntry(assistant.at, assistant.blocks));
      assistant = null;
    }
  };
  const addBlock = (at: number, block: Block) => {
    assistant ??= { at, blocks: [] };
    assistant.blocks.push(block);
  };
  for (const [at, item] of input.entries()) {
    const type = stringField(item, "type") ?? "message";
    // A user-executed tool's items (`shell_call`, `apply_patch_call`, ...)
    // pair by call id the way function calls do.
    const pairing = RESPONSES_CALL_ITEM.exec(type)?.groups?.["output"];
    if (pairing !== undefined) {
      const id = stringField(item, "call_id");
      if (id === null) {
        findings.push(unreadable(at, `a ${type} item with no call id`));
        continue;
      }
      if (pairing === "") {
        addBlock(at, { id, type: "call" });
        continue;
      }
      flush();
      entries.push({ at, results: [id], role: "results" });
      continue;
    }
    switch (type) {
      case "message": {
        if (stringField(item, "role") === "assistant") {
          addBlock(at, { type: "content" });
          continue;
        }
        flush();
        entries.push({ at, role: "other" });
        continue;
      }
      case "reasoning":
        // Its own item, paired with the items after it by id and encrypted
        // when replayed at all: the provider checks it, not its position in
        // a message.
        addBlock(at, { type: "content" });
        continue;
      default:
        flush();
        findings.push(unreadable(at, `an input item of type ${type}`));
    }
  }
  flush();
  return { entries, findings };
};

const projectAnthropic = (body: unknown): Projection => {
  const messages = arrayField(body, "messages");
  if (messages === null) {
    return { entries: [], findings: [unreadable(-1, "the messages")] };
  }
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  for (const [at, message] of messages.entries()) {
    const role = stringField(message, "role");
    const content: unknown = isRecord(message) ? message["content"] : null;
    const blocks = Array.isArray(content) ? content : null;
    if (role === "user") {
      // Tool results must open the message; anything before them breaks the
      // pairing, so blocks are read in order.
      let results: string[] = [];
      const flush = () => {
        if (results.length > 0) {
          entries.push({ at, results, role: "results" });
          results = [];
        }
      };
      if (blocks === null) {
        entries.push({ at, role: "other" });
        continue;
      }
      for (const block of blocks) {
        if (stringField(block, "type") === "tool_result") {
          const id = stringField(block, "tool_use_id");
          if (id === null) {
            findings.push(unreadable(at, "a tool result with no id"));
          } else {
            results.push(id);
          }
        } else {
          flush();
          entries.push({ at, role: "other" });
        }
      }
      flush();
      continue;
    }
    if (role !== "assistant") {
      findings.push(unreadable(at, `a message with role ${String(role)}`));
      continue;
    }
    if (blocks === null) {
      entries.push(assistantEntry(at, [{ type: "content" }]));
      continue;
    }
    entries.push(
      assistantEntry(
        at,
        blocks.map((block) => {
          switch (stringField(block, "type") ?? "") {
            case "thinking":
              return {
                signature: stringField(block, "signature"),
                type: "thinking" as const,
              };
            case "redacted_thinking":
              return { type: "unsigned-ok-thinking" as const };
            case "tool_use":
              return {
                id: stringField(block, "id") ?? "",
                type: "call" as const,
              };
            default:
              // Text, and a server tool's use and result, which the
              // provider pairs within the message.
              return { type: "content" as const };
          }
        }),
      ),
    );
  }
  return { entries, findings };
};

const projectBedrock = (body: unknown): Projection => {
  const messages = arrayField(body, "messages");
  if (messages === null) {
    return { entries: [], findings: [unreadable(-1, "the messages")] };
  }
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  for (const [at, message] of messages.entries()) {
    const role = stringField(message, "role");
    const blocks = arrayField(message, "content");
    if (blocks === null) {
      findings.push(unreadable(at, "a message's content blocks"));
      continue;
    }
    const kept = blocks.filter(
      (block) => !(isRecord(block) && "cachePoint" in block),
    );
    if (role === "user") {
      let results: string[] = [];
      const flush = () => {
        if (results.length > 0) {
          entries.push({ at, results, role: "results" });
          results = [];
        }
      };
      for (const block of kept) {
        const toolResult: unknown = isRecord(block)
          ? block["toolResult"]
          : undefined;
        if (toolResult === undefined) {
          flush();
          entries.push({ at, role: "other" });
          continue;
        }
        const id = stringField(toolResult, "toolUseId");
        if (id === null) {
          findings.push(unreadable(at, "a tool result with no id"));
        } else {
          results.push(id);
        }
      }
      flush();
      continue;
    }
    if (role !== "assistant") {
      findings.push(unreadable(at, `a message with role ${String(role)}`));
      continue;
    }
    entries.push(
      assistantEntry(
        at,
        kept.map((block) => {
          if (!isRecord(block)) {
            return { type: "content" as const };
          }
          if ("toolUse" in block) {
            return {
              id: stringField(block["toolUse"], "toolUseId") ?? "",
              type: "call" as const,
            };
          }
          if ("reasoningContent" in block) {
            const reasoning = block["reasoningContent"];
            if (isRecord(reasoning) && "redactedContent" in reasoning) {
              return { type: "unsigned-ok-thinking" as const };
            }
            return {
              signature: stringField(
                isRecord(reasoning) ? reasoning["reasoningText"] : null,
                "signature",
              ),
              type: "thinking" as const,
            };
          }
          return { type: "content" as const };
        }),
      ),
    );
  }
  return { entries, findings };
};

const projectGemini = (body: unknown): Projection => {
  const contents = arrayField(body, "contents");
  if (contents === null) {
    return { entries: [], findings: [unreadable(-1, "the contents")] };
  }
  const entries: Entry[] = [];
  const findings: Finding[] = [];
  // A call without an id is answered by position: the n-th response naming
  // a tool answers the n-th call of it in the model content before. A call's
  // stand-in id is unique across the request, and a response takes the id
  // of the call it answers by position, or one no call has.
  const callsSeen = new Map<string, number>();
  let lastCalls = new Map<string, string[]>();
  let unmatched = 0;
  const callIdOf = (part: unknown): string | null => {
    const id = stringField(part, "id");
    const name = stringField(part, "name");
    if (name === null) {
      return id;
    }
    const ordinal = (callsSeen.get(name) ?? 0) + 1;
    callsSeen.set(name, ordinal);
    const resolved = id ?? `${name}#${String(ordinal)}`;
    lastCalls.set(name, [...(lastCalls.get(name) ?? []), resolved]);
    return resolved;
  };
  const responseIdOf = (
    part: unknown,
    answered: Map<string, number>,
  ): string | null => {
    const id = stringField(part, "id");
    const name = stringField(part, "name");
    if (id !== null || name === null) {
      return id;
    }
    const position = answered.get(name) ?? 0;
    answered.set(name, position + 1);
    const call = lastCalls.get(name)?.[position];
    if (call !== undefined) {
      return call;
    }
    unmatched += 1;
    return `${name}#unmatched-${String(unmatched)}`;
  };
  for (const [at, content] of contents.entries()) {
    const role = stringField(content, "role");
    const parts = arrayField(content, "parts");
    if (parts === null) {
      findings.push(unreadable(at, "a content's parts"));
      continue;
    }
    if (role === "user" || role === "function") {
      const answered = new Map<string, number>();
      let results: string[] = [];
      const flush = () => {
        if (results.length > 0) {
          entries.push({ at, results, role: "results" });
          results = [];
        }
      };
      for (const part of parts) {
        const response: unknown = isRecord(part)
          ? part["functionResponse"]
          : undefined;
        if (response === undefined) {
          flush();
          entries.push({ at, role: "other" });
          continue;
        }
        const id = responseIdOf(response, answered);
        if (id === null) {
          findings.push(unreadable(at, "a function response with no name"));
        } else {
          results.push(id);
        }
      }
      flush();
      continue;
    }
    if (role !== "model") {
      findings.push(unreadable(at, `a content with role ${String(role)}`));
      continue;
    }
    const blocks: Parameters<typeof assistantEntry>[1][number][] = [];
    lastCalls = new Map();
    for (const part of parts) {
      const signature: unknown = isRecord(part)
        ? part["thoughtSignature"]
        : undefined;
      if (
        signature !== undefined &&
        (typeof signature !== "string" || signature === "")
      ) {
        findings.push({ message: at, problem: "a thought signature is empty" });
      }
      const call: unknown = isRecord(part) ? part["functionCall"] : undefined;
      if (call !== undefined) {
        const id = callIdOf(call);
        if (id === null) {
          findings.push(unreadable(at, "a function call with no name"));
        } else {
          blocks.push({ id, type: "call" });
        }
        continue;
      }
      // A thought part has no place of its own in the message: Gemini reads
      // the signature on the part it signs.
      blocks.push({ type: "content" });
    }
    entries.push(assistantEntry(at, blocks));
  }
  return { entries, findings };
};

const PROJECTIONS = {
  "anthropic-messages": projectAnthropic,
  "bedrock-converse": projectBedrock,
  gemini: projectGemini,
  "openai-chat": projectOpenAIChat,
  "openai-responses": projectOpenAIResponses,
} satisfies Record<ProviderWireFormat, (body: unknown) => Projection>;

// --- The rules ----------------------------------------------------------------

/** Tool calls and results pair up, one to one, with nothing between. */
const findPairingProblems = (entries: readonly Entry[]): Finding[] => {
  const findings: Finding[] = [];
  const seenCalls = new Set<string>();
  const answeredEntries = new Set<number>();
  for (const [index, entry] of entries.entries()) {
    if (entry.role === "results") {
      if (!answeredEntries.has(index)) {
        for (const toolCallId of entry.results) {
          findings.push({
            message: entry.at,
            problem: "a tool result follows no call of the message before it",
            toolCallId,
          });
        }
      }
      continue;
    }
    if (entry.role !== "assistant" || entry.calls.length === 0) {
      continue;
    }
    for (const toolCallId of entry.calls) {
      if (seenCalls.has(toolCallId)) {
        findings.push({
          message: entry.at,
          problem: "a tool call id repeats",
          toolCallId,
        });
      }
      seenCalls.add(toolCallId);
    }
    const answers: string[] = [];
    for (let next = index + 1; next < entries.length; next += 1) {
      const following = entries[next];
      if (following?.role !== "results") {
        break;
      }
      answeredEntries.add(next);
      answers.push(...following.results);
    }
    for (const toolCallId of entry.calls) {
      const count = answers.filter((answer) => answer === toolCallId).length;
      if (count !== 1) {
        findings.push({
          message: entry.at,
          problem:
            count === 0
              ? "a tool call has no result right after its message"
              : "a tool call has more than one result",
          toolCallId,
        });
      }
    }
    for (const toolCallId of new Set(answers)) {
      if (!entry.calls.includes(toolCallId)) {
        findings.push({
          message: entry.at,
          problem: "a tool result answers no call of the message before it",
          toolCallId,
        });
      }
    }
  }
  return findings;
};

/** A message's thinking opens it, and is signed where it must be. */
const findThinkingShapeProblems = (entries: readonly Entry[]): Finding[] =>
  entries.flatMap((entry): Finding[] => {
    if (entry.role !== "assistant") {
      return [];
    }
    const firstOther = entry.blocks.findIndex((block) => block !== "thinking");
    const lateThinking =
      firstOther !== -1 &&
      entry.blocks.slice(firstOther).some((block) => block === "thinking");
    return [
      ...(lateThinking
        ? [
            {
              message: entry.at,
              problem: "a thinking block follows the message's text or calls",
            },
          ]
        : []),
      ...(entry.unsigned > 0
        ? [{ message: entry.at, problem: "a thinking block has no signature" }]
        : []),
    ];
  });

/**
 * Each signed thinking block an earlier model call produced stays on the
 * message holding exactly the calls it was produced with, once, in the order
 * the thread produced it; a replayed call keeps the thinking produced with it.
 */
const findThinkingAttachmentProblems = (
  entries: readonly Entry[],
  earlierSteps: readonly ProducedStep[],
): Finding[] => {
  const findings: Finding[] = [];
  const stepOf = new Map<string, { order: number; step: ProducedStep }>();
  let order = 0;
  for (const step of earlierSteps) {
    for (const signature of step.signatures) {
      stepOf.set(signature, { order, step });
      order += 1;
    }
  }
  const assistants = entries.filter(
    (entry): entry is Extract<Entry, { role: "assistant" }> =>
      entry.role === "assistant",
  );
  const placed = new Set<string>();
  let lastOrder = -1;
  for (const entry of assistants) {
    for (const signature of entry.signatures) {
      const produced = stepOf.get(signature);
      if (produced === undefined) {
        continue;
      }
      if (placed.has(signature)) {
        findings.push({
          message: entry.at,
          problem: "a thinking block repeats",
        });
      }
      placed.add(signature);
      if (produced.order < lastOrder) {
        findings.push({
          message: entry.at,
          problem: "a thinking block comes before one produced ahead of it",
        });
      }
      lastOrder = Math.max(lastOrder, produced.order);
      const expected = produced.step.toolCallIds;
      if (
        entry.calls.length !== expected.length ||
        entry.calls.some((id, index) => expected[index] !== id)
      ) {
        findings.push({
          message: entry.at,
          problem:
            "a thinking block sits on another message than the calls it was produced with",
        });
      }
    }
  }
  const replayedCalls = new Set(assistants.flatMap((entry) => entry.calls));
  for (const step of earlierSteps) {
    const replayed = step.toolCallIds.find((id) => replayedCalls.has(id));
    for (const signature of step.signatures) {
      if (replayed !== undefined && !placed.has(signature)) {
        findings.push({
          problem: "a replayed tool call lost the thinking produced with it",
          toolCallId: replayed,
        });
      }
    }
  }
  return findings;
};

/**
 * Each call an earlier response sent with a signature carries it again
 * wherever the request replays the call: Gemini rejects a replayed call that
 * lost the signature it was produced with.
 */
const findDroppedGeminiSignatures = (
  body: unknown,
  signedCalls: ReadonlyMap<string, string>,
): Finding[] =>
  (arrayField(body, "contents") ?? []).flatMap((content, at) =>
    (arrayField(content, "parts") ?? []).flatMap((part): Finding[] => {
      const call: unknown = isRecord(part) ? part["functionCall"] : undefined;
      const id = stringField(call, "id");
      const produced = id === null ? undefined : signedCalls.get(id);
      if (
        id === null ||
        produced === undefined ||
        stringField(part, "thoughtSignature") === produced
      ) {
        return [];
      }
      return [
        {
          message: at,
          problem: "a replayed tool call lost the thinking produced with it",
          toolCallId: id,
        },
      ];
    }),
  );

/** The problems one request has, unlabeled. */
export const findTranscriptProblems = (request: ProviderRequest): Finding[] => {
  const { entries, findings } =
    request.format === "model-messages"
      ? projectModelMessages(request.messages)
      : PROJECTIONS[request.format](request.body);
  return [
    ...findings,
    ...findPairingProblems(entries),
    ...findThinkingShapeProblems(entries),
    ...(request.format === "model-messages"
      ? findThinkingAttachmentProblems(entries, request.earlierSteps)
      : []),
    ...(request.format === "gemini" && request.signedCalls !== undefined
      ? findDroppedGeminiSignatures(request.body, request.signedCalls)
      : []),
  ];
};

/**
 * `chat.provider.transcript-settled` findings for `requests`, each labeled
 * with the request's position and format.
 */
export const findTranscriptViolations = (
  requests: readonly ProviderRequest[],
): OracleViolation[] => {
  const findings: unknown[] = [];
  for (const [index, request] of requests.entries()) {
    for (const finding of findTranscriptProblems(request)) {
      findings.push({ format: request.format, request: index, ...finding });
    }
  }
  return violationsOf(CHAT_ORACLE.providerTranscriptSettled, findings);
};

/**
 * Per tool call id, the `thoughtSignature` a Gemini answer (its streamed
 * `data:` events) sent with the call, which the request replaying the call
 * must send back.
 */
export const signedGeminiCallsOf = (answer: string): [string, string][] => {
  const signed: [string, string][] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value) && !isRecord(value)) {
      return;
    }
    const id = isRecord(value)
      ? stringField(value["functionCall"], "id")
      : null;
    const signature = stringField(value, "thoughtSignature");
    if (id !== null && signature !== null) {
      signed.push([id, signature]);
    }
    for (const child of Object.values(value)) {
      visit(child);
    }
  };
  for (const line of answer.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    try {
      visit(JSON.parse(line.slice("data:".length)));
    } catch {
      // Not a JSON event: nothing signed in it.
    }
  }
  return signed;
};

/** The wire format a provider request to `url` is in, or null for a request
 *  that carries no transcript (a model listing, a token count). */
export const providerWireFormatOf = (url: URL): ProviderWireFormat | null => {
  const { hostname, pathname } = url;
  if (hostname === "api.anthropic.com") {
    return pathname === "/v1/messages" ? "anthropic-messages" : null;
  }
  if (hostname.startsWith("bedrock-runtime.")) {
    return /\/converse(?:-stream)?$/u.test(pathname)
      ? "bedrock-converse"
      : null;
  }
  if (hostname === "generativelanguage.googleapis.com") {
    return /:(?:stream)?[gG]enerateContent$/u.test(pathname) ? "gemini" : null;
  }
  if (pathname.endsWith("/chat/completions")) {
    return "openai-chat";
  }
  if (pathname.endsWith("/responses")) {
    return "openai-responses";
  }
  return null;
};
