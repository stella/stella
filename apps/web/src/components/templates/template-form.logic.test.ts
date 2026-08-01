import { describe, expect, test } from "bun:test";

import { runLeadingSingleFlight } from "./template-form.logic";

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
