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
  .get(
    "/link-icons/:hostname",
    {
      params: getLinkIcon.config.params,
      permissions: getLinkIcon.config.permissions,
    },
    getLinkIcon.handler,
  )
  .post(
    "/",
    {
      body: sendMessage.config.body,
      permissions: sendMessage.config.permissions,
    },
    sendMessage.handler,
  )
  .post(
    "/threads/:threadId/secrets/:toolCallId",
    {
      body: submitSecret.config.body,
      params: submitSecret.config.params,
      permissions: submitSecret.config.permissions,
    },
    submitSecret.handler,
  )
  .get(
    "/threads/:threadId/saved-secret",
    {
      params: savedSecret.config.params,
      query: savedSecret.config.query,
      permissions: savedSecret.config.permissions,
    },
    savedSecret.handler,
  )
  .get(
    "/tool-grants",
    {
      query: listChatToolGrants.config.query,
      permissions: listChatToolGrants.config.permissions,
    },
    listChatToolGrants.handler,
  )
  .get(
    "/tool-grants/coverage",
    {
      query: readChatToolGrantCoverage.config.query,
      permissions: readChatToolGrantCoverage.config.permissions,
    },
    readChatToolGrantCoverage.handler,
  )
  .post(
    "/tool-grants",
    {
      body: createChatToolGrant.config.body,
      permissions: createChatToolGrant.config.permissions,
    },
    createChatToolGrant.handler,
  )
  .delete(
    "/tool-grants/:grantId",
    {
      params: deleteChatToolGrant.config.params,
      permissions: deleteChatToolGrant.config.permissions,
    },
    deleteChatToolGrant.handler,
  )
  .post(
    "/workspaces/:workspaceId/file-thread",
    {
      body: resolveFileThread.config.body,
      permissions: resolveFileThread.config.permissions,
      validateWorkspaceAccess: true,
    },
    resolveFileThread.handler,
  )
  .get(
    "/workspaces/:workspaceId/file-thread",
    {
      permissions: readFileThread.config.permissions,
      query: readFileThread.config.query,
      validateWorkspaceAccess: true,
    },
    readFileThread.handler,
  )
  .post(
    "/template-thread",
    {
      body: resolveTemplateThread.config.body,
      permissions: resolveTemplateThread.config.permissions,
    },
    resolveTemplateThread.handler,
  )
  .post(
    "/template-thread/rotate",
    {
      body: rotateTemplateThread.config.body,
      permissions: rotateTemplateThread.config.permissions,
    },
    rotateTemplateThread.handler,
  )
  .get(
    "/threads",
    {
      permissions: getThreads.config.permissions,
      query: getThreads.config.query,
    },
    getThreads.handler,
  )
  .get(
    "/decision-threads/:decisionId",
    {
      params: getDecisionChatThread.config.params,
      permissions: getDecisionChatThread.config.permissions,
    },
    getDecisionChatThread.handler,
  )
  .get(
    "/model-options",
    {
      permissions: getModelOptions.config.permissions,
    },
    getModelOptions.handler,
  )
  .get(
    "/skill-availability",
    {
      permissions: listUnavailableChatSkills.config.permissions,
      query: listUnavailableChatSkills.config.query,
    },
    listUnavailableChatSkills.handler,
  )
  .post(
    "/table-chart",
    {
      body: tableChart.config.body,
      permissions: tableChart.config.permissions,
    },
    tableChart.handler,
  )
  .post(
    "/improve-prompt",
    {
      body: improvePrompt.config.body,
      permissions: improvePrompt.config.permissions,
      requiresUsage: improvePrompt.config.requiresUsage,
    },
    improvePrompt.handler,
  )
  .delete(
    "/threads/:threadId",
    {
      params: deleteThread.config.params,
      permissions: deleteThread.config.permissions,
      query: deleteThread.config.query,
    },
    deleteThread.handler,
  )
  .patch(
    "/threads/:threadId",
    {
      body: updateThread.config.body,
      params: updateThread.config.params,
      permissions: updateThread.config.permissions,
      query: updateThread.config.query,
    },
    updateThread.handler,
  )
  .patch(
    "/threads/:threadId/model",
    {
      body: updateThreadModel.config.body,
      params: updateThreadModel.config.params,
      permissions: updateThreadModel.config.permissions,
      query: updateThreadModel.config.query,
    },
    updateThreadModel.handler,
  )
  .patch(
    "/threads/:threadId/title",
    {
      body: renameThread.config.body,
      params: renameThread.config.params,
      permissions: renameThread.config.permissions,
      query: renameThread.config.query,
    },
    renameThread.handler,
  )
  .get(
    "/threads/:threadId/title",
    {
      params: getThreadTitle.config.params,
      permissions: getThreadTitle.config.permissions,
      query: getThreadTitle.config.query,
    },
    getThreadTitle.handler,
  )
  .post(
    "/threads/:threadId/title/suggest",
    {
      params: suggestThreadTitle.config.params,
      permissions: suggestThreadTitle.config.permissions,
      query: suggestThreadTitle.config.query,
    },
    suggestThreadTitle.handler,
  )
  .get(
    "/threads/:threadId/messages",
    {
      params: getMessages.config.params,
      permissions: getMessages.config.permissions,
      query: getMessages.config.query,
    },
    getMessages.handler,
  )
  .post(
    "/threads/:threadId/messages/:messageId/span-edit",
    {
      body: proposeMessageSpanEdit.config.body,
      params: proposeMessageSpanEdit.config.params,
      permissions: proposeMessageSpanEdit.config.permissions,
    },
    proposeMessageSpanEdit.handler,
  )
  .get(
    "/threads/:threadId/messages/:messageId",
    {
      params: getMessage.config.params,
      permissions: getMessage.config.permissions,
    },
    getMessage.handler,
  )
  .post(
    "/threads/:threadId/messages/:messageId/revisions",
    {
      body: acceptMessageRevision.config.body,
      params: acceptMessageRevision.config.params,
      permissions: acceptMessageRevision.config.permissions,
    },
    acceptMessageRevision.handler,
  )
  .post(
    "/threads/:threadId/messages/:messageId/revisions/:revision/revert",
    {
      body: revertMessageRevision.config.body,
      params: revertMessageRevision.config.params,
      permissions: revertMessageRevision.config.permissions,
    },
    revertMessageRevision.handler,
  )
  .get(
    "/threads/:threadId/messages/:messageId/revisions",
    {
      params: getMessageRevisions.config.params,
      query: getMessageRevisions.config.query,
      permissions: getMessageRevisions.config.permissions,
    },
    getMessageRevisions.handler,
  )
  .get(
    "/threads/:threadId/messages/older",
    {
      params: getOlderMessages.config.params,
      permissions: getOlderMessages.config.permissions,
      query: getOlderMessages.config.query,
    },
    getOlderMessages.handler,
  )
  .post(
    "/threads/:threadId/recap",
    {
      params: getThreadRecap.config.params,
      permissions: getThreadRecap.config.permissions,
      query: getThreadRecap.config.query,
    },
    getThreadRecap.handler,
  )
  .post(
    "/threads/:threadId/suggested-prompts",
    {
      params: getSuggestedPrompts.config.params,
      permissions: getSuggestedPrompts.config.permissions,
      query: getSuggestedPrompts.config.query,
    },
    getSuggestedPrompts.handler,
  )
  .get(
    "/threads/:threadId/turns/:turnId/resume",
    {
      params: probeChatTurn.config.params,
      permissions: probeChatTurn.config.permissions,
      query: probeChatTurn.config.query,
    },
    probeChatTurn.handler,
  )
  .get(
    "/threads/:threadId/turns/:turnId/join",
    {
      params: joinChatTurn.config.params,
      permissions: joinChatTurn.config.permissions,
      query: joinChatTurn.config.query,
    },
    joinChatTurn.handler,
  )
  .post(
    "/threads/:threadId/turns/:turnId/cancel",
    {
      params: cancelTurn.config.params,
      permissions: cancelTurn.config.permissions,
    },
    cancelTurn.handler,
  )
  .post(
    "/threads/:threadId/fork",
    {
      body: forkThread.config.body,
      params: forkThread.config.params,
      permissions: forkThread.config.permissions,
      query: forkThread.config.query,
    },
    forkThread.handler,
  )
  .post(
    "/threads/:threadId/export",
    {
      body: createMessageExport.config.body,
      params: createMessageExport.config.params,
      permissions: createMessageExport.config.permissions,
      query: createMessageExport.config.query,
    },
    createMessageExport.handler,
  );
