import Elysia from "elysia";

import getDecisionChatThread from "@/api/handlers/chat/decision-threads/get";
import createMessageExport from "@/api/handlers/chat/export/create";
import forkThread from "@/api/handlers/chat/fork/create";
import getModelOptions from "@/api/handlers/chat/get-model-options";
import getSuggestedPrompts from "@/api/handlers/chat/get-suggested-prompts";
import getThreadRecap from "@/api/handlers/chat/get-thread-recap";
import getThreadTitle from "@/api/handlers/chat/get-thread-title";
import improvePrompt from "@/api/handlers/chat/improve-prompt";
import getLinkIcon from "@/api/handlers/chat/link-icons/get";
import getExactIcon from "@/api/handlers/chat/link-icons/get-exact";
import getMessage from "@/api/handlers/chat/messages/get";
import getMessages from "@/api/handlers/chat/messages/list";
import acceptMessageRevision from "@/api/handlers/chat/messages/revisions/accept";
import getMessageRevisions from "@/api/handlers/chat/messages/revisions/list";
import revertMessageRevision from "@/api/handlers/chat/messages/revisions/revert";
import proposeMessageSpanEdit from "@/api/handlers/chat/messages/revisions/span-edit";
import getOlderMessages from "@/api/handlers/chat/older-messages/list";
import readFileThread from "@/api/handlers/chat/read-file-thread";
import resolveFileThread from "@/api/handlers/chat/resolve-file-thread";
import resolveTemplateThread from "@/api/handlers/chat/resolve-template-thread";
import rotateTemplateThread from "@/api/handlers/chat/rotate-template-thread";
import savedSecret from "@/api/handlers/chat/saved-secret";
import sendMessage from "@/api/handlers/chat/send-message";
import listUnavailableChatSkills from "@/api/handlers/chat/skill-availability/list";
import submitSecret from "@/api/handlers/chat/submit-secret";
import suggestThreadTitle from "@/api/handlers/chat/suggest-thread-title";
import tableChart from "@/api/handlers/chat/table-chart";
import deleteThread from "@/api/handlers/chat/threads/delete";
import getThreads from "@/api/handlers/chat/threads/list";
import renameThread from "@/api/handlers/chat/threads/rename";
import updateThread from "@/api/handlers/chat/threads/update";
import readChatToolGrantCoverage from "@/api/handlers/chat/tool-grants/coverage";
import createChatToolGrant from "@/api/handlers/chat/tool-grants/create";
import deleteChatToolGrant from "@/api/handlers/chat/tool-grants/delete";
import listChatToolGrants from "@/api/handlers/chat/tool-grants/list";
import cancelTurn from "@/api/handlers/chat/turns/cancel";
import { joinChatTurn, probeChatTurn } from "@/api/handlers/chat/turns/resume";
import updateThreadModel from "@/api/handlers/chat/update-thread-model";
import { permissionMacro, workspaceAccessMacro } from "@/api/lib/auth";

