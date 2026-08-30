import { describe, expect, test } from "bun:test";

import { OUTLOOK_AI_INPUT_MAX_CHARS } from "@stll/api-contract";

import {
  buildAIDraftRequest,
  buildAISummaryRequest,
} from "@/hooks/ai-request.logic";
import type { MailSnapshot } from "@/types";

const snapshot = {
  attachments: [],
  bcc: [],
  bodyHtml: "",
  bodyText: "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS),
  cc: [],
  conversationId: null,
  from: null,
  internetMessageId: null,
  itemInstanceKey: "instance",
  itemId: null,
  mode: "read",
  sentAt: null,
  sourceId: "00000000-0000-7000-8000-000000000001",
  subject: "Subject",
  to: [],
  userEmail: null,
} satisfies MailSnapshot;

describe("Outlook AI request bodies", () => {
  test("preserves summary text at the boundary and truncates overlong text", () => {
    const atLimit = "a".repeat(OUTLOOK_AI_INPUT_MAX_CHARS);
    const overLimit = `${atLimit}b`;

    expect(buildAISummaryRequest({ text: atLimit }).text).toBe(atLimit);
    expect(buildAISummaryRequest({ text: overLimit }).text).toBe(atLimit);
  });

  test("preserves draft body at the boundary and truncates overlong body", () => {
    const overLimitSnapshot = {
      ...snapshot,
      bodyText: `${snapshot.bodyText}b`,
    };

    expect(
      buildAIDraftRequest({ intent: "Reply", snapshot }).originalBody,
    ).toBe(snapshot.bodyText);
    expect(
      buildAIDraftRequest({
        intent: "Reply",
        snapshot: overLimitSnapshot,
      }).originalBody,
    ).toBe(snapshot.bodyText);
  });
});
