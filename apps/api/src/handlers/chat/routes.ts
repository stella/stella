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
import submitConnector from "@/api/handlers/chat/submit-connector";
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
import { routes } from "@/api/http/route";

export const chatRoute = routes(
  {
    "/link-icons/exact": { GET: getExactIcon },
    "/link-icons/:hostname": { GET: getLinkIcon },
    "/": { POST: sendMessage },
    "/threads/:threadId/secrets/:toolCallId": { POST: submitSecret },
    "/threads/:threadId/connectors/:toolCallId": { POST: submitConnector },
    "/threads/:threadId/saved-secret": { GET: savedSecret },
    "/tool-grants": { GET: listChatToolGrants, POST: createChatToolGrant },
    "/tool-grants/coverage": { GET: readChatToolGrantCoverage },
    "/tool-grants/:grantId": { DELETE: deleteChatToolGrant },
    "/workspaces/:workspaceId/file-thread": {
      POST: resolveFileThread,
      GET: readFileThread,
    },
    "/template-thread": { POST: resolveTemplateThread },
    "/template-thread/rotate": { POST: rotateTemplateThread },
    "/threads": { GET: getThreads },
    "/decision-threads/:decisionId": { GET: getDecisionChatThread },
    "/model-options": { GET: getModelOptions },
    "/skill-availability": { GET: listUnavailableChatSkills },
    "/table-chart": { POST: tableChart },
    "/improve-prompt": { POST: improvePrompt },
    "/threads/:threadId": { DELETE: deleteThread, PATCH: updateThread },
    "/threads/:threadId/model": { PATCH: updateThreadModel },
    "/threads/:threadId/title": { PATCH: renameThread, GET: getThreadTitle },
    "/threads/:threadId/title/suggest": { POST: suggestThreadTitle },
    "/threads/:threadId/messages": { GET: getMessages },
    "/threads/:threadId/messages/:messageId/span-edit": {
      POST: proposeMessageSpanEdit,
    },
    "/threads/:threadId/messages/:messageId": { GET: getMessage },
    "/threads/:threadId/messages/:messageId/revisions": {
      POST: acceptMessageRevision,
      GET: getMessageRevisions,
    },
    "/threads/:threadId/messages/:messageId/revisions/:revision/revert": {
      POST: revertMessageRevision,
    },
    "/threads/:threadId/messages/older": { GET: getOlderMessages },
    "/threads/:threadId/recap": { POST: getThreadRecap },
    "/threads/:threadId/suggested-prompts": { POST: getSuggestedPrompts },
    "/threads/:threadId/turns/:turnId/resume": { GET: probeChatTurn },
    "/threads/:threadId/turns/:turnId/join": { GET: joinChatTurn },
    "/threads/:threadId/turns/:turnId/cancel": { POST: cancelTurn },
    "/threads/:threadId/fork": { POST: forkThread },
    "/threads/:threadId/export": { POST: createMessageExport },
  },
  { prefix: "/chat" },
);
