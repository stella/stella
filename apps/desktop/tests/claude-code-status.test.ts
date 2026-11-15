import { describe, expect, test } from "bun:test";

import en from "../src/i18n/langs/en.json";
import {
  CLAUDE_CODE_FAILURES,
  isClaudeCodeStatus,
} from "../src/mainview/claude-code-status";
import type { ClaudeCodeStatus } from "../src/mainview/claude-code-status";
import { readNativeSource, rustEnumVariants } from "./rust-enum";

const snakeCase = (variant: string) =>
  variant.replaceAll(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);

describe("Claude Code sign-in status", () => {
  test("lists exactly the native failure reasons, each with a message", () => {
    const native = rustEnumVariants(
      readNativeSource("claude_code_auth/mod.rs"),
      "ClaudeCodeFailure",
    );
    const listed: readonly string[] = CLAUDE_CODE_FAILURES;
    expect([...listed]).toEqual(native.map(snakeCase));
    expect(
      Object.keys(en.agentSubscriptions.claudeCode.failure).toSorted(),
    ).toEqual(native.toSorted());
  });

  test("reads every state, the unknown one included", () => {
    const sample = {
      not_installed: { state: "not_installed" },
      signed_out: { state: "signed_out" },
      signing_in: { signInPage: false, state: "signing_in" },
      signed_in: { email: null, plan: null, state: "signed_in" },
      api_key: { state: "api_key" },
      unknown: { state: "unknown" },
      failed: { reason: "unavailable", state: "failed" },
    } as const satisfies {
      [State in ClaudeCodeStatus["state"]]: Extract<
        ClaudeCodeStatus,
        { state: State }
      >;
    };
    for (const status of Object.values(sample)) {
      expect(isClaudeCodeStatus(status)).toBe(true);
    }
    expect(en.agentSubscriptions.claudeCode.unknown).toBeTruthy();
  });

  test("accepts the shapes the native side sends", () => {
    for (const status of [
      { state: "not_installed" },
      { state: "signed_out" },
      { signInPage: false, state: "signing_in" },
      { signInPage: true, state: "signing_in" },
      { email: "person@example.com", plan: "max", state: "signed_in" },
      { email: null, plan: null, state: "signed_in" },
      { state: "api_key" },
      { reason: "timed_out", state: "failed" },
    ]) {
      expect(isClaudeCodeStatus(status)).toBe(true);
    }
  });

  test("rejects anything else", () => {
    for (const value of [
      null,
      "signed_in",
      [],
      { state: "signing_in" },
      { signInPage: "https://claude.ai/oauth", state: "signing_in" },
      { email: 1, plan: null, state: "signed_in" },
      { plan: null, state: "signed_in" },
      { reason: "unknown", state: "failed" },
      { state: "token", token: "secret" },
    ]) {
      expect(isClaudeCodeStatus(value)).toBe(false);
    }
  });
});
