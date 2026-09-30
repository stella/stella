import { Result, TaggedError } from "better-result";
import * as v from "valibot";

export const redisSettingsSchema = v.object({
  REDIS_CONNECTION_ENFORCED: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "false",
  ),
  REDIS_USERNAME: v.optional(v.pipe(v.string(), v.minLength(1))),
  REDIS_PASSWORD: v.optional(v.pipe(v.string(), v.minLength(1))),
  REDIS_TLS_CA_PEM: v.optional(v.pipe(v.string(), v.minLength(1))),
  REDIS_TLS_SERVER_NAME: v.optional(v.pipe(v.string(), v.minLength(1))),
});

export type RedisConnectionSettings = Partial<
  v.InferOutput<typeof redisSettingsSchema>
>;

export class RedisConfigurationError extends TaggedError(
  "RedisConfigurationError",
)<{
  message: string;
}> {}

type RedisConnectionConfigOptions = {
  url: string;
  settings?: RedisConnectionSettings;
  rejectUnauthorized?: boolean;
};

export const redisConnectionConfig = ({
  url,
  settings = {},
  rejectUnauthorized = true,
}: RedisConnectionConfigOptions) =>
  Result.gen(function* () {
    const { parsed, username, password } = yield* Result.try({
      try: () => {
        const connectionUrl = new URL(url);
        return {
          parsed: connectionUrl,
          username:
            settings.REDIS_USERNAME ??
            decodeURIComponent(connectionUrl.username),
          password:
            settings.REDIS_PASSWORD ??
            decodeURIComponent(connectionUrl.password),
        };
      },
      catch: () =>
        new RedisConfigurationError({
          message: "Redis connection URL must be valid.",
        }),
    });
    if (settings.REDIS_USERNAME !== undefined) {
      parsed.username = settings.REDIS_USERNAME;
    }
    if (settings.REDIS_PASSWORD !== undefined) {
      parsed.password = settings.REDIS_PASSWORD;
    }

    if (!settings.REDIS_CONNECTION_ENFORCED) {
      return Result.ok({
        mode: "configured" as const,
        url: parsed.toString(),
        tls: parsed.protocol === "rediss:" ? { rejectUnauthorized } : undefined,
      });
    }
    if (parsed.protocol !== "rediss:") {
      return Result.err(
        new RedisConfigurationError({
          message: "Redis connection requires a TLS URL.",
        }),
      );
    }
    if (username.trim() === "" || username === "default" || password === "") {
      return Result.err(
        new RedisConfigurationError({
          message: "Redis connection requires service credentials.",
        }),
      );
    }
    const ca = settings.REDIS_TLS_CA_PEM;
    const serverName = settings.REDIS_TLS_SERVER_NAME;
    if (
      ca === undefined ||
      ca.trim() === "" ||
      serverName === undefined ||
      serverName.trim() === ""
    ) {
      return Result.err(
        new RedisConfigurationError({
          message: "Redis connection requires CA and server name settings.",
        }),
      );
    }
    return Result.ok({
      mode: "enforced" as const,
      url: parsed.toString(),
      tls: { ca, serverName, rejectUnauthorized: true as const },
    });
  });
