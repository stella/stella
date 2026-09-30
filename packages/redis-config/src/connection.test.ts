import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  redisConnectionConfig,
  RedisConfigurationError,
  redisSettingsSchema,
} from "./connection";

const settings = {
  REDIS_CONNECTION_ENFORCED: true,
  REDIS_USERNAME: "service",
  REDIS_PASSWORD: "example-value",
  REDIS_TLS_CA_PEM: "example-ca",
  REDIS_TLS_SERVER_NAME: "redis.example.test",
};
const url = "rediss://redis.example.test:6379";

describe("Redis connection policy", () => {
  test("keeps the configured mode by default", () => {
    expect(v.parse(redisSettingsSchema, {}).REDIS_CONNECTION_ENFORCED).toBe(
      false,
    );
    expect(redisConnectionConfig({ url, rejectUnauthorized: false })).toEqual({
      mode: "configured",
      url,
      tls: { rejectUnauthorized: false },
    });
    expect(redisConnectionConfig({ url: "redis://localhost:6379" })).toEqual({
      mode: "configured",
      url: "redis://localhost:6379",
      tls: undefined,
    });
  });

  test("uses configured credentials independently of the connection mode", () => {
    const configured = redisConnectionConfig({
      url,
      settings: {
        REDIS_USERNAME: "service",
        REDIS_PASSWORD: "example@value",
      },
    });
    const parsed = new URL(configured.url);
    expect(decodeURIComponent(parsed.username)).toBe("service");
    expect(decodeURIComponent(parsed.password)).toBe("example@value");
    expect(configured.mode).toBe("configured");
  });

  test("requires a complete enforced configuration", () => {
    for (const field of [
      "REDIS_USERNAME",
      "REDIS_PASSWORD",
      "REDIS_TLS_CA_PEM",
      "REDIS_TLS_SERVER_NAME",
    ] as const) {
      for (const value of [undefined, ""]) {
        expect(() =>
          redisConnectionConfig({
            url,
            settings: { ...settings, [field]: value },
          }),
        ).toThrow(RedisConfigurationError);
      }
    }
    expect(() =>
      redisConnectionConfig({ url: "redis://localhost:6379", settings }),
    ).toThrow(RedisConfigurationError);
    expect(() =>
      redisConnectionConfig({
        url,
        settings: { ...settings, REDIS_USERNAME: "default" },
      }),
    ).toThrow(RedisConfigurationError);
  });

  test("applies the enforced certificate policy", () => {
    const config = redisConnectionConfig({
      url,
      settings,
      rejectUnauthorized: false,
    });
    expect(config.mode).toBe("enforced");
    expect(config.tls).toEqual({
      ca: "example-ca",
      serverName: "redis.example.test",
      rejectUnauthorized: true,
    });
    const parsed = new URL(config.url);
    expect(parsed.username).toBe("service");
    expect(parsed.password).toBe("example-value");
  });

  test("accepts service credentials from the URL", () => {
    expect(
      redisConnectionConfig({
        url: "rediss://service:example-value@redis.example.test:6379",
        settings: {
          REDIS_CONNECTION_ENFORCED: true,
          REDIS_TLS_CA_PEM: "example-ca",
          REDIS_TLS_SERVER_NAME: "redis.example.test",
        },
      }).mode,
    ).toBe("enforced");
  });
});
