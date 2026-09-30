import { TaggedError } from "better-result";
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
}: RedisConnectionConfigOptions) => {
  const parsed = new URL(url);
  const username =
    settings.REDIS_USERNAME ?? decodeURIComponent(parsed.username);
  const password =
    settings.REDIS_PASSWORD ?? decodeURIComponent(parsed.password);
  if (settings.REDIS_USERNAME !== undefined) {
    parsed.username = settings.REDIS_USERNAME;
  }
  if (settings.REDIS_PASSWORD !== undefined) {
    parsed.password = settings.REDIS_PASSWORD;
  }

  if (!settings.REDIS_CONNECTION_ENFORCED) {
    return {
      mode: "configured" as const,
      url: parsed.toString(),
      tls: parsed.protocol === "rediss:" ? { rejectUnauthorized } : undefined,
    };
  }
  if (parsed.protocol !== "rediss:") {
    throw new RedisConfigurationError({
      message: "Redis connection requires a TLS URL.",
    });
  }
  if (username.trim() === "" || username === "default" || password === "") {
    throw new RedisConfigurationError({
      message: "Redis connection requires service credentials.",
    });
  }
  const ca = settings.REDIS_TLS_CA_PEM;
  const serverName = settings.REDIS_TLS_SERVER_NAME;
  if (
    ca === undefined ||
    ca.trim() === "" ||
    serverName === undefined ||
    serverName.trim() === ""
  ) {
    throw new RedisConfigurationError({
      message: "Redis connection requires CA and server name settings.",
    });
  }
  return {
    mode: "enforced" as const,
    url: parsed.toString(),
    tls: { ca, serverName, rejectUnauthorized: true as const },
  };
};
