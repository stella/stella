import { describe, expect, test } from "bun:test";

import { collabRedisConnectionOptions } from "./redis-options";

describe("collaboration Redis connection options", () => {
  test("verifies the certificate chain on a TLS URL by default", () => {
    expect(
      collabRedisConnectionOptions("rediss://valkey.example.internal:6379"),
    ).toEqual({ tls: { rejectUnauthorized: true } });
  });

  test("skips verification only when the deployment asks for it", () => {
    expect(
      collabRedisConnectionOptions("rediss://10.0.0.5:6379", false),
    ).toEqual({ tls: { rejectUnauthorized: false } });
  });

  test("adds no TLS options to a plaintext loopback URL", () => {
    expect(
      collabRedisConnectionOptions("redis://localhost:6379", false),
    ).toEqual({});
  });
});
