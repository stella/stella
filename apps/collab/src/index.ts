import { panic } from "better-result";

import { redisConnectionConfig } from "@stll/redis-config";

import { env } from "./env";
import { createCollabServer } from "./server";

const startCollabServer = async () => {
  if (env.STELLA_COLLAB_MODE === "single-process") {
    return await createCollabServer({
      apiUrl: env.STELLA_API_URL,
      mode: "single-process",
      port: env.STELLA_COLLAB_PORT,
      serviceToken: env.STELLA_COLLAB_SERVICE_TOKEN,
    });
  }

  const redisUrl = env.STELLA_COLLAB_REDIS_URL;
  if (redisUrl === undefined) {
    panic("STELLA_COLLAB_REDIS_URL is required in redis mode.");
  }

  const { mode } = redisConnectionConfig({
    url: redisUrl,
    settings: env,
    rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
  });
  process.stderr.write(
    `${JSON.stringify({ event: "redis.connection.mode", mode })}\n`,
  );

  return await createCollabServer({
    apiUrl: env.STELLA_API_URL,
    mode: "redis",
    port: env.STELLA_COLLAB_PORT,
    redisTlsRejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
    redisSettings: env,
    redisUrl,
    serviceToken: env.STELLA_COLLAB_SERVICE_TOKEN,
  });
};

const collabServer = await startCollabServer();

process.on("SIGTERM", () => {
  void collabServer.destroy().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  void collabServer.destroy().finally(() => process.exit(0));
});
