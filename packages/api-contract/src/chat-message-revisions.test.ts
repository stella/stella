import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH,
  chatMessageAcceptedEditSchema,
  chatMessageRevisionEditSchema,
  type ChatMessageAcceptedEdit,
} from "./chat-message-revisions";

describe("accepted answer edit boundaries", () => {
  test("accepts each edit branch and keeps revert server-owned", () => {
    const edits = [
      {
        type: "ai_span",
        start: 0,
        end: 5,
        instruction: "Shorten",
        model: "model",
        keySource: "byok",
      },
      { type: "format", start: 0, end: 5, format: "bold" },
      { type: "format", start: 0, end: 5, format: "italic" },
      {
        type: "format",
        start: 0,
        end: 5,
        format: "link",
        intent: "set",
        url: "https://example.org",
      },
      { type: "format", start: 0, end: 5, format: "link", intent: "remove" },
      { type: "format", start: 0, end: 5, format: "style", style: "heading-1" },
    ];
    for (const edit of edits) {
      expect(v.safeParse(chatMessageAcceptedEditSchema, edit).success).toBe(
        true,
      );
      expect(v.safeParse(chatMessageRevisionEditSchema, edit).success).toBe(
        true,
      );
    }
    const revert = { type: "revert", toRevision: 0 } as const;
    expect(v.safeParse(chatMessageAcceptedEditSchema, revert).success).toBe(
      false,
    );
    expect(v.parse(chatMessageRevisionEditSchema, revert)).toEqual(revert);
  });

  test("rejects fractional and negative source offsets", () => {
    for (const [start, end] of [
      [-1, 5],
      [0.5, 5],
      [0, 5.5],
    ]) {
      expect(
        v.safeParse(chatMessageAcceptedEditSchema, {
          type: "format",
          format: "bold",
          start,
          end,
        }).success,
      ).toBe(false);
    }
  });

  test("accepts HTTPS links and rejects other link schemes", () => {
    for (const { url, success } of [
      { url: "mailto:editor@example.org", success: false },
      { url: "ftp://example.org/document", success: false },
      { url: "https://example.org/document", success: true },
    ]) {
      const edit = {
        type: "format",
        start: 0,
        end: 5,
        format: "link",
        intent: "set",
        url,
      } as const satisfies ChatMessageAcceptedEdit;
      const parsed = v.safeParse(chatMessageAcceptedEditSchema, edit);
      expect(parsed.success).toBe(success);
      if (parsed.success) {
        expect(parsed.output).toEqual(edit);
      }
    }
  });

  test("rejects mixed edit branches and styles without a value", () => {
    expect(
      v.safeParse(chatMessageAcceptedEditSchema, {
        type: "format",
        start: 0,
        end: 5,
        format: "bold",
        instruction: "Rewrite",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(chatMessageAcceptedEditSchema, {
        type: "format",
        start: 0,
        end: 5,
        format: "style",
      }).success,
    ).toBe(false);
  });

  test("bounds instructions and rejects unknown edit provenance", () => {
    const edit = {
      type: "ai_span",
      start: 0,
      end: 5,
      instruction: "x".repeat(CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH),
      model: "model",
      keySource: "instance",
    };
    expect(v.safeParse(chatMessageAcceptedEditSchema, edit).success).toBe(true);
    expect(
      v.safeParse(chatMessageAcceptedEditSchema, {
        ...edit,
        instruction: `${edit.instruction}x`,
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(chatMessageAcceptedEditSchema, {
        ...edit,
        keySource: "other",
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(chatMessageRevisionEditSchema, {
        type: "revert",
        toRevision: -1,
      }).success,
    ).toBe(false);
  });
});

test("link intent rejects implicit toggles and mixed set/remove payloads", () => {
  const link = { type: "format", format: "link", start: 0, end: 5 };
  for (const payload of [
    { ...link, url: "https://example.test/" },
    { ...link, intent: "set" },
    { ...link, intent: "remove", url: "https://example.test/" },
  ]) {
    expect(v.safeParse(chatMessageAcceptedEditSchema, payload).success).toBe(
      false,
    );
  }
});
