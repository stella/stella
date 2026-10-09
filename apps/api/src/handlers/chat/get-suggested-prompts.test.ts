import { panic } from "better-result";
import { describe, expect, mock, spyOn, test } from "bun:test";

import { env } from "@/api/env";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import * as textGeneration from "@/api/lib/tanstack-ai-generate";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedDbMock,
  createSelectQueryMock,
} from "@/api/tests/scoped-db-mock";

import getSuggestedPrompts, {
  cleanSuggestionsText,
  latestAssistantTurnAwaitsUser,
} from "./get-suggested-prompts";

const testState = createTestState({ file: import.meta.path, config: env });

describe("suggested prompts usage metering", () => {
  test("does not run static usage preflight before no-op fallbacks", () => {
    expect("requiresUsage" in getSuggestedPrompts.config).toBe(false);
  });
});

describe("suggested prompts turn ownership", () => {
  test("blocks follow-ups while the latest ask-user call awaits an answer", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: '{"question":"Which jurisdiction?"}',
              id: "ask-1",
              name: "ask-user",
              state: "input-complete",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(true);
  });

  test("allows follow-ups after the clarification has been answered", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: '{"question":"Which jurisdiction?"}',
              id: "ask-1",
              name: "ask-user",
              state: "complete",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(false);
  });

  test("blocks follow-ups while any tool awaits approval", () => {
    expect(
      latestAssistantTurnAwaitsUser([
        {
          parts: [
            {
              arguments: "{}",
              id: "approval-1",
              name: "save_matter",
              state: "approval-requested",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ]),
    ).toBe(true);
  });
});

describe("cleanSuggestionsText", () => {
  test("extracts clean prompts from plain lines", () => {
    const text =
      "What are the key risks?\nCan you draft a response?\nExplain the governing law section.";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law section.",
    ]);
  });

  test("strips list markers and numbers", () => {
    const text =
      "1. What are the key risks?\n2. Can you draft a response?\n- Explain the governing law.";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law.",
    ]);
  });

  test("strips surrounding quotes and bullet points", () => {
    const text = `"What are the key risks?"\n- Can you draft a response?\n(Explain the governing law.)`;

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
      "Explain the governing law.",
    ]);
  });

  test("trims whitespace and filters empty lines", () => {
    const text =
      "  What are the key risks?  \n\n   \n  Can you draft a response?  ";

    expect(cleanSuggestionsText(text)).toEqual([
      "What are the key risks?",
      "Can you draft a response?",
    ]);
  });

  test("limits to 4 prompts", () => {
    const text =
      "First prompt?\nSecond prompt?\nThird prompt?\nFourth prompt?\nFifth prompt?";

    expect(cleanSuggestionsText(text)).toEqual([
      "First prompt?",
      "Second prompt?",
      "Third prompt?",
      "Fourth prompt?",
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(cleanSuggestionsText("")).toEqual([]);
  });

  test("handles lines with only whitespace or markers", () => {
    const text = "-   \n1.   \n   ";

    expect(cleanSuggestionsText(text)).toEqual([]);
  });

  test("preserves prompts that start with digits", () => {
    const text = "3D print analysis?\n2nd amendment summary?";

    expect(cleanSuggestionsText(text)).toEqual([
      "3D print analysis?",
      "2nd amendment summary?",
    ]);
  });
});

test("suggested prompts usage refusal calls no model and persists nothing", async () => {
  const organizationId = toSafeId<"organization">("org_prompts_refused");
  const userId = toSafeId<"user">("user_prompts_refused");
  const threadId = toSafeId<"chatThread">("thread_prompts_refused");
  let entitlementReads = 0;
  let threadReads = 0;
  let messageReads = 0;
  const persist = mock(() =>
    panic("Refused suggestions attempted persistence"),
  );
  const db = createScopedDbMock({
    query: {
      chatThreads: {
        findFirst: async () => {
          threadReads += 1;
          return {
            workspaceId: null,
            usedAnonymization: false,
            turns: [{ status: "completed" }],
          };
        },
      },
      chatMessages: {
        findMany: async () => {
          messageReads += 1;
          return [
            {
              id: "message_prompts_refused",
              role: "user",
              createdAt: new Date("2026-09-01T00:00:00Z"),
              content: {
                version: 2,
                data: [{ type: "text", content: "Draft a document" }],
              },
            },
          ];
        },
      },
    },
    select: (fields: Record<string, unknown>) => {
      if ("usedAnonymization" in fields) {
        return createSelectQueryMock([{ usedAnonymization: false }]);
      }
      entitlementReads += 1;
      return createSelectQueryMock([]);
    },
    insert: persist,
    update: persist,
    delete: persist,
    execute: persist,
  });
  const generator = spyOn(
    textGeneration,
    "generateTanStackTextForRole",
  ).mockResolvedValue("Draft a response.");
  testState.setConfig("USAGE_ENFORCEMENT_ENABLED", true);
  testState.setConfig("AI_PROVIDER", "openrouter");
  testState.setConfig("OPENROUTER_API_KEY", "fixture-instance-key");
  testState.setConfig("REQUIRE_PERSONAL_AI_KEY", false);
  try {
    const result = await getSuggestedPrompts.handler(
      asTestRaw({
        getWorkspaceAccess: async () => null,
        memberRole: sessionMemberRole("owner"),
        orgAIConfig: null,
        orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
        managedAIResidency: "eu" as const,
        params: { threadId },
        promptCachingEnabled: false,
        query: {},
        request: new Request("https://example.test/prompts"),
        route: "/prompts",
        safeDb: db.safeDb,
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
      }),
    );
    expect(result).toMatchObject({
      code: 402,
      response: {
        code: "usage_limit_exceeded",
        reason: "no_entitlement",
        available: 0,
      },
    });
    expect(entitlementReads).toBe(1);
    expect(threadReads).toBe(1);
    expect(messageReads).toBe(2);
    expect(generator).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  } finally {
    generator.mockRestore();
  }
});
