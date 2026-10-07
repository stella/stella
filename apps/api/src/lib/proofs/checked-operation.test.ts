import { panic, Panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeOperation,
  withAdmittedOperation,
} from "@/api/lib/proofs/checked-transaction";

describe("checked operation continuations", () => {
  test("checks before exposing the exact input for execution", async () => {
    const events: string[] = [];
    const input = {
      actor: "actor_a",
      organization: "org_a",
      operation: "read",
    };
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input,
      check: async () => {
        events.push("check");
        await Promise.resolve();
        return Result.ok(undefined);
      },
    });
    expect(Result.isOk(authorization)).toBe(true);
    if (Result.isError(authorization)) {
      panic("Successful evidence fixture was refused", authorization.error);
    }
    const value = await authorization.value.execute(
      async ({ input: named, proof }) => {
        events.push("execute");
        expect(named.value).not.toBe(input);
        expect(named.value).toEqual(input);
        expect(proof.kind).toBe("OperationAllowed");
        return await Promise.resolve(named.value.operation);
      },
    );
    expect(value).toBe("read");
    expect(events).toEqual(["check", "execute"]);
  });

  test("checking and execution share protected nested input", async () => {
    const handle = new AbortController();
    const input = {
      nested: { key: "authorized" },
      items: [{ bytes: 3 }],
      handle,
    };
    const firstItem =
      input.items.at(0) ?? panic("Evidence fixture has no item");
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input,
      check: async (checkedInput) => {
        input.nested.key = "changed during check";
        firstItem.bytes = 7;
        await Promise.resolve();
        expect(checkedInput.nested.key).toBe("authorized");
        return Result.ok(undefined);
      },
    });
    if (Result.isError(authorization)) {
      panic("Successful evidence fixture was refused", authorization.error);
    }
    input.nested.key = "changed after check";
    firstItem.bytes = 11;
    await authorization.value.execute(async ({ input: named }) => {
      expect(named.value.nested.key).toBe("authorized");
      expect(named.value.items).toEqual([{ bytes: 3 }]);
      expect(named.value.handle).toBe(handle);
      expect(Object.isFrozen(named.value)).toBe(true);
      expect(Object.isFrozen(named.value.nested)).toBe(true);
      expect(Object.isFrozen(named.value.items)).toBe(true);
      expect(Object.isFrozen(named.value.items.at(0))).toBe(true);
      await Promise.resolve();
    });
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(handle)).toBe(false);
  });

  test("array snapshots retain shared and circular data references", async () => {
    const child = { key: "authorized" };
    const input = [child, child];
    Object.defineProperty(child, "parent", { value: input });
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input,
      check: async () => {
        await Promise.resolve();
        return Result.ok(undefined);
      },
    });
    if (Result.isError(authorization)) {
      panic("Successful evidence fixture was refused", authorization.error);
    }
    child.key = "changed";
    await authorization.value.execute(async ({ input: named }) => {
      const first = named.value.at(0) ?? panic("Evidence fixture has no item");
      expect(Array.isArray(named.value)).toBe(true);
      expect(first).toBe(
        named.value.at(1) ?? panic("Evidence fixture has no second item"),
      );
      expect(first.key).toBe("authorized");
      expect(Reflect.get(first, "parent")).toBe(named.value);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(named.value)).toBe(true);
      await Promise.resolve();
    });
  });

  test("one admission cannot be reused for another execution", async () => {
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input: { actor: "actor_a", organization: "org_a" },
      check: async () => {
        await Promise.resolve();
        return Result.ok(undefined);
      },
    });
    if (Result.isError(authorization)) {
      panic("Successful evidence fixture was refused", authorization.error);
    }
    let calls = 0;
    const run = async () => {
      calls += 1;
      return await Promise.resolve("completed");
    };
    expect(await authorization.value.execute(run)).toBe("completed");
    const rejection = await rejectionOf(authorization.value.execute(run));
    expect(rejection).toBeInstanceOf(Panic);
    expect(rejection).toMatchObject({
      message: "Checked operation authorization already consumed",
    });
    expect(calls).toBe(1);
  });

  test("a refusal produces no execution capability", async () => {
    const error = new HandlerError({
      status: 403,
      message: "Operation unavailable",
    });
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input: { actor: "actor_a", organization: "org_a" },
      check: async () => Result.err(await Promise.resolve(error)),
    });
    expect(authorization).toEqual(Result.err(error));
  });
});

describe("scoped admitted operations", () => {
  for (const allowed of [true, false]) {
    test(
      allowed
        ? "executes inside admission and settles before cleanup"
        : "settles a refusal without executing",
      async () => {
        const events: string[] = [];
        const input = { actor: "actor_a", organization: "org_a" };
        const admission = { lease: "lease_a" };
        const result = await withAdmittedOperation({
          kind: "OperationAdmitted",
          input,
          admit: async (
            execute: (scope: typeof admission) => Promise<string>,
          ) => {
            events.push("check");
            if (!allowed) {
              return Result.err("unavailable");
            }
            const output = await execute(admission);
            events.push("cleanup");
            return Result.ok(output);
          },
          run: async ({
            input: namedInput,
            admission: namedAdmission,
            proof,
          }) => {
            events.push("execute");
            expect(namedInput.value).toBe(input);
            expect(namedAdmission.value).toBe(admission);
            expect(proof.kind).toBe("OperationAdmitted");
            return await Promise.resolve("done");
          },
        });
        expect(result).toEqual(
          allowed ? Result.ok("done") : Result.err("unavailable"),
        );
        expect(events).toEqual(
          allowed ? ["check", "execute", "cleanup"] : ["check"],
        );
      },
    );
  }

  test("operation failures preserve admission cleanup", async () => {
    const error = new HandlerError({
      status: 409,
      message: "Operation cannot complete",
    });
    const events: string[] = [];
    const result = await withAdmittedOperation({
      kind: "OperationAdmitted",
      input: { actor: "actor_a", organization: "org_a" },
      admit: async (execute: (admission: string) => Promise<never>) =>
        await Result.tryPromise({
          try: async () => {
            try {
              return await execute("lease_a");
            } finally {
              events.push("cleanup");
            }
          },
          catch: (cause) => cause,
        }),
      run: async () => {
        events.push("execute");
        return await Promise.reject(error);
      },
    });
    expect(result).toEqual(Result.err(error));
    expect(events).toEqual(["execute", "cleanup"]);
  });
});
