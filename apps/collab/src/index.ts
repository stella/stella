import { env } from "./env";
import { createCollabServer } from "./server";

const collabServer = await createCollabServer({
  apiUrl: env.STELLA_API_URL,
  port: env.STELLA_COLLAB_PORT,
});

process.on("SIGTERM", () => {
  void collabServer.destroy().finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  void collabServer.destroy().finally(() => process.exit(0));
});
