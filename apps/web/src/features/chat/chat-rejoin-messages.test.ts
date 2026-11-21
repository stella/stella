import { ChatClient, fetchServerSentEvents } from "@tanstack/ai-client";
import type { UIMessage } from "@tanstack/ai-client";
import { panic } from "better-result";
import { expect, test } from "bun:test";

import {
  BROWSE_WEB_TOOL_NAME,
  BROWSER_CONTROL_CONTENT_TRUST,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BROWSER_CONTROL_TOOL_NAME,
  supersedeBrowserControlResult,
} from "@stll/api-contract/browser-control";
import type { BrowserControlResult } from "@stll/api-contract/browser-control";

import { keepShownRejoinMessages } from "./chat-rejoin-messages";

const message = (content: string): UIMessage => ({
  id: "answer",
  role: "assistant",
  parts: [{ type: "text", content }],
});

test("rejoined assistant prefixes never make already shown text disappear", () => {
  const text = "Clause café\nالعربية";
  const shown = [message(text)];
  expect(keepShownRejoinMessages(shown, [])).toEqual(shown);
  for (let length = 0; length <= text.length; length += 1) {
    const replay = [message(text.slice(0, length))];
    expect(keepShownRejoinMessages(shown, replay)).toEqual(shown);
  }
  const caughtUp = [message(`${text} continues`)];
  expect(keepShownRejoinMessages(shown, caughtUp)).toEqual(caughtUp);
});

test("replay retains tool, approval, user input and structured cards until their full part prefix catches up", () => {
  const shown: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        { type: "text", content: "Review ready" },
        {
          type: "tool-call",
          id: "approval",
          name: "save-draft",
          arguments: '{"title":"Terms"}',
          state: "approval-requested",
          approval: { id: "approval-save", needsApproval: true },
        },
        {
          type: "tool-call",
          id: "question",
          name: "ask-user",
          arguments: '{"question":"Which terms?"}',
          state: "input-complete",
        },
        {
          type: "structured-output",
          status: "streaming",
          raw: '{"title":"Ter',
          partial: { title: "Ter" },
        },
        {
          type: "tool-result",
          toolCallId: "prior",
          content: "Stored result",
          state: "complete",
        },
      ],
    },
  ];
  const assistant = shown.at(0);
  expect(assistant).toBeDefined();
  if (assistant === undefined) {
    return;
  }
  for (let count = 0; count < assistant.parts.length; count += 1) {
    const replay: UIMessage[] = [
      {
        id: "answer",
        role: "assistant",
        parts: assistant.parts.slice(0, count),
      },
    ];
    expect(keepShownRejoinMessages(shown, replay)).toEqual(shown);
  }
  const behind: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        { type: "text", content: "Review ready" },
        {
          type: "tool-call",
          id: "approval",
          name: "save-draft",
          arguments: '{"title":"Terms"}',
          state: "input-complete",
        },
        {
          type: "tool-call",
          id: "question",
          name: "ask-user",
          arguments: '{"question":',
          state: "input-streaming",
        },
        {
          type: "structured-output",
          status: "streaming",
          raw: '{"title":',
          partial: {},
        },
        {
          type: "tool-result",
          toolCallId: "prior",
          content: "Stored",
          state: "streaming",
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, behind)).toEqual(shown);
  const advanced: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        { type: "text", content: "Review ready" },
        {
          type: "tool-call",
          id: "approval",
          name: "save-draft",
          arguments: '{"title":"Terms"}',
          state: "complete",
          approval: {
            id: "approval-save",
            needsApproval: true,
            approved: true,
          },
          output: { saved: true },
        },
        {
          type: "tool-call",
          id: "question",
          name: "ask-user",
          arguments: '{"question":"Which terms?"}',
          state: "complete",
          output: { answer: "Standard terms" },
        },
        {
          type: "structured-output",
          status: "complete",
          raw: '{"title":"Terms"}',
          data: { title: "Terms" },
        },
        {
          type: "tool-result",
          toolCallId: "prior",
          content: "Stored result",
          state: "complete",
        },
        { type: "text", content: " Saved." },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, advanced)).toEqual(advanced);
});

