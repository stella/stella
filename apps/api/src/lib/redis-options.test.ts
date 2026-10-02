import { describe, expect, test } from "bun:test";

import { redisConnectionOptions } from "@/api/lib/redis-options";

describe("redis connection options", () => {
  test("verifies the certificate chain on a TLS URL by default", () => {
    expect(
      redisConnectionOptions({ url: "rediss://valkey.example.internal:6379" }),
    ).toEqual({ tls: { rejectUnauthorized: true } });
  });

  test("skips verification only when the deployment asks for it", () => {
    expect(
      redisConnectionOptions({
        url: "rediss://10.0.0.5:6379",
        rejectUnauthorized: false,
      }),
    ).toEqual({
      tls: { rejectUnauthorized: false },
    });
  });

  test("adds no TLS options to a plaintext URL", () => {
    expect(
      redisConnectionOptions({
        url: "redis://localhost:6379",
        rejectUnauthorized: false,
      }),
    ).toEqual({});
  });
});

test("applies the enforced driver options", () => {
  expect(
    redisConnectionOptions({
      url: "rediss://redis.example.test:6379",
      rejectUnauthorized: false,
      settings: {
        REDIS_CONNECTION_ENFORCED: true,
        REDIS_USERNAME: "service",
        REDIS_PASSWORD: "example-value",
        REDIS_TLS_CA_PEM: "example-ca",
        REDIS_TLS_SERVER_NAME: "redis.example.test",
      },
    }),
  ).toEqual({
    tls: {
      ca: "example-ca",
      serverName: "redis.example.test",
      rejectUnauthorized: true,
    },
  });
});
