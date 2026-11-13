import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { hmacSha256Hex, sha256Hex } from "@stll/sha256/node";

import {
  CHAT_LOCAL_RUN_CALL_ID_MAX_LENGTH,
  CHAT_LOCAL_RUN_STEP_OUTPUT_GRANT_SECONDS,
  CHAT_LOCAL_RUN_STEP_OUTPUT_HEADERS,
  CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES,
  chatLocalRunCallId,
  chatLocalRunOfCall,
  chatLocalRunStepOutputBridgePath,
  chatLocalRunStepOutputGrantMessage,
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
    expect(fixtures.maxBytes).toBe(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES);
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
