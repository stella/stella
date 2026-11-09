import {
  convertMessagesToModelMessages,
  EventType,
  normalizeToolResult,
} from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_ERROR_CODE,
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TARGET_METADATA,
  BROWSER_CONTROL_TOOL_NAME,
  type BrowserControlResult,
  browserControlResultSchema,
  browserControlRetainedResultSchema,
  parseBrowserControlResult,
  supersedeBrowserControlResult,
  SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
} from "@stll/api-contract/browser-control";
import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import {
  chatMessageFromPersisted,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { clientVisibleStreamChunk } from "@/api/handlers/chat/client-visible-chat-part";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import {
  retainToolResultsForModel,
  supersededToolResultParts,
} from "@/api/handlers/chat/tool-result-retention";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";

const pageResult = (index: number): BrowserControlResult =>
  v.parse(browserControlResultSchema, {
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: Array.from({ length: 200 }, (_, element) => ({
        context: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: `Řádek ${element}`,
        },
        href: {
          type: BROWSER_CONTROL_TARGET_METADATA.present,
          value: `https://example.cz/${index}/${element}`,
        },
        name: `Odkaz ${index}.${element} ${"x".repeat(200)}`,
        ref: `e:0:${element}`,
        role: "link",
      })),
      revision: `rev-${index}`,
      tabId: 7,
      tabs: [{ active: true, tabId: 7, url: `https://example.cz/${index}` }],
      text: `Komentář k § 88 ${"ž".repeat(BROWSER_CONTROL_LIMITS.pageTextChars - 20)}`,
      textOffset: 0,
      textTotalChars: 120_000,
      title: `Page ${index}`,
      url: `https://example.cz/${index}`,
    },
    status: "success",
  });

const errorResult: BrowserControlResult = {
  code: BROWSER_CONTROL_ERROR_CODE.elementNotFound,
  message: "The element is gone",
  protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
  status: "error",
};

const call = (id: string, name: string): ModelMessage => ({
  content: null,
  role: "assistant",
  toolCalls: [{ function: { arguments: "{}", name }, id, type: "function" }],
});

// Built the way TanStack turns a client tool output into a model message.
const result = (id: string, output: unknown): ModelMessage => ({
  content: normalizeToolResult(output),
  role: "tool",
  toolCallId: id,
});

const browserStep = (id: string, output: BrowserControlResult) => [
  call(id, BROWSER_CONTROL_TOOL_NAME),
  result(id, output),
];

const user: ModelMessage = { content: "najdi komentář k § 88", role: "user" };

const textOf = (message: ModelMessage | undefined): string => {
  if (typeof message?.content !== "string") {
    throw new TypeError("Expected a text tool result");
  }
  return message.content;
};

const contentLength = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (total, message) => total + JSON.stringify(message.content).length,
    0,
  );

