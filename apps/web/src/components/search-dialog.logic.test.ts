import { describe, expect, test } from "bun:test";

import type { GlobalSearchHit } from "@stll/api/types";

import { getChatHitRoute } from "./search-dialog.logic";

type ChatGlobalSearchHit = Extract<GlobalSearchHit, { type: "chat" }>;

const chatHit = (
  overrides: Pick<ChatGlobalSearchHit, "threadId" | "workspaceId">,
): ChatGlobalSearchHit => ({
  id: `chat:${overrides.threadId}`,
  type: "chat",
  title: "Review privilege memo",
  headline: null,
  updatedAt: "2026-06-06T10:00:00.000Z",
  threadId: overrides.threadId,
  workspaceId: overrides.workspaceId,
  workspaceName: overrides.workspaceId ? "Matter Alpha" : null,
});

describe("search chat result routing", () => {
  test("opens global chat hits on the global chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-global", workspaceId: null }),
      ),
    ).toEqual({
      to: "/chat/$threadId",
      params: { threadId: "thread-global" },
    });
  });

  test("opens workspace chat hits on the workspace-scoped chat route", () => {
    expect(
      getChatHitRoute(
        chatHit({ threadId: "thread-workspace", workspaceId: "workspace-1" }),
      ),
    ).toEqual({
      to: "/chat/workspaces/$workspaceId/$threadId",
      params: { workspaceId: "workspace-1", threadId: "thread-workspace" },
    });
  });
});
