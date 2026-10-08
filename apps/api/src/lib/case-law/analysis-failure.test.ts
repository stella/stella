import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

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
  await store.write(scope, diagnostic);
  for (const other of [
    { ...scope, organizationId: toSafeId<"organization">("other_org") },
    { ...scope, decisionId: toSafeId<"caseLawDecision">("other_decision") },
    { ...scope, fingerprint: "changed-fingerprint" },
  ]) {
    expect(await store.take(other)).toBeNull();
  }
  const deliveries = await Promise.all([store.take(scope), store.take(scope)]);
  expect(deliveries.filter((delivery) => delivery !== null)).toEqual([
    { status: "error", providerDiagnostic: diagnostic },
  ]);
  expect(await store.take(scope)).toBeNull();
  expect(redis.calls.at(0)?.args.at(0)).toContain("{");
});

test("failure delivery expires after its bounded ten-minute window", async () => {
  const redis = fakeRedis();
  const store = createAnalysisFailureStore({ createRedis: () => redis.client });
  await store.write(scope, undefined);
  redis.advance(600);
  expect(await store.take(scope)).toBeNull();
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
    const result = await Result.tryPromise(() => store.take(scope));
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.cause).toBeInstanceOf(AnalysisFailureStoreError);
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
  expect(await rejectionOf(store.write(scope, diagnostic))).toBeInstanceOf(
    AnalysisFailureStoreError,
  );
  expect(await rejectionOf(store.take(scope))).toBeInstanceOf(
    AnalysisFailureStoreError,
  );
});

test("a stalled connection is bounded by the command timeout", async () => {
  const store = createAnalysisFailureStore({
    commandTimeoutMs: 5,
    createRedis: () => ({
      connect: async () => await Promise.withResolvers<undefined>().promise,
      send: async () => panic("A stalled connection must not send commands"),
    }),
  });
  expect(await rejectionOf(store.take(scope))).toBeInstanceOf(
    AnalysisFailureStoreError,
  );
});
