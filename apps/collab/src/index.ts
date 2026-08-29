import { panic } from "better-result";

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

  return await createCollabServer({
    apiUrl: env.STELLA_API_URL,
    mode: "redis",
    port: env.STELLA_COLLAB_PORT,
    redisTlsRejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
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
