import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  AnalysisFailureStoreError,
  createAnalysisFailureStore,
} from "./analysis-failure";

const scope = {
  organizationId: toSafeId<"organization">("org_failure_fixture"),
  decisionId: toSafeId<"caseLawDecision">("decision_failure_fixture"),
  fingerprint: "f".repeat(64),
};
const diagnostic = {
  provider: "anthropic",
  code: "ai_config_anthropic_workspace_required",
  message: "Workspace required: full provider reason",
} as const;

const fakeRedis = () => {
  const values = new Map<string, { value: string; expiresAt: number }>();
  const calls: { command: string; args: string[] }[] = [];
  let seconds = 0;
  return {
    calls,
    advance: (elapsed: number) => {
      seconds += elapsed;
    },
    client: {
      connect: async () => await Promise.resolve(),
      send: async (command: string, args: string[]) => {
        calls.push({ command, args: args.slice() });
        const key =
          args.at(command === "EVAL" ? 2 : 0) ?? panic("Expected key");
        switch (command) {
          case "SET": {
            const value = args.at(1) ?? panic("Expected value");
            expect(args.at(2)).toBe("EX");
            expect(args.at(3)).toBe("600");
            values.set(key, { value, expiresAt: seconds + Number(args.at(3)) });
            return "OK";
          }
          case "GET": {
            const value = values.get(key);
            return value !== undefined && value.expiresAt > seconds
              ? value.value
              : null;
          }
          case "EVAL":
            if (
              JSON.parse(values.get(key)?.value ?? "null")?.failureId !==
              args.at(3)
            ) {
              return 0;
            }
            return values.delete(key) ? 1 : 0;
          default:
            return panic(`Unexpected command ${command}`);
        }
      },
    },
  };
};

test("failures are isolated by organization, decision, and input fingerprint and retained across polls", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  expect(Result.isOk(await store.write(scope, diagnostic))).toBe(true);
  for (const other of [
    { ...scope, organizationId: toSafeId<"organization">("other_org") },
    { ...scope, decisionId: toSafeId<"caseLawDecision">("other_decision") },
    { ...scope, fingerprint: "changed-fingerprint" },
  ]) {
    expect((await store.read(other)).unwrap()).toBeNull();
  }
  const deliveries = (
    await Promise.all([store.read(scope), store.read(scope)])
  ).map((result) => result.unwrap());
  expect(deliveries.at(0)).toMatchObject({
    status: "error",
    providerDiagnostic: diagnostic,
  });
  expect(deliveries.at(1)).toEqual(deliveries.at(0));
  const failure = deliveries.at(0);
  if (failure === undefined || failure === null) {
    panic("Expected recorded failure");
  }
  expect((await store.read(scope)).unwrap()).toEqual(failure);
  expect((await store.clear(scope, failure.failureId)).unwrap()).toBe(true);
  expect((await store.read(scope)).unwrap()).toBeNull();
  expect(redis.calls.at(0)?.args.at(0)).toContain("{");
});

test("failure delivery expires after its bounded ten-minute window", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  expect(Result.isOk(await store.write(scope, undefined))).toBe(true);
  redis.advance(600);
  expect((await store.read(scope)).unwrap()).toBeNull();
});

for (const malformed of [
  17,
  "{",
  JSON.stringify({ status: "done" }),
  JSON.stringify({
    status: "error",
    providerDiagnostic: {
      provider: "anthropic",
      code: "unowned-code",
      message: "Reason",
    },
  }),
]) {
  test(`malformed stored replies fail explicitly (${String(malformed)})`, async () => {
    const store = createAnalysisFailureStore({
      createRedis: () => ({
        connect: async () => await Promise.resolve(),
        send: async () => malformed,
      }),
    });
    const result = await store.read(scope);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(AnalysisFailureStoreError);
    }
  });
}

test("read and write outages fail explicitly without an in-process delivery fallback", async () => {
  const store = createAnalysisFailureStore({
    createRedis: () => ({
      connect: async () => {
        throw new AnalysisFailureStoreError({
          message: "Fixture store outage",
        });
      },
      send: async () =>
        panic("An unavailable connection must not send commands"),
    }),
  });
  for (const result of [
    await store.write(scope, diagnostic),
    await store.read(scope),
    await store.clear(scope, Bun.randomUUIDv7()),
  ]) {
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(AnalysisFailureStoreError);
    }
  }
});

test("a stalled connection is bounded by the command timeout", async () => {
  const store = createAnalysisFailureStore({
    commandTimeoutMs: 5,
    createRedis: () => ({
      connect: async () => await Promise.withResolvers<undefined>().promise,
      send: async () => panic("A stalled connection must not send commands"),
    }),
  });
  const result = await store.read(scope);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error).toBeInstanceOf(AnalysisFailureStoreError);
  }
});

test("a stale retry cannot clear a newer failure even with the same diagnostic", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  expect((await store.write(scope, diagnostic)).isOk()).toBe(true);
  const failure = (await store.read(scope)).unwrap();
  if (failure === null) {
    panic("Expected recorded failure");
  }
  expect((await store.write(scope, diagnostic)).isOk()).toBe(true);
  const replacement = (await store.read(scope)).unwrap();
  expect(replacement?.failureId).not.toBe(failure.failureId);
  expect((await store.clear(scope, failure.failureId)).unwrap()).toBe(false);
  expect((await store.read(scope)).unwrap()).toEqual(replacement);
});
