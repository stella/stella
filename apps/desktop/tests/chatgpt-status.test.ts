import { describe, expect, test } from "bun:test";

import en from "../src/i18n/langs/en.json";
import {
  CHATGPT_FAILURES,
  isChatGptStatus,
} from "../src/mainview/chatgpt-status";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const snakeCase = (variant: string) =>
  variant.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

describe("ChatGPT connection status", () => {
  test("lists exactly the native failure reasons, each with a message", () => {
    const native = rustEnumVariants(
      readNativeSource("chatgpt_auth/mod.rs"),
      "ChatGptFailure",
    );
    const listed: readonly string[] = CHATGPT_FAILURES;
    expect([...listed]).toEqual(native.map(snakeCase));
    expect(Object.keys(en.agentSubscriptions.failure).toSorted()).toEqual(
      native.toSorted(),
    );
  });

  test("accepts the shapes the native side sends", () => {
    for (const status of [
      { accounts: [], sessionStored: false, state: "signed_out" },
      { accounts: [], sessionStored: true, state: "signed_out" },
      {
        accounts: [{ email: "person@example.com", id: "oaiapp_x" }],
        sessionStored: false,
        state: "signed_out",
      },
      { accounts: [], sessionStored: false, state: "signing_in" },
      {
        email: "person@example.com",
        plan: null,
        accounts: [],
        sessionStored: true,
        state: "connected",
      },
      {
        email: null,
        plan: "plus",
        accounts: [],
        sessionStored: true,
        state: "connected",
      },
      {
        email: null,
        accounts: [],
        sessionStored: false,
        state: "needs_reconnect",
      },
      {
        reason: "plan_usage_not_granted",
        accounts: [],
        sessionStored: true,
        state: "failed",
      },
    ]) {
      expect(isChatGptStatus(status)).toBe(true);
    }
  });

  test("rejects anything else", () => {
    for (const value of [
      null,
      "connected",
      { state: "signed_out" },
      { accounts: [], sessionStored: "yes", state: "signed_out" },
      { sessionStored: true, state: "signed_out" },
      {
        accounts: [{ email: null, id: "oaiapp_x" }],
        sessionStored: true,
        state: "signed_out",
      },
      {
        email: 1,
        plan: null,
        accounts: [],
        sessionStored: true,
        state: "connected",
      },
      {
        reason: "unknown",
        accounts: [],
        sessionStored: false,
        state: "failed",
      },
      { accounts: [], sessionStored: true, state: "token", token: "secret" },
    ]) {
      expect(isChatGptStatus(value)).toBe(false);
    }
  });
});
