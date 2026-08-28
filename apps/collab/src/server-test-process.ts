import { Redis as RedisExtension } from "@hocuspocus/extension-redis";
import { panic } from "better-result";

import { env } from "./env";
import { createCollabServer } from "./server";

const redisUrl = env.STELLA_COLLAB_REDIS_URL;
if (env.STELLA_COLLAB_MODE !== "redis" || redisUrl === undefined) {
  panic("Collaboration process test environment is incomplete.");
}

const collabServer = await createCollabServer({
  apiUrl: env.STELLA_API_URL,
  debounceMs: 30,
  maxDebounceMs: 100,
  mode: "redis",
  port: 0,
  redisUrl,
  serviceToken: env.STELLA_COLLAB_SERVICE_TOKEN,
});
const redisExtensionFirst =
  collabServer.hocuspocus.configuration.extensions.at(0) instanceof
  RedisExtension;
process.stdout.write(
  `STELLA_COLLAB_TEST_READY ${String(collabServer.port)} ${String(redisExtensionFirst)}\n`,
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  void collabServer.destroy().finally(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
