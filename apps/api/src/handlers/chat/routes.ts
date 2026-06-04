import Elysia from "elysia";

import deleteThread from "@/api/handlers/chat/delete-thread";
import getMessages from "@/api/handlers/chat/get-messages";
import getThreadRecap from "@/api/handlers/chat/get-thread-recap";
import getThreads from "@/api/handlers/chat/get-threads";
import resolveFileThread from "@/api/handlers/chat/resolve-file-thread";
import sendMessage from "@/api/handlers/chat/send-message";
import updateThread from "@/api/handlers/chat/update-thread";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const chatRoute = new Elysia({ prefix: "/chat" })
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  .guard({ validateAuth: true })
  .post("/", sendMessage.handler, {
    body: sendMessage.config.body,
    permissions: sendMessage.config.permissions,
  })
  .post("/workspaces/:workspaceId/file-thread", resolveFileThread.handler, {
    body: resolveFileThread.config.body,
    permissions: resolveFileThread.config.permissions,
    validateWorkspaceAccess: true,
  })
  .get("/threads", getThreads.handler, {
    permissions: getThreads.config.permissions,
    query: getThreads.config.query,
  })
  .delete("/threads/:threadId", deleteThread.handler, {
    params: deleteThread.config.params,
    permissions: deleteThread.config.permissions,
    query: deleteThread.config.query,
  })
  .patch("/threads/:threadId", updateThread.handler, {
    body: updateThread.config.body,
    params: updateThread.config.params,
    permissions: updateThread.config.permissions,
    query: updateThread.config.query,
  })
  .get("/threads/:threadId/messages", getMessages.handler, {
    params: getMessages.config.params,
    permissions: getMessages.config.permissions,
    query: getMessages.config.query,
  })
  .post("/threads/:threadId/recap", getThreadRecap.handler, {
    params: getThreadRecap.config.params,
    permissions: getThreadRecap.config.permissions,
    query: getThreadRecap.config.query,
  });
