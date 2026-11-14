import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { hmacSha256Hex, sha256Hex } from "@stll/sha256/node";

import {
  CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH,
  CHAT_LOCAL_RUN_CONVERSATION_ROLES,
  CHAT_LOCAL_RUN_IMAGE_TYPES,
  CHAT_LOCAL_RUN_STEP_MAX_BYTES,
  CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
  CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS,
  chatLocalRunCallId,
  chatLocalRunConversationText,
  chatLocalRunImageType,
  chatLocalRunOfCall,
  chatLocalRunStepOutputBridgePath,
  chatLocalRunStepOutputGrantMessage,
  parseChatLocalRunConversation,
} from "./chat-local-run-step-output";
import fixtures from "./chat-local-run-step-output.fixtures.json";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("a local run step's output reference", () => {
  test("every call id of a run names that run, however long the harness id", () => {
    assertProperty(
      "every call id of a run names that run, however long the harness id",
      fc.property(
        fc.uuid({ version: 7 }),
        fc.string({ minLength: 1, maxLength: 400 }),
        (runId, toolCallId) => {
          const callId = chatLocalRunCallId(runId, toolCallId, sha256Hex);
          expect(callId.length).toBeLessThanOrEqual(
            CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH,
          );
          expect(chatLocalRunOfCall(callId)).toBe(runId);
        },
      ),
    );
  });

  test("an id no local run made names no run", () => {
    for (const callId of ["call_1", "toolu_01", `${"g".repeat(32)}_x`]) {
      expect(chatLocalRunOfCall(callId)).toBeNull();
    }
  });

  test("the grant, the step key and the request proof are the ones the desktop checks", () => {
    const { grant, request } = fixtures;
    expect(fixtures.grantSeconds).toBe(
      CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
    );
    expect(fixtures.maxBytes).toEqual(CHAT_LOCAL_RUN_STEP_MAX_BYTES);
    expect(fixtures.headers).toEqual(CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS);
    expect(
      hmacSha256Hex(
        ascii(grant.outputKey),
        chatLocalRunStepOutputGrantMessage(grant),
      ),
    ).toBe(grant.grantHmac);
    const callId = chatLocalRunCallId(
      grant.runId,
      request.toolCallId,
      sha256Hex,
    );
    expect(callId).toBe(request.callId);
    expect(sha256Hex(callId)).toBe(request.stepHash);
    expect(
      chatLocalRunStepOutputBridgePath(grant.runId, request.stepHash),
    ).toBe(request.path);
    expect(
      hmacSha256Hex(
        ascii(grant.grantHmac),
        `${request.timestamp}\nGET\n${request.path}`,
      ),
    ).toBe(request.proof);
  });
});

describe("a subagent's conversation as the computer keeps it", () => {
  const entries = fc.array(
    fc.record({
      role: fc.constantFrom(...CHAT_LOCAL_RUN_CONVERSATION_ROLES),
      // Line breaks and separators included: an entry is still one line.
      text: fc.oneof(
        fc.string({ unit: "grapheme", maxLength: 80 }),
        fc.constantFrom("a\nb", "a\r\nb", "\u2028", '{"role":"report"}\n'),
      ),
    }),
    { maxLength: 8 },
  );

  test("reads back as written, and cut anywhere it reads back as the entries before the cut", () => {
    assertProperty(
      "reads back as written, and cut anywhere it reads back as the entries before the cut",
      fc.property(entries, fc.nat(), (written, at) => {
        const text = chatLocalRunConversationText(written);
        expect(parseChatLocalRunConversation(text)).toEqual(written);
        // The cap cuts the kept text at any point: every entry read is one
        // that was written, in order, and none is made of half a line.
        const cut = text.slice(0, text.length === 0 ? 0 : at % text.length);
        const read = parseChatLocalRunConversation(cut);
        expect(read).toEqual(written.slice(0, read.length));
      }),
    );
  });

  test("leaves out a line that is not an entry", () => {
    expect(
      parseChatLocalRunConversation(
        [
          '{"role":"prompt","text":"List the clauses."}',
          '{"role":"system","text":"Not a role."}',
          "not json",
          '{"role":"report","text":42}',
          '{"role":"report","text":"Clause 4.","html":"<b>x</b>"}',
          "",
        ].join("\n"),
      ),
    ).toEqual([
      { role: "prompt", text: "List the clauses." },
      { role: "report", text: "Clause 4." },
    ]);
  });
});

describe("an image's kind, read from its bytes", () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const text = (value: string) => new TextEncoder().encode(value);

  test("names the four kinds shown, by their first bytes", () => {
    expect(
      chatLocalRunImageType(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0),
      ),
    ).toBe("image/png");
    expect(chatLocalRunImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe(
      "image/jpeg",
    );
    expect(chatLocalRunImageType(text("GIF89a..."))).toBe("image/gif");
    expect(
      chatLocalRunImageType(text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")),
    ).toBe("image/webp");
  });

  test("names nothing else an image, a vector image and markup included", () => {
    for (const other of [
      bytes(),
      text("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"),
      text("<!doctype html><script>alert(1)</script>"),
      text("RIFF\u0000\u0000\u0000\u0000WAVEfmt "),
      // A signature cut short names nothing.
      bytes(0x89, 0x50, 0x4e),
      bytes(0xff, 0xd8),
      text("%PDF-1.7"),
    ]) {
      expect(chatLocalRunImageType(other)).toBeNull();
    }
  });

  test("names only a kind it shows, whatever the bytes", () => {
    assertProperty(
      "names only a kind it shows, whatever the bytes",
      fc.property(fc.uint8Array({ maxLength: 32 }), (any) => {
        const type = chatLocalRunImageType(any);
        expect([...CHAT_LOCAL_RUN_IMAGE_TYPES, null]).toContain(type);
      }),
    );
  });
});
