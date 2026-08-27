import { describe, expect, test } from "bun:test";

import { redisConnectionOptions } from "@/api/lib/redis-options";

describe("redis connection options", () => {
  test("verifies the certificate chain on a TLS URL by default", () => {
    expect(
      redisConnectionOptions("rediss://valkey.example.internal:6379"),
    ).toEqual({ tls: { rejectUnauthorized: true } });
  });

  test("skips verification only when the deployment asks for it", () => {
    expect(redisConnectionOptions("rediss://10.0.0.5:6379", false)).toEqual({
      tls: { rejectUnauthorized: false },
    });
  });

  test("adds no TLS options to a plaintext URL", () => {
    expect(redisConnectionOptions("redis://localhost:6379", false)).toEqual({});
  });
});
