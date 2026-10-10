import { expect, test } from "bun:test";

import type { WebRoutes } from "@/generated/api-routes.gen";

import {
  dockedChatFileThreadPage,
  dockedChatMessagePage,
  dockedChatSuggestedPrompts,
  dockedChatTemplateThread,
  dockedChatTitle,
} from "../../../e2e/helpers/docked-chat-history";

type ChatRoutes = WebRoutes["v1"]["chat"];
type ThreadRoutes = ChatRoutes["threads"][":threadId"];

// Check the actual browser fixtures here so the browser project need not
// instantiate the complete generated HTTP contract.
const history = {
  messages: dockedChatMessagePage,
  fileThread: dockedChatFileThreadPage,
  templateThread: dockedChatTemplateThread,
  suggestedPrompts: dockedChatSuggestedPrompts,
  title: dockedChatTitle,
} satisfies {
  messages: ThreadRoutes["messages"]["get"]["response"][200];
  fileThread: ChatRoutes["workspaces"][":workspaceId"]["file-thread"]["get"]["response"][200];
  templateThread: ChatRoutes["template-thread"]["post"]["response"][200];
  suggestedPrompts: ThreadRoutes["suggested-prompts"]["post"]["response"][200];
  title: ThreadRoutes["title"]["get"]["response"][200];
};

test("docked readers restore the same answered thread with no active turn", () => {
  expect(history.fileThread.threadId).toBe(history.templateThread.threadId);
  expect(history.fileThread.messages).toEqual(history.messages.messages);
  expect(history.messages.messages.length).toBeGreaterThan(0);
  expect(
    history.messages.messages.every((message) =>
      message.parts.some((part) => part.content.length > 0),
    ),
  ).toBe(true);
  expect(history.messages.activeTurnId).toBeNull();
  expect(history.messages.threadExists).toBe(true);
  const lastMessage = history.messages.messages.at(-1);
  if (lastMessage === undefined) {
    throw new Error("Docked chat history must contain an answer");
  }
  expect(history.messages.lastActivityAt).toBe(lastMessage.createdAt);
});
