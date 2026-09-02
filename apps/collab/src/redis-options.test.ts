import { describe, expect, test } from "bun:test";

import { collabRedisConnectionOptions } from "./redis-options";

describe("collaboration Redis connection options", () => {
  test("verifies the certificate chain on a TLS URL by default", () => {
    expect(
      collabRedisConnectionOptions("rediss://valkey.example.internal:6379"),
    ).toEqual({
      host: "valkey.example.internal",
      port: 6379,
      tls: { rejectUnauthorized: true },
    });
  });

  test("skips verification only when the deployment asks for it", () => {
    expect(
      collabRedisConnectionOptions("rediss://10.0.0.5:6379", false),
    ).toEqual({
      host: "10.0.0.5",
      port: 6379,
      tls: { rejectUnauthorized: false },
    });
  });

  test("adds no TLS options to a plaintext loopback URL", () => {
    expect(
      collabRedisConnectionOptions("redis://localhost:6379", false),
    ).toEqual({ host: "localhost", port: 6379 });
  });

  test("preserves URL credentials and database options", () => {
    expect(
      collabRedisConnectionOptions(
        "rediss://user:p%40ss@redis.example.test:6380/0?db=0",
      ),
    ).toEqual({
      host: "redis.example.test",
      port: 6380,
      username: "user",
      password: "p@ss",
      db: 0,
      tls: { rejectUnauthorized: true },
    });
  });
});
