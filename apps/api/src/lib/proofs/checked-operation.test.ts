import { panic, Panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeOperation,
  withAdmittedOperation,
  withCheckedTransaction,
} from "@/api/lib/proofs/checked-transaction";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

describe("checked operation continuations", () => {
  test("checks before exposing frozen proof input and mutable scratch", async () => {
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
      async ({ input: named, proof, scratch }) => {
        events.push("execute");
        expect(named.value).not.toBe(input);
        expect(named.value).toEqual(input);
        expect(Object.isFrozen(named.value)).toBe(true);
        expect(proof.kind).toBe("OperationAllowed");
        expect(proof.input).toBe(named);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof.input)).toBe(true);
        expect(Object.isFrozen(scratch)).toBe(false);
        scratch.operation = "scratch-only";
        expect(proof.input.value.operation).toBe("read");
        return await Promise.resolve(named.value.operation);
      },
    );
    expect(value).toBe("read");
    expect(events).toEqual(["check", "execute"]);
  });

  test("execution owns mutable data isolated from checked nested input", async () => {
    const handle = new AbortController();
    const input = {
      nested: { key: "authorized" },
      items: [{ bytes: 3 }],
      handle,
    };
    const checked = { input };
    const firstItem =
      input.items.at(0) ?? panic("Evidence fixture has no item");
    const authorization = await authorizeOperation({
      kind: "OperationAllowed",
      input,
      check: async (checkedInput) => {
        checked.input = checkedInput;
        input.nested.key = "changed during check";
        firstItem.bytes = 7;
        await Promise.resolve();
        expect(checkedInput.nested.key).toBe("authorized");
        expect(Object.isFrozen(checkedInput.nested)).toBe(true);
        return Result.ok(undefined);
      },
    });
    if (Result.isError(authorization)) {
      panic("Successful evidence fixture was refused", authorization.error);
    }
    input.nested.key = "changed after check";
    firstItem.bytes = 11;
    await authorization.value.execute(
      async ({ input: named, proof, scratch }) => {
        expect(named.value.nested.key).toBe("authorized");
        expect(named.value.items).toEqual([{ bytes: 3 }]);
        expect(named.value.handle).toBe(handle);
        expect(named.value).toBe(checked.input);
        expect(Object.isFrozen(named.value)).toBe(true);
        expect(Object.isFrozen(named.value.nested)).toBe(true);
        expect(Object.isFrozen(named.value.items)).toBe(true);
        expect(Object.isFrozen(named.value.items.at(0))).toBe(true);
        expect(proof.input).toBe(named);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof.input)).toBe(true);
        scratch.nested.key = "execution-owned";
        scratch.items.push({ bytes: 13 });
        expect(proof.input.value.nested.key).toBe("authorized");
        expect(proof.input.value.items).toEqual([{ bytes: 3 }]);
        expect(checked.input.nested.key).toBe("authorized");
        expect(checked.input.items).toEqual([{ bytes: 3 }]);
        expect(input.nested.key).toBe("changed after check");
        await Promise.resolve();
      },
    );
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
    await authorization.value.execute(
      async ({ input: named, proof, scratch }) => {
        const first =
          named.value.at(0) ?? panic("Evidence fixture has no item");
        const scratchFirst =
          scratch.at(0) ?? panic("Scratch fixture has no item");
        expect(Array.isArray(named.value)).toBe(true);
        expect(first).toBe(
          named.value.at(1) ?? panic("Evidence fixture has no second item"),
        );
        expect(first.key).toBe("authorized");
        expect(Reflect.get(first, "parent")).toBe(named.value);
        expect(Object.isFrozen(first)).toBe(true);
        expect(Object.isFrozen(named.value)).toBe(true);
        expect(proof.input).toBe(named);
        expect(Object.isFrozen(proof)).toBe(true);
        expect(Object.isFrozen(proof.input)).toBe(true);
        scratchFirst.key = "scratch-only";
        expect(proof.input.value.at(0)?.key).toBe("authorized");
        await Promise.resolve();
      },
    );
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

