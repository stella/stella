import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  readAiFieldErrorPaths,
  runLeadingSingleFlight,
} from "./template-form.logic";

describe("download AI diagnostics", () => {
  test("preserves field paths across URI-encoded JSON, including multilingual paths", () => {
    const paths = ["pełnomocnictwo.zakres", "مهمة", "scope,english"];
    const headers = new Headers({
      "X-Ai-Field-Errors": encodeURIComponent(
        JSON.stringify(
          paths.map((fieldPath) => ({ fieldPath, error: "failed" })),
        ),
      ),
    });
    const result = readAiFieldErrorPaths(headers);
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(paths);
    }
  });

  test("an absent diagnostic header means no failed drafts", () => {
    const result = readAiFieldErrorPaths(new Headers());
    expect(Result.isOk(result) && result.value).toEqual([]);
  });

  test.each([
    "%",
    "not-json",
    "null",
    "{}",
    '[{"fieldPath":1}]',
    '[{"fieldPath":""}]',
  ])("rejects malformed diagnostics: %s", (encoded) => {
    expect(
      Result.isError(
        readAiFieldErrorPaths(
          new Headers({
            "X-Ai-Field-Errors": encoded,
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe("runLeadingSingleFlight", () => {
  test("coalesces every concurrent caller into one operation", async () => {
    const state: { current: Promise<void> | null } = { current: null };
    let calls = 0;
    const operation = async () => {
      calls += 1;
    };

    const concurrent = Array.from({ length: 100 }, async () => {
      await runLeadingSingleFlight(state, operation);
    });

    expect(calls).toBe(1);
    await Promise.all(concurrent);

    await runLeadingSingleFlight(state, operation);
    expect(calls).toBe(2);
  });

  test("releases the gate after rejection", async () => {
    const state: { current: Promise<void> | null } = { current: null };
    let shouldReject = true;
    const operation = async () => {
      if (shouldReject) {
        throw new Error("expected operation failure");
      }
    };

    const rejection = await runLeadingSingleFlight(state, operation).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect(rejection instanceof Error ? rejection.message : "").toBe(
      "expected operation failure",
    );
    shouldReject = false;

    await runLeadingSingleFlight(state, operation);
    expect(state.current).toBeNull();
  });
});