export const chatRoute = new Elysia({ prefix: "/chat" })
  .use(workspaceAccessMacro)
  .use(permissionMacro)
  // Kept deliberately: this guard is the type-level carrier of
  // `validateAuth` for Elysia's context composition. `permissions` is a
  // function-form macro (see "Known Elysia Gotchas" in AGENTS.md) that
  // applies `validateAuth` at runtime but not in type composition, so a
  // per-route `validateAuth: true` literal instead of this guard breaks
  // sibling macro context composition. The per-request memoization in
  // `resolveValidateAuth`
  // (lib/auth.ts) neutralizes the extra resolve this guard stacks on top
  // of `permissions`. See tests/security/route-auth-invariants.test.ts.
  .guard({ validateAuth: true })
  .get("/link-icons/exact", getExactIcon.handler, {
    query: getExactIcon.config.query,
    permissions: getExactIcon.config.permissions,
    accountAccess: getExactIcon.config.accountAccess,
  })
  .get("/link-icons/:hostname", getLinkIcon.handler, {
    params: getLinkIcon.config.params,
    permissions: getLinkIcon.config.permissions,
    accountAccess: getLinkIcon.config.accountAccess,
  })
  .post("/", sendMessage.handler, {
    body: sendMessage.config.body,
    permissions: sendMessage.config.permissions,
    accountAccess: sendMessage.config.accountAccess,
  })
  .post("/threads/:threadId/secrets/:toolCallId", submitSecret.handler, {
    body: submitSecret.config.body,
    params: submitSecret.config.params,
    permissions: submitSecret.config.permissions,
    accountAccess: submitSecret.config.accountAccess,
  })
  .get("/threads/:threadId/saved-secret", savedSecret.handler, {
    params: savedSecret.config.params,
    query: savedSecret.config.query,
    permissions: savedSecret.config.permissions,
    accountAccess: savedSecret.config.accountAccess,
  })
  .get("/tool-grants", listChatToolGrants.handler, {
    query: listChatToolGrants.config.query,
    permissions: listChatToolGrants.config.permissions,
    accountAccess: listChatToolGrants.config.accountAccess,
  })
  .get("/tool-grants/coverage", readChatToolGrantCoverage.handler, {
    query: readChatToolGrantCoverage.config.query,
    permissions: readChatToolGrantCoverage.config.permissions,
    accountAccess: readChatToolGrantCoverage.config.accountAccess,
  })
  .post("/tool-grants", createChatToolGrant.handler, {
    body: createChatToolGrant.config.body,
    permissions: createChatToolGrant.config.permissions,
    accountAccess: createChatToolGrant.config.accountAccess,
  })
  .delete("/tool-grants/:grantId", deleteChatToolGrant.handler, {
    params: deleteChatToolGrant.config.params,
    permissions: deleteChatToolGrant.config.permissions,
    accountAccess: deleteChatToolGrant.config.accountAccess,
  })
  .post("/workspaces/:workspaceId/file-thread", resolveFileThread.handler, {
    body: resolveFileThread.config.body,
    permissions: resolveFileThread.config.permissions,
    accountAccess: resolveFileThread.config.accountAccess,
    validateWorkspaceAccess: true,
  })
  .get("/workspaces/:workspaceId/file-thread", readFileThread.handler, {
    permissions: readFileThread.config.permissions,
    accountAccess: readFileThread.config.accountAccess,
    query: readFileThread.config.query,
    validateWorkspaceAccess: true,
  })
  .post("/template-thread", resolveTemplateThread.handler, {
    body: resolveTemplateThread.config.body,
    permissions: resolveTemplateThread.config.permissions,
    accountAccess: resolveTemplateThread.config.accountAccess,
  })
  .post("/template-thread/rotate", rotateTemplateThread.handler, {
    body: rotateTemplateThread.config.body,
    permissions: rotateTemplateThread.config.permissions,
    accountAccess: rotateTemplateThread.config.accountAccess,
  })
  .get("/threads", getThreads.handler, {
    permissions: getThreads.config.permissions,
    accountAccess: getThreads.config.accountAccess,
    query: getThreads.config.query,
  })
  .get("/decision-threads/:decisionId", getDecisionChatThread.handler, {
    params: getDecisionChatThread.config.params,
    permissions: getDecisionChatThread.config.permissions,
    accountAccess: getDecisionChatThread.config.accountAccess,
  })
  .get("/model-options", getModelOptions.handler, {
    permissions: getModelOptions.config.permissions,
    accountAccess: getModelOptions.config.accountAccess,
  })
  .get("/skill-availability", listUnavailableChatSkills.handler, {
    permissions: listUnavailableChatSkills.config.permissions,
    accountAccess: listUnavailableChatSkills.config.accountAccess,
    query: listUnavailableChatSkills.config.query,
  })
  .post("/table-chart", tableChart.handler, {
    body: tableChart.config.body,
    permissions: tableChart.config.permissions,
    accountAccess: tableChart.config.accountAccess,
  })
  .post("/improve-prompt", improvePrompt.handler, {
    body: improvePrompt.config.body,
    permissions: improvePrompt.config.permissions,
    accountAccess: improvePrompt.config.accountAccess,
    requiresUsage: improvePrompt.config.requiresUsage,
  })
  .delete("/threads/:threadId", deleteThread.handler, {
    params: deleteThread.config.params,
    permissions: deleteThread.config.permissions,
    accountAccess: deleteThread.config.accountAccess,
    query: deleteThread.config.query,
  })
  .patch("/threads/:threadId", updateThread.handler, {
    body: updateThread.config.body,
    params: updateThread.config.params,
    permissions: updateThread.config.permissions,
    accountAccess: updateThread.config.accountAccess,
    query: updateThread.config.query,
  })
  .patch("/threads/:threadId/model", updateThreadModel.handler, {
    body: updateThreadModel.config.body,
    params: updateThreadModel.config.params,
    permissions: updateThreadModel.config.permissions,
    accountAccess: updateThreadModel.config.accountAccess,
    query: updateThreadModel.config.query,
  })
  .patch("/threads/:threadId/title", renameThread.handler, {
    body: renameThread.config.body,
    params: renameThread.config.params,
    permissions: renameThread.config.permissions,
    accountAccess: renameThread.config.accountAccess,
    query: renameThread.config.query,
  })
  .get("/threads/:threadId/title", getThreadTitle.handler, {
    params: getThreadTitle.config.params,
    permissions: getThreadTitle.config.permissions,
    accountAccess: getThreadTitle.config.accountAccess,
    query: getThreadTitle.config.query,
  })
  .post("/threads/:threadId/title/suggest", suggestThreadTitle.handler, {
    params: suggestThreadTitle.config.params,
    permissions: suggestThreadTitle.config.permissions,
    accountAccess: suggestThreadTitle.config.accountAccess,
    query: suggestThreadTitle.config.query,
  })
  .get("/threads/:threadId/messages", getMessages.handler, {
    params: getMessages.config.params,
    permissions: getMessages.config.permissions,
    accountAccess: getMessages.config.accountAccess,
    query: getMessages.config.query,
  })
  .post(
    "/threads/:threadId/messages/:messageId/span-edit",
    proposeMessageSpanEdit.handler,
    {
      body: proposeMessageSpanEdit.config.body,
      params: proposeMessageSpanEdit.config.params,
      permissions: proposeMessageSpanEdit.config.permissions,
      accountAccess: proposeMessageSpanEdit.config.accountAccess,
    },
  )
  .get("/threads/:threadId/messages/:messageId", getMessage.handler, {
    params: getMessage.config.params,
    permissions: getMessage.config.permissions,
    accountAccess: getMessage.config.accountAccess,
  })
  .post(
    "/threads/:threadId/messages/:messageId/revisions",
    acceptMessageRevision.handler,
    {
      body: acceptMessageRevision.config.body,
      params: acceptMessageRevision.config.params,
      permissions: acceptMessageRevision.config.permissions,
      accountAccess: acceptMessageRevision.config.accountAccess,
    },
  )
  .post(
    "/threads/:threadId/messages/:messageId/revisions/:revision/revert",
    revertMessageRevision.handler,
    {
      body: revertMessageRevision.config.body,
      params: revertMessageRevision.config.params,
      permissions: revertMessageRevision.config.permissions,
      accountAccess: revertMessageRevision.config.accountAccess,
    },
  )
  .get(
    "/threads/:threadId/messages/:messageId/revisions",
    getMessageRevisions.handler,
    {
      params: getMessageRevisions.config.params,
      query: getMessageRevisions.config.query,
      permissions: getMessageRevisions.config.permissions,
      accountAccess: getMessageRevisions.config.accountAccess,
    },
  )
  .get("/threads/:threadId/messages/older", getOlderMessages.handler, {
    params: getOlderMessages.config.params,
    permissions: getOlderMessages.config.permissions,
    accountAccess: getOlderMessages.config.accountAccess,
    query: getOlderMessages.config.query,
  })
  .post("/threads/:threadId/recap", getThreadRecap.handler, {
    params: getThreadRecap.config.params,
    permissions: getThreadRecap.config.permissions,
    accountAccess: getThreadRecap.config.accountAccess,
    query: getThreadRecap.config.query,
  })
  .post("/threads/:threadId/suggested-prompts", getSuggestedPrompts.handler, {
    params: getSuggestedPrompts.config.params,
    permissions: getSuggestedPrompts.config.permissions,
    accountAccess: getSuggestedPrompts.config.accountAccess,
    query: getSuggestedPrompts.config.query,
  })
  .get("/threads/:threadId/turns/:turnId/resume", probeChatTurn.handler, {
    params: probeChatTurn.config.params,
    permissions: probeChatTurn.config.permissions,
    accountAccess: probeChatTurn.config.accountAccess,
    query: probeChatTurn.config.query,
  })
  .get("/threads/:threadId/turns/:turnId/join", joinChatTurn.handler, {
    params: joinChatTurn.config.params,
    permissions: joinChatTurn.config.permissions,
    accountAccess: joinChatTurn.config.accountAccess,
    query: joinChatTurn.config.query,
  })
  .post("/threads/:threadId/turns/:turnId/cancel", cancelTurn.handler, {
    params: cancelTurn.config.params,
    permissions: cancelTurn.config.permissions,
    accountAccess: cancelTurn.config.accountAccess,
  })
  .post("/threads/:threadId/fork", forkThread.handler, {
    body: forkThread.config.body,
    params: forkThread.config.params,
    permissions: forkThread.config.permissions,
    accountAccess: forkThread.config.accountAccess,
    query: forkThread.config.query,
  })
  .post("/threads/:threadId/export", createMessageExport.handler, {
    body: createMessageExport.config.body,
    params: createMessageExport.config.params,
    permissions: createMessageExport.config.permissions,
    accountAccess: createMessageExport.config.accountAccess,
    query: createMessageExport.config.query,
  });