test("an answered approval never returns to an earlier pending replay state", () => {
  const shown: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "approval",
          name: "save-draft",
          arguments: "{}",
          state: "approval-responded",
          approval: { id: "decision", needsApproval: true, approved: true },
        },
      ],
    },
  ];
  const pending: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "approval",
          name: "save-draft",
          arguments: "{}",
          state: "approval-requested",
          approval: { id: "decision", needsApproval: true },
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, pending)).toEqual(shown);
  expect(keepShownRejoinMessages(shown, shown)).toEqual(shown);
});

test("equal lifecycle states retain atomic payloads and advanced tools retain approval decisions", () => {
  const fixtures: UIMessage[] = [
    {
      id: "tool",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call",
          name: "save",
          arguments: "{}",
          state: "approval-responded",
          output: { saved: true },
          approval: { id: "decision", needsApproval: true, approved: true },
        },
      ],
    },
    {
      id: "structured",
      role: "assistant",
      parts: [
        {
          type: "structured-output",
          status: "complete",
          raw: "{}",
          data: { saved: true },
          partial: { saved: true },
        },
      ],
    },
  ];
  for (const fixture of fixtures) {
    const changed: UIMessage = {
      ...fixture,
      parts: fixture.parts.map((part) => {
        switch (part.type) {
          case "tool-call":
            return { ...part, state: "complete", output: { saved: false } };
          case "structured-output":
            return {
              type: "structured-output",
              status: "complete",
              raw: part.raw,
              data: { saved: false },
            };
          case "activity":
          case "audio":
          case "document":
          case "image":
          case "subagent":
          case "text":
          case "thinking":
          case "tool-result":
          case "ui-resource":
          case "video":
            return part;
          default:
            return panic(part satisfies never);
        }
      }),
    };
    expect(keepShownRejoinMessages([fixture], [changed])).toEqual([fixture]);
  }
});

test("native SDK final tool input catches up to equivalent canonical loader key ordering", async () => {
  const raw = '{ "title" : "Terms", "count" : 1 }';
  const input = { title: "Terms", count: 1 };
  const events = [
    { type: "RUN_STARTED", runId: "run-raw", threadId: "thread-raw" },
    { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "call",
      toolCallName: "save",
      parentMessageId: "answer",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: "call", delta: raw },
    {
      type: "TOOL_CALL_END",
      toolCallId: "call",
      metadata: { tanstack: { input } },
    },
    { type: "RUN_FINISHED", runId: "run-raw", threadId: "thread-raw" },
  ];
  const client = new ChatClient({
    threadId: "thread-raw",
    connection: fetchServerSentEvents("https://chat.test", {
      fetchClient: Object.assign(
        async () =>
          new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        { preconnect: () => undefined },
      ),
    }),
  });
  client.attach();
  await client.sendMessage("Save");
  const replayed = client
    .getMessages()
    .filter(({ role }) => role === "assistant");
  const part = replayed
    .at(0)
    ?.parts.find((candidate) => candidate.type === "tool-call");
  expect(part?.arguments).toBe(raw);
  expect(part?.input).toEqual(input);
  const shown: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call",
          name: "save",
          arguments: JSON.stringify(input),
          input: { count: 1, title: "Terms" },
          state: "input-complete",
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, replayed)).toEqual(replayed);
  client.detach();
});

test("rejoin retains shown activity payloads until the full snapshot matches", () => {
  const shown: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "activity",
          activityType: "review",
          content: { stage: "done" },
        },
      ],
    },
  ];
  const stale: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "activity",
          activityType: "review",
          content: { stage: "started" },
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, stale)).toEqual(shown);
  const equal = structuredClone(shown);
  expect(keepShownRejoinMessages(shown, equal)).toBe(equal);
  const differentType: UIMessage[] = [
    {
      id: "answer",
      role: "assistant",
      parts: [
        {
          type: "activity",
          activityType: "search",
          content: { stage: "done" },
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, differentType)).toEqual(shown);
});