describe("retainToolResultsForModel", () => {
  test("keeps only the newest page whole and shrinks every earlier one", () => {
    const messages = [
      user,
      ...browserStep("a", pageResult(1)),
      ...browserStep("b", pageResult(2)),
      ...browserStep("c", pageResult(3)),
    ];

    const projected = retainToolResultsForModel(messages);

    expect(projected.at(-1)).toBe(messages.at(-1));
    for (const index of [2, 4]) {
      const stub: unknown = JSON.parse(textOf(projected[index]));
      expect(stub).toEqual({
        note: SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
        page: {
          contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
          tabId: 7,
          textTotalChars: 120_000,
          title: `Page ${index / 2}`,
          url: `https://example.cz/${index / 2}`,
        },
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
        status: "superseded",
      });
      expect(textOf(projected[index]).length).toBeLessThan(1000);
    }
    expect(projected.slice(0, 2)).toEqual(messages.slice(0, 2));
  });

  test("a browsing turn holds one page however many steps it takes", () => {
    const steps = (count: number) => [
      user,
      ...Array.from({ length: count }, (_, step) =>
        browserStep(`s${step}`, pageResult(step)),
      ).flat(),
    ];
    const onePage = contentLength(retainToolResultsForModel(steps(1)));

    for (const count of [2, 5, 20]) {
      const projected = contentLength(retainToolResultsForModel(steps(count)));
      expect(projected).toBeLessThan(onePage + count * 1000);
    }
  });

  test("an error after the newest page keeps that page whole", () => {
    const messages = [
      user,
      ...browserStep("a", pageResult(1)),
      ...browserStep("b", pageResult(2)),
      ...browserStep("c", errorResult),
    ];

    const projected = retainToolResultsForModel(messages);

    expect(projected[4]).toBe(messages[4]);
    expect(projected[6]).toBe(messages[6]);
    expect(JSON.parse(textOf(projected[2]))).toMatchObject({
      status: "superseded",
    });
  });

  test("leaves other tools, errors and unreadable results untouched", () => {
    const messages = [
      user,
      call("other", "search_case_law"),
      result("other", pageResult(1)),
      ...browserStep("err", errorResult),
      call("raw", BROWSER_CONTROL_TOOL_NAME),
      { content: "not json", role: "tool", toolCallId: "raw" } as const,
      ...browserStep("page", pageResult(2)),
    ];

    expect(retainToolResultsForModel(messages)).toBe(messages);
  });

  test("returns the same history when nothing is superseded", () => {
    const none = [user];
    const one = [user, ...browserStep("a", pageResult(1))];

    expect(retainToolResultsForModel(none)).toBe(none);
    expect(retainToolResultsForModel(one)).toBe(one);
  });

  test("a stored projection is never projected again", () => {
    const projection = supersedeBrowserControlResult(pageResult(1));

    expect(projection).not.toBeNull();
    expect(supersedeBrowserControlResult(projection)).toBeNull();
    expect(v.is(browserControlRetainedResultSchema, projection)).toBe(true);
    // The extension can never hand chat a projection as a page read.
    expect(parseBrowserControlResult(projection)).toBeNull();
  });
});

const browserCallPart = (
  id: string,
  output: BrowserControlResult,
): ChatPart => ({
  arguments: "{}",
  id,
  input: {},
  metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
  name: BROWSER_CONTROL_TOOL_NAME,
  output,
  state: "complete",
  type: "tool-call",
});

const browserResultPart = (
  id: string,
  output: BrowserControlResult,
): ChatPart => ({
  content: JSON.stringify(output),
  state: "complete",
  toolCallId: id,
  type: "tool-result",
});

// A turn as the browser holds it: each step's call and result part.
const browsingTurnParts = (pages: number): ChatPart[] =>
  Array.from({ length: pages }, (_, page) => [
    browserCallPart(`p${page}`, pageResult(page)),
    browserResultPart(`p${page}`, pageResult(page)),
  ]).flat();

const storedThread = (pages: number): ChatMessage[] => [
  {
    id: "request",
    parts: [{ content: "najdi komentář k § 88", type: "text" }],
    role: "user",
  },
  {
    id: "answer",
    parts: Array.from({ length: pages }, (_, page) =>
      browserCallPart(`p${page}`, pageResult(page)),
    ),
    role: "assistant",
  },
];

describe("supersededToolResultParts", () => {
  test("projects stored parts exactly as the model messages are projected", () => {
    const thread = storedThread(4);

    const superseded = supersededToolResultParts(thread);
    const fromModel = retainToolResultsForModel(
      convertMessagesToModelMessages(thread),
    );

    const stubbedIds = new Set<string>();
    for (const [part, projected] of superseded) {
      if (part.type !== "tool-call" || projected.type !== "tool-call") {
        throw new Error("Only tool calls are superseded");
      }
      stubbedIds.add(part.id);
      const modelResult = fromModel.find(
        (message) => message.role === "tool" && message.toolCallId === part.id,
      );
      expect(modelResult?.content).toBe(JSON.stringify(projected.output));
    }
    expect([...stubbedIds].toSorted()).toEqual(["p0", "p1", "p2"]);
  });

  test("the context meter counts one page however many the turn read", () => {
    const usage = (pages: number) =>
      computeThreadContextUsage({
        messages: storedThread(pages),
        summary: null,
      }).estimatedTokens;

    expect(usage(20)).toBeLessThan(usage(1) + 20 * 300);
  });

  test("supersedes nothing for a single page", () => {
    expect(supersededToolResultParts(storedThread(1)).size).toBe(0);
  });
});

