import { describe, expect, test } from "bun:test";

import { collabRedisConnectionOptions } from "./redis-options";

describe("collaboration Redis connection options", () => {
  test("verifies the certificate chain on a TLS URL by default", () => {
    expect(
      collabRedisConnectionOptions({
        redisUrl: "rediss://valkey.example.internal:6379",
      }),
    ).toEqual({
      host: "valkey.example.internal",
      port: 6379,
      tls: { rejectUnauthorized: true },
    });
  });

  test("skips verification only when the deployment asks for it", () => {
    expect(
      collabRedisConnectionOptions({
        redisUrl: "rediss://10.0.0.5:6379",
        rejectUnauthorized: false,
      }),
    ).toEqual({
      host: "10.0.0.5",
      port: 6379,
      tls: { rejectUnauthorized: false },
    });
  });

  test("adds no TLS options to a plaintext loopback URL", () => {
    expect(
      collabRedisConnectionOptions({
        redisUrl: "redis://localhost:6379",
        rejectUnauthorized: false,
      }),
    ).toEqual({ host: "localhost", port: 6379 });
  });

  test("preserves URL credentials and database options", () => {
    expect(
      collabRedisConnectionOptions({
        redisUrl: "rediss://user:p%40ss@redis.example.test:6380/0?db=0",
      }),
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

test("applies the enforced driver options", () => {
  expect(
    collabRedisConnectionOptions({
      redisUrl: "rediss://redis.example.test:6379",
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
    host: "redis.example.test",
    port: 6379,
    username: "service",
    password: "example-value",
    tls: {
      ca: "example-ca",
      servername: "redis.example.test",
      rejectUnauthorized: true,
    },
  });
});
