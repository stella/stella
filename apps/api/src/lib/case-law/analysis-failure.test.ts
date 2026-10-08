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
        const key = args.at(0) ?? panic("Expected key");
        switch (command) {
          case "SET": {
            const value = args.at(1) ?? panic("Expected value");
            expect(args.at(2)).toBe("EX");
            expect(args.at(3)).toBe("600");
            values.set(key, { value, expiresAt: seconds + Number(args.at(3)) });
            return "OK";
          }
          case "GETDEL": {
            const value = values.get(key);
            values.delete(key);
            return value !== undefined && value.expiresAt > seconds
              ? value.value
              : null;
          }
          default:
            return panic(`Unexpected command ${command}`);
        }
      },
    },
  };
};

test("failures are isolated by organization, decision, and input fingerprint and delivered once", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  expect(Result.isOk(await store.write(scope, diagnostic))).toBe(true);
  for (const other of [
    { ...scope, organizationId: toSafeId<"organization">("other_org") },
    { ...scope, decisionId: toSafeId<"caseLawDecision">("other_decision") },
    { ...scope, fingerprint: "changed-fingerprint" },
  ]) {
    expect((await store.take(other)).unwrap()).toBeNull();
  }
  const deliveries = (
    await Promise.all([store.take(scope), store.take(scope)])
  ).map((result) => result.unwrap());
  expect(deliveries.filter((delivery) => delivery !== null)).toEqual([
    { status: "error", providerDiagnostic: diagnostic },
  ]);
  expect((await store.take(scope)).unwrap()).toBeNull();
  expect(redis.calls.at(0)?.args.at(0)).toContain("{");
});

test("failure delivery expires after its bounded ten-minute window", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  expect(Result.isOk(await store.write(scope, undefined))).toBe(true);
  redis.advance(600);
  expect((await store.take(scope)).unwrap()).toBeNull();
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
    const result = await store.take(scope);
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
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
    await store.take(scope),
  ]) {
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
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
  const result = await store.take(scope);
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(AnalysisFailureStoreError);
  }
});