const isRawPage = (output: unknown): boolean =>
  v.safeParse(browserControlResultSchema, output).success &&
  supersedeBrowserControlResult(output) !== null;

const pageOutputs = (parts: readonly unknown[]): unknown[] =>
  parts.flatMap((part) => {
    if (typeof part !== "object" || part === null || !("type" in part)) {
      return [];
    }
    if (part.type === "tool-call" && "output" in part) {
      return [part.output];
    }
    if (
      part.type === "tool-result" &&
      "content" in part &&
      typeof part.content === "string"
    ) {
      return [JSON.parse(part.content)];
    }
    return [];
  });

const storeAndReload = (parts: ChatPart[]): ChatMessage => {
  const id = toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda90");
  return chatMessageFromPersisted({
    content: toPersistedChatMessageContentV3({ data: parts }),
    id,
    role: "assistant",
  });
};

// The snapshot the SDK serializer builds for the answer: its parts, and a
// `tool` row beside them for every call that has an output.
const snapshotOf = (parts: ChatPart[]): StreamChunk =>
  buildWireSnapshot([{ id: "answer", parts, role: "assistant" }]);

describe("a browsing turn's stored and streamed parts", () => {
  test("store one page however many the turn read", () => {
    const parts = browsingTurnParts(6);
    // The fixture reaches the fault: every step carries a whole page.
    expect(pageOutputs(parts).filter(isRawPage)).toHaveLength(12);

    const stored = toPersistedChatMessageContentV3({ data: parts });
    const reloaded = storeAndReload(parts);

    const outputs = pageOutputs(reloaded.parts);
    expect(outputs).toHaveLength(12);
    // The newest page's call and result part stay whole; nothing else does.
    expect(outputs.filter(isRawPage)).toHaveLength(2);
    expect(outputs.slice(-2).every(isRawPage)).toBe(true);
    for (const output of outputs) {
      expect(v.is(browserControlRetainedResultSchema, output)).toBe(true);
    }
    const onePage = JSON.stringify(
      toPersistedChatMessageContentV3({ data: browsingTurnParts(1) }),
    ).length;
    expect(JSON.stringify(stored).length).toBeLessThan(onePage + 6 * 2000);
  });

  test("a stream snapshot carries what the message stores and reloads", () => {
    const parts = browsingTurnParts(4);

    const chunk = clientVisibleStreamChunk(snapshotOf(parts));
    if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
      throw new TypeError("Expected a messages snapshot");
    }
    const [streamed, ...toolMessages] = chunk.messages;
    const streamedParts: unknown =
      streamed !== undefined && "parts" in streamed ? streamed.parts : null;
    if (!Array.isArray(streamedParts)) {
      throw new TypeError("Expected the assistant message with its parts");
    }

    expect(pageOutputs(streamedParts)).toEqual(
      pageOutputs(storeAndReload(parts).parts),
    );
    // The engine's own `tool` rows beside the parts shrink the same way.
    expect(
      toolMessages.map((message) =>
        message.role === "tool" && typeof message.content === "string"
          ? isRawPage(JSON.parse(message.content))
          : null,
      ),
    ).toEqual([false, false, false, true]);
  });

  test("a snapshot with one page passes through unchanged", () => {
    const snapshot = snapshotOf(browsingTurnParts(1));

    expect(clientVisibleStreamChunk(snapshot)).toBe(snapshot);
  });
});
