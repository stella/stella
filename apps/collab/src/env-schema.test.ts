import { describe, expect, test } from "bun:test";

import {
  collabEnvInvariantViolation,
  isSecureCollabRedisUrl,
  isSecureStellaApiUrl,
} from "./env-schema";

describe("Stella API transport", () => {
  test.each([
    "https://api.example.test",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://[::1]:3001",
  ])("accepts secure or loopback URL %s", (url) => {
    expect(isSecureStellaApiUrl(url)).toBe(true);
  });

  test.each(["http://api.example.test", "ftp://api.example.test", "invalid"])(
    "rejects insecure API URL %s",
    (url) => {
      expect(isSecureStellaApiUrl(url)).toBe(false);
    },
  );
});

describe("Redis transport", () => {
  test.each([
    "rediss://redis.example.test:6379",
    "redis://localhost:6379",
    "redis://127.0.0.1:6379",
    "redis://[::1]:6379",
  ])("accepts TLS or loopback URL %s", (url) => {
    expect(isSecureCollabRedisUrl(url)).toBe(true);
  });

  test.each([
    "redis://redis.example.test:6379",
    "http://redis.example.test",
    "invalid",
  ])("rejects insecure Redis URL %s", (url) => {
    expect(isSecureCollabRedisUrl(url)).toBe(false);
  });

  test("requires Redis in the scalable mode", () => {
    expect(
      collabEnvInvariantViolation({
        mode: "redis",
        nodeEnv: "development",
        redisUrl: undefined,
      }),
    ).toBe("STELLA_COLLAB_REDIS_URL is required in redis mode.");
  });

  test("allows the single-process mode outside production", () => {
    expect(
      collabEnvInvariantViolation({
        mode: "single-process",
        nodeEnv: "development",
        redisUrl: undefined,
      }),
    ).toBeNull();
  });

  test("rejects the single-process mode in production", () => {
    expect(
      collabEnvInvariantViolation({
        mode: "single-process",
        nodeEnv: "production",
        redisUrl: undefined,
      }),
    ).toBe("STELLA_COLLAB_MODE=single-process is not allowed in production.");
  });
});
