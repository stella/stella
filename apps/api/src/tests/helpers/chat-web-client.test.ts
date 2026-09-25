import type { ToolCallState, UIMessage } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";

import { ASK_USER_TOOL_NAME } from "@/api/handlers/chat/tools/native-chat-tool-names";
import { APPROVAL_TOOL_NAME } from "@/api/tests/helpers/chat-approval-harness";
import { cardsOf, loadWebChat } from "@/api/tests/helpers/chat-web-client";

// `cardsOf` mirrors which parts the web app renders as cards the user can act
// on. These cases run it on the web app's own predicates, loaded from
// `apps/web`, so a change to what the web counts as an approval part or an
// unknown tool's stored call shows up here.

const STATES = [
  "approval-requested",
  "approval-responded",
  "awaiting-input",
  "complete",
  "error",
  "input-complete",
  "input-streaming",
] as const satisfies readonly ToolCallState[];

const assistant = (part: UIMessage["parts"][number]): UIMessage[] => [
  { id: "message-1", parts: [part], role: "assistant" },
];

const toolCall = ({
  approval,
  input,
  name,
  state,
}: {
  approval: boolean;
  input: Record<string, unknown> | undefined;
  name: string;
  state: ToolCallState;
}): UIMessage["parts"][number] => ({
  arguments: JSON.stringify(input ?? {}),
  id: "call-1",
  name,
  state,
  type: "tool-call",
  ...(input === undefined ? {} : { input }),
  ...(approval ? { approval: { id: "approval-1", needsApproval: true } } : {}),
});

describe("the live view's cards", () => {
  test("offer an approval card exactly while the web approval card asks", async () => {
    const web = await loadWebChat();
    const offered = STATES.filter(
      (state) =>
        cardsOf(
          web,
          assistant(
            toolCall({
              approval: true,
              input: { name: "NDA" },
              name: APPROVAL_TOOL_NAME,
              state,
            }),
          ),
        ).length > 0,
    );

    // The fixture must reach the fault: the web app counts this part as an
    // approval part.
    expect(
      web.isApprovalPart(
        toolCall({
          approval: true,
          input: { name: "NDA" },
          name: APPROVAL_TOOL_NAME,
          state: "approval-requested",
        }),
      ),
    ).toBe(true);
    expect(offered).toEqual(["approval-requested"]);
  });

  test("offer no approval card for a part the web app does not count as one", async () => {
    const web = await loadWebChat();
    const withoutApproval = toolCall({
      approval: false,
      input: { name: "NDA" },
      name: APPROVAL_TOOL_NAME,
      state: "approval-requested",
    });
    const unknownTool = toolCall({
      approval: true,
      input: {},
      name: "a_tool_the_web_app_does_not_know",
      state: "approval-requested",
    });

    expect(web.isApprovalPart(withoutApproval)).toBe(false);
    expect(web.isOpaquePersistedChatToolCallPart(unknownTool)).toBe(true);
    expect(cardsOf(web, assistant(withoutApproval))).toEqual([]);
    expect(cardsOf(web, assistant(unknownTool))).toEqual([]);
  });

  test("offer the ask-user form once its input has streamed and until it is answered", async () => {
    const web = await loadWebChat();
    const offered = STATES.filter(
      (state) =>
        cardsOf(
          web,
          assistant(
            toolCall({
              approval: false,
              input: { questions: [] },
              name: ASK_USER_TOOL_NAME,
              state,
            }),
          ),
        ).length > 0,
    );
    const withoutInput = toolCall({
      approval: false,
      input: undefined,
      name: ASK_USER_TOOL_NAME,
      state: "input-complete",
    });

    expect(offered).toEqual(
      STATES.filter(
        (state) => state !== "complete" && state !== "input-streaming",
      ),
    );
    expect(cardsOf(web, assistant(withoutInput))).toEqual([]);
  });
});
