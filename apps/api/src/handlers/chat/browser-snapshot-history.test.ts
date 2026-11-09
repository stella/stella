import {
  convertMessagesToModelMessages,
  normalizeToolResult,
} from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
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
} from "@stll/api-contract/browser-control";

import {
  supersedeBrowserSnapshots,
  SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
  supersededBrowserParts,
} from "@/api/handlers/chat/browser-snapshot-history";
import { computeThreadContextUsage } from "@/api/handlers/chat/compaction";
import type { ChatMessage, ChatPart } from "@/api/handlers/chat/types";

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

const contentLength = (messages: readonly ModelMessage[]) =>
  messages.reduce(
    (total, message) => total + JSON.stringify(message.content).length,
    0,
  );

describe("supersedeBrowserSnapshots", () => {
  test("keeps only the newest page whole and shrinks every earlier one", () => {
    const messages = [
      user,
      ...browserStep("a", pageResult(1)),
      ...browserStep("b", pageResult(2)),
      ...browserStep("c", pageResult(3)),
    ];

    const projected = supersedeBrowserSnapshots(messages);

    expect(projected.at(-1)).toBe(messages.at(-1));
    for (const index of [2, 4]) {
      const stub: unknown = JSON.parse(String(projected[index]?.content));
      expect(stub).toMatchObject({
        note: SUPERSEDED_BROWSER_SNAPSHOT_NOTE,
        page: {
          title: `Page ${index / 2}`,
          url: `https://example.cz/${index / 2}`,
        },
        status: "success",
        superseded: true,
      });
      expect(String(projected[index]?.content).length).toBeLessThan(1000);
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
    const onePage = contentLength(supersedeBrowserSnapshots(steps(1)));

    for (const count of [2, 5, 20]) {
      const projected = contentLength(supersedeBrowserSnapshots(steps(count)));
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

    const projected = supersedeBrowserSnapshots(messages);

    expect(projected[4]).toBe(messages[4]);
    expect(projected[6]).toBe(messages[6]);
    expect(JSON.parse(String(projected[2]?.content))).toMatchObject({
      superseded: true,
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

    expect(supersedeBrowserSnapshots(messages)).toBe(messages);
  });

  test("returns the same history when nothing is superseded", () => {
    const none = [user];
    const one = [user, ...browserStep("a", pageResult(1))];

    expect(supersedeBrowserSnapshots(none)).toBe(none);
    expect(supersedeBrowserSnapshots(one)).toBe(one);
  });
});

const browserPart = (id: string, output: BrowserControlResult): ChatPart => ({
  arguments: "{}",
  id,
  input: {},
  name: BROWSER_CONTROL_TOOL_NAME,
  output,
  state: "complete",
  type: "tool-call",
});

const storedThread = (pages: number): ChatMessage[] => [
  {
    id: "request",
    parts: [{ content: "najdi komentář k § 88", type: "text" }],
    role: "user",
  },
  {
    id: "answer",
    parts: Array.from({ length: pages }, (_, page) =>
      browserPart(`p${page}`, pageResult(page)),
    ),
    role: "assistant",
  },
];

describe("supersededBrowserParts", () => {
  test("stubs stored parts exactly as the model messages are stubbed", () => {
    const thread = storedThread(4);

    const superseded = supersededBrowserParts(thread);
    const fromModel = supersedeBrowserSnapshots(
      convertMessagesToModelMessages(thread),
    );

    const stubbedIds = new Set<string>();
    for (const [part, stub] of superseded) {
      if (part.type !== "tool-call") {
        throw new Error("Only tool calls are superseded");
      }
      stubbedIds.add(part.id);
      const modelResult = fromModel.find(
        (message) => message.role === "tool" && message.toolCallId === part.id,
      );
      expect(modelResult?.content).toBe(JSON.stringify(stub));
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
    expect(supersededBrowserParts(storedThread(1)).size).toBe(0);
  });
});
