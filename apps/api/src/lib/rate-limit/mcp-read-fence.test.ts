import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { env } from "@/api/env";
import { envApiServerSchema } from "@/api/env-schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  chargeMcpReadBytes,
  resolveMcpReadFencePolicy,
} from "@/api/lib/rate-limit/mcp-read-fence";

const identity = {
  organizationId: toSafeId<"organization">("org_read_a"),
  userId: toSafeId<"user">("user_read_a"),
};
const policy = {
  windowMs: 137,
  maxEntries: 11,
  tenant: { organizationBytes: 271, userBytes: 131 },
  public: { organizationBytes: 541, userBytes: 269 },
};

describe("shared read windows", () => {
  test("the fence defaults off and operator values must be positive safe integers", () => {
    expect(v.parse(envApiServerSchema.FEATURE_MCP_READ_FENCE, undefined)).toBe(
      false,
    );
    for (const schema of [
      envApiServerSchema.MCP_READ_WINDOW_MS,
      envApiServerSchema.MCP_READ_WINDOW_MAX_ENTRIES,
      envApiServerSchema.MCP_READ_TENANT_ORG_BYTES,
      envApiServerSchema.MCP_READ_TENANT_USER_BYTES,
      envApiServerSchema.MCP_READ_PUBLIC_ORG_BYTES,
      envApiServerSchema.MCP_READ_PUBLIC_USER_BYTES,
    ]) {
      expect(v.safeParse(schema, "17").success).toBe(true);
      for (const value of [
        "0",
        "-1",
        "1.5",
        "Infinity",
        String(Number.MAX_SAFE_INTEGER + 1),
      ]) {
        expect(v.safeParse(schema, value).success).toBe(false);
      }
    }
  });
  test("disabled and zero output never reach the store, even with absent configuration", async () => {
    let calls = 0;
    const redis = {
      send: async () => {
        calls++;
        return 1;
      },
    };
    for (const options of [
      { enabled: false, bytes: 71 },
      { enabled: true, bytes: 0 },
    ]) {
      const result = await chargeMcpReadBytes({
        ...identity,
        readClass: "tenant",
        redis,
        ...options,
      });
      expect(Result.isOk(result)).toBe(true);
    }
    expect(calls).toBe(0);
  });

  test("checks both classes and both identities in the same organization slot", async () => {
    const commands: string[][] = [];
    const result = await chargeMcpReadBytes({
      ...identity,
      readClass: "both",
      bytes: 73,
      policy,
      enabled: true,
      redis: {
        send: async (command, args) => {
          expect(command).toBe("EVAL");
          commands.push(args);
          return 1;
        },
      },
    });
    expect(Result.isOk(result)).toBe(true);
    const args = commands.at(0);
    expect(args?.slice(1, 6)).toEqual([
      "4",
      "mcp-read-fence:{org_read_a}:tenant:organization",
      "mcp-read-fence:{org_read_a}:tenant:user:user_read_a",
      "mcp-read-fence:{org_read_a}:public:organization",
      "mcp-read-fence:{org_read_a}:public:user:user_read_a",
    ]);
    expect(args?.slice(6, 9)).toEqual(["137", "11", "73"]);
    expect(args?.slice(10)).toEqual(["271", "131", "541", "269"]);
  });

  test("exhaustion and every malformed reply or store failure preserve canonical refusal codes", async () => {
    for (const reply of [0, -1, null, "1", [1], 3]) {
      const result = await chargeMcpReadBytes({
        ...identity,
        readClass: "tenant",
        bytes: 7,
        policy,
        enabled: true,
        redis: { send: async () => reply },
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.code).toBe(
          reply === 0
            ? "action_period_exhausted"
            : "action_admission_unavailable",
        );
      }
    }
    const failure = await chargeMcpReadBytes({
      ...identity,
      readClass: "public",
      bytes: 7,
      policy,
      enabled: true,
      redis: {
        send: async () => await Promise.reject(new Error("store unavailable")),
      },
    });
    if (!Result.isError(failure)) {
      throw new TypeError("Expected closed read");
    }
    expect(failure.error.code).toBe("action_admission_unavailable");
  });

  test("invalid bytes or policy fail closed before store access", async () => {
    let calls = 0;
    const redis = {
      send: async () => {
        calls++;
        return 1;
      },
    };
    for (const bytes of [
      -1,
      1.5,
      Infinity,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const result = await chargeMcpReadBytes({
        ...identity,
        readClass: "tenant",
        bytes,
        policy,
        enabled: true,
        redis,
      });
      expect(Result.isError(result)).toBe(true);
    }
    for (const malformed of [
      { ...policy, windowMs: 0 },
      { ...policy, maxEntries: -3 },
      { ...policy, tenant: { organizationBytes: 0, userBytes: 7 } },
    ]) {
      expect(
        Result.isError(
          await chargeMcpReadBytes({
            ...identity,
            readClass: "tenant",
            bytes: 7,
            policy: malformed,
            enabled: true,
            redis,
          }),
        ),
      ).toBe(true);
    }
    expect(calls).toBe(0);
  });

  test("missing operator configuration is unavailable", () => {
    const previous = env.MCP_READ_WINDOW_MS;
    env.MCP_READ_WINDOW_MS = undefined;
    try {
      expect(Result.isError(resolveMcpReadFencePolicy())).toBe(true);
    } finally {
      env.MCP_READ_WINDOW_MS = previous;
    }
  });
});
