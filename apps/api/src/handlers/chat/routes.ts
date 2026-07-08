import Elysia from "elysia";

import deleteThread from "@/api/handlers/chat/delete-thread";
import getMessages from "@/api/handlers/chat/get-messages";
import getOlderMessages from "@/api/handlers/chat/get-older-messages";
import getSuggestedPrompts from "@/api/handlers/chat/get-suggested-prompts";
import getThreadRecap from "@/api/handlers/chat/get-thread-recap";
import getThreadTitle from "@/api/handlers/chat/get-thread-title";
import getThreads from "@/api/handlers/chat/get-threads";
import renameThread from "@/api/handlers/chat/rename-thread";
import resolveFileThread from "@/api/handlers/chat/resolve-file-thread";
import resolveTemplateThread from "@/api/handlers/chat/resolve-template-thread";
import rotateTemplateThread from "@/api/handlers/chat/rotate-template-thread";
import sendMessage from "@/api/handlers/chat/send-message";
import updateThread from "@/api/handlers/chat/update-thread";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const chatRoute = new Elysia({ prefix: "/chat" })
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  // Deliberately no top-level auth guard: every route below already
  // declares `permissions`, which implies `validateAuth: true` (see
  // permissionMacro in lib/auth.ts). A redundant bare guard here would
  // register a second, independent `validateAuth` resolve hook per
  // request (Elysia doesn't dedupe macro expansions across separate
  // guard / route-level call sites). See
  // tests/security/redundant-validate-auth-guard.test.ts.
  .post("/", sendMessage.handler, {
    body: sendMessage.config.body,
    permissions: sendMessage.config.permissions,
  })
  .post("/workspaces/:workspaceId/file-thread", resolveFileThread.handler, {
    body: resolveFileThread.config.body,
    permissions: resolveFileThread.config.permissions,
    validateWorkspaceAccess: true,
  })
  .post("/template-thread", resolveTemplateThread.handler, {
    body: resolveTemplateThread.config.body,
    permissions: resolveTemplateThread.config.permissions,
  })
  .post("/template-thread/rotate", rotateTemplateThread.handler, {
    body: rotateTemplateThread.config.body,
    permissions: rotateTemplateThread.config.permissions,
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
  .patch("/threads/:threadId/title", renameThread.handler, {
    body: renameThread.config.body,
    params: renameThread.config.params,
    permissions: renameThread.config.permissions,
    query: renameThread.config.query,
  })
  .get("/threads/:threadId/title", getThreadTitle.handler, {
    params: getThreadTitle.config.params,
    permissions: getThreadTitle.config.permissions,
    query: getThreadTitle.config.query,
  })
  .get("/threads/:threadId/messages", getMessages.handler, {
    params: getMessages.config.params,
    permissions: getMessages.config.permissions,
    query: getMessages.config.query,
  })
  .get("/threads/:threadId/messages/older", getOlderMessages.handler, {
    params: getOlderMessages.config.params,
    permissions: getOlderMessages.config.permissions,
    query: getOlderMessages.config.query,
  })
  .post("/threads/:threadId/recap", getThreadRecap.handler, {
    params: getThreadRecap.config.params,
    permissions: getThreadRecap.config.permissions,
    query: getThreadRecap.config.query,
  })
  .post("/threads/:threadId/suggested-prompts", getSuggestedPrompts.handler, {
    params: getSuggestedPrompts.config.params,
    permissions: getSuggestedPrompts.config.permissions,
    query: getSuggestedPrompts.config.query,
  });
