import Elysia from "elysia";

import deleteThread from "@/api/handlers/chat/delete-thread";
import getMessages from "@/api/handlers/chat/get-messages";
import getThreads from "@/api/handlers/chat/get-threads";
import sendMessage from "@/api/handlers/chat/send-message";
import { authMacro, permissionMacro } from "@/api/lib/auth";

export const chatRoute = new Elysia({ prefix: "/chat" })
  .use(authMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", sendMessage.handler, {
    body: sendMessage.config.body,
  })
  .get("/threads", getThreads.handler, {
    query: getThreads.config.query,
  })
  .delete("/threads/:threadId", deleteThread.handler, {
    query: deleteThread.config.query,
    params: deleteThread.config.params,
  })
  .get("/threads/:threadId/messages", getMessages.handler, {
    params: getMessages.config.params,
    query: getMessages.config.query,
  });