test("a transaction check and execution retain structured entity input", async () => {
  const entered = Promise.withResolvers<undefined>();
  const proceed = Promise.withResolvers<undefined>();
  const entityId = { nested: { key: "authorized" } };
  const tx = asTestRaw<Transaction>(new AbortController());
  const operation = withCheckedTransaction(
    {
      kind: "EntityChecked",
      tx,
      organizationId: toSafeId<"organization">("org_a"),
      actorUserId: toSafeId<"user">("user_a"),
      entityId,
      check: async (checkedEntity) => {
        entered.resolve(undefined);
        await proceed.promise;
        expect(checkedEntity.nested.key).toBe("authorized");
        return Result.ok(undefined);
      },
    },
    async ({ entity, tx: namedTransaction }) => {
      expect(namedTransaction.value).toBe(tx);
      return Result.ok(await Promise.resolve(entity.value.nested.key));
    },
  );
  await entered.promise;
  entityId.nested.key = "changed";
  proceed.resolve(undefined);
  expect(await operation).toEqual(Result.ok("authorized"));
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
            checkedInput,
            execute: (scope: typeof admission) => Promise<string>,
          ) => {
            events.push("check");
            expect(checkedInput).not.toBe(input);
            expect(checkedInput).toEqual(input);
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
            scratch,
          }) => {
            events.push("execute");
            expect(namedInput.value).not.toBe(input);
            expect(namedInput.value).toEqual(input);
            expect(namedAdmission.value).not.toBe(admission);
            expect(namedAdmission.value).toEqual(admission);
            expect(Object.isFrozen(namedInput.value)).toBe(true);
            expect(Object.isFrozen(namedAdmission.value)).toBe(true);
            expect(proof.kind).toBe("OperationAdmitted");
            expect(proof.input).toBe(namedInput);
            expect(proof.admission).toBe(namedAdmission);
            expect(Object.isFrozen(proof)).toBe(true);
            expect(Object.isFrozen(proof.input)).toBe(true);
            scratch.actor = "scratch-only";
            expect(proof.input.value.actor).toBe("actor_a");
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

  test("pending admission retains its checked organization and callback", async () => {
    const entered = Promise.withResolvers<undefined>();
    const proceed = Promise.withResolvers<undefined>();
    const input = {
      organizationId: "org_a",
      nested: { action: "authorized" },
      execute: async (organization: string) =>
        await Promise.resolve(`original:${organization}`),
    };
    const operation = withAdmittedOperation({
      kind: "OperationAdmitted",
      input,
      admit: async (
        checkedInput,
        execute: (scope: string) => Promise<string>,
      ) => {
        entered.resolve(undefined);
        await proceed.promise;
        expect(checkedInput.organizationId).toBe("org_a");
        expect(checkedInput.nested.action).toBe("authorized");
        return Result.ok(await execute(checkedInput.organizationId));
      },
      run: async ({ input: named, admission }) => {
        expect(named.value.organizationId).toBe(admission.value);
        expect(Object.isFrozen(named.value)).toBe(true);
        expect(Object.isFrozen(named.value.nested)).toBe(true);
        return await named.value.execute(named.value.organizationId);
      },
    });
    await entered.promise;
    input.organizationId = "org_b";
    input.nested.action = "changed";
    input.execute = async (organization) =>
      await Promise.resolve(`changed:${organization}`);
    proceed.resolve(undefined);
    expect(await operation).toEqual(Result.ok("original:org_a"));
  });

  test("operation failures preserve admission cleanup", async () => {
    const error = new HandlerError({
      status: 409,
      message: "Operation cannot complete",
    });
    const events: string[] = [];
    const result = await withAdmittedOperation({
      kind: "OperationAdmitted",
      input: { actor: "actor_a", organization: "org_a" },
      admit: async (
        _checkedInput,
        execute: (admission: string) => Promise<never>,
      ) =>
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