test("standalone activity rows accept the SDK's replacement snapshot", () => {
  const shown: UIMessage[] = [
    {
      id: "progress",
      role: "activity",
      parts: [
        {
          type: "activity",
          activityType: "review",
          content: { stage: "started" },
        },
      ],
    },
  ];
  const replacement: UIMessage[] = [
    {
      id: "progress",
      role: "activity",
      parts: [
        {
          type: "activity",
          activityType: "review",
          content: { stage: "done" },
        },
      ],
    },
  ];
  expect(keepShownRejoinMessages(shown, replacement)).toBe(replacement);
});

const pageRead = (url: string) =>
  ({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    snapshot: {
      contentTrust: BROWSER_CONTROL_CONTENT_TRUST.untrustedWebContent,
      elements: [],
      elementsLeftOut: false,
      facts: { meta: [] },
      revision: "revision-1",
      tabId: 3,
      tabs: [{ active: true, tabId: 3, url }],
      text: "Opening hours: 8:00 to 16:00",
      title: "Registry",
      url,
      window: { cursor: "r1.window-1", fromPercent: 0, toPercent: 100 },
    },
    status: "success",
  }) satisfies BrowserControlResult;

/** A page read with its output on the call and on its result part. */
const browserReadParts = (output: unknown): UIMessage["parts"] => [
  {
    type: "tool-call",
    id: "read",
    name: BROWSER_CONTROL_TOOL_NAME,
    arguments: '{"action":"snapshot"}',
    input: { action: "snapshot" },
    state: "complete",
    output,
  },
  {
    type: "tool-result",
    toolCallId: "read",
    content: JSON.stringify(output),
    state: "complete",
  },
];

const inBrowsingRun = (parts: UIMessage["parts"]): UIMessage["parts"] => [
  {
    type: "subagent",
    subagent: {
      id: "run",
      name: BROWSE_WEB_TOOL_NAME,
      status: "finished",
      parentToolCallId: "browse",
      messages: [{ id: "run-answer", role: "assistant", parts }],
    },
  },
];

const answerWith = (parts: UIMessage["parts"]): UIMessage[] => [
  { id: "answer", role: "assistant", parts },
];

// The server stores and replays a page read a later read superseded as its
// declared projection, while the page still shows the read it ran.
test("a replayed page read that is the shown read's declared projection has caught up, at top level and inside a sub-agent run", () => {
  const shownOutput = pageRead("https://www.example.cz/hours");
  const projection = supersedeBrowserControlResult(shownOutput);
  expect(projection).not.toBeNull();
  expect(projection).not.toEqual(shownOutput);
  const otherPage = supersedeBrowserControlResult(
    pageRead("https://www.example.cz/fees"),
  );
  for (const wrap of [(parts: UIMessage["parts"]) => parts, inBrowsingRun]) {
    const shown = answerWith(wrap(browserReadParts(shownOutput)));
    const replayed = answerWith(wrap(browserReadParts(projection)));
    expect(keepShownRejoinMessages(shown, replayed)).toBe(replayed);
    // The projection of another page is not this read caught up.
    const other = answerWith(wrap(browserReadParts(otherPage)));
    expect(keepShownRejoinMessages(shown, other)).toEqual(shown);
  }
});

test("a projection catches up only for the tool that declares it", () => {
  const shownOutput = pageRead("https://www.example.cz/hours");
  const projection = supersedeBrowserControlResult(shownOutput);
  const renamed = (output: unknown): UIMessage["parts"] =>
    browserReadParts(output).map((part) =>
      part.type === "tool-call" ? { ...part, name: "read_page" } : part,
    );
  const shown = answerWith(renamed(shownOutput));
  expect(
    keepShownRejoinMessages(shown, answerWith(renamed(projection))),
  ).toEqual(shown);
});
